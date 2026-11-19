import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, chmod, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { HeadChannel } from '../head-channel.mjs';
import { ArbitrationJournal } from './journal.mjs';
import { PlaybackArbiter } from './arbiter.mjs';
import { installControllerListener } from './controller-listener.mjs';
import { MediaCoordinator } from './coordinator.mjs';
import { createAudioIpc, helperExecutor } from './audio-ipc.mjs';
import { guardedCapture } from './guarded-head.mjs';
import { withReleaseProof } from './guard-adapter.mjs';
import { StreamGuard } from '../voice/stream-guard.mjs';
import { ReconnectLatch } from './reconnect-latch.mjs';

test('real captureOnce entry is guarded before its single post and user stop prevents resume', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-integration-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const session = randomUUID(), instance = randomUUID(), calls = [];
  let operation, stopped = false, starts = 0;
  const head = { clock: Date.now, captureOnce: HeadChannel.prototype.captureOnce,
    async request(_channel, path, options = {}) {
      if (path === '/v1/status') return { schemaVersion: 'canbot.diagnostics.v2', foreground: true, instanceId: instance, lastSequence: 0, activeOperation: null,
        microphoneCapture: { supportsCue: true, minDurationMs: 3000, maxDurationMs: 10000, defaultDurationMs: 3000 } };
      if (path === '/v1/tone') { calls.push('post'); operation = options.body; return {}; }
      if (path === `/v1/operations/${operation?.operationId}`) return { operationId: operation.operationId, kind: 'tone', sequence: operation.sequence, settled: true, state: 'complete', result: {} };
      throw Error('unexpected');
    } };
  const finished = { streamId: session, deviceStopConfirmed: true, capture: { gap: false, tailBoundaryUnknown: true } };
  const engine = { head, state: 'running', sessionId: session, client: { operation: { instanceId: instance }, finished: true,
    spool: { finished: true, gap: false, ackedThrough: 0, finalState: { settled: true, finalSequence: 0 } },
    guard: { lock() {}, reserve() {}, settle() {}, child: { exitCode: 0, signalCode: null } }, status: () => finished },
    status() { return { state: this.state, sessionId: this.sessionId }; },
    async requestStop() { calls.push('stop'); this.state = 'stopped'; stopped = true; },
    async start() { starts++; this.state = 'running'; }, runner: Promise.resolve() };
  const controller = { engine, state: { config: { mode: 'continuous', silenceMs: 1500, batch: { strategy: 'duration_ms', threshold: 3000 } } }, queue: Promise.resolve(),
    status() { return engine.status(); }, async apply() { throw Error('unexpected_apply'); }, async onDeviceReconnect() { return {}; } };
  const listener = installControllerListener(controller), journal = new ArbitrationJournal(dir); await journal.init();
  const guardFactory = () => ({ async lock() { calls.push('lock'); }, async reserve() { calls.push('reserve'); }, async settle() { calls.push('settle'); },
    async waitReleased() { calls.push('released'); return true; }, releaseUnknown() {} });
  const coord = new MediaCoordinator({ listener, journal, head, guardFactory });
  const originalRequest = head.request;
  head.request = async (...args) => { if (args[1] === '/v1/tone') await controller.apply({ action: 'set_enabled', desiredEnabled: false, expectedSessionId: session }); return originalRequest(...args); };
  const result = await coord.capture('tone');
  assert.equal(result.arbitration.state, 'completed'); assert.equal(result.resultAvailable, true); assert(stopped);
  assert.deepEqual(calls, ['stop', 'lock', 'reserve', 'post', 'settle', 'released']); assert.equal(starts, 0);
});

test('failed or ambiguous post retains lockout and cannot trigger a second device operation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-integration-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new ArbitrationJournal(dir); await journal.init(); let exclusive = false, posts = 0;
  const listener = { async beginExclusive() { if (exclusive) throw Error('busy'); exclusive = true; }, async endExclusive() { exclusive = false; },
    async snapshot() { return { intentEnabled: false, mode: 'press_stop', intentRevision: 1, connected: true, listening: 'idle', sessionId: null,
      guardReleased: true, deviceStopConfirmed: true, finalTailPersisted: true, finalAcked: true }; },
    async pauseForPlayback() {}, async waitSettled() {}, async resumeIfUnchanged() {} };
  const coord = new MediaCoordinator({ listener, journal, audioExecutor: async () => { posts++; return { state: 'unknown' }; } });
  const result = await coord.audio({ sha256: 'a'.repeat(64), volume: 80 });
  assert.equal(result.arbitration.state, 'unknown'); assert.equal(exclusive, true);
  await assert.rejects(coord.audio({ sha256: 'a'.repeat(64), volume: 80 }), /busy/); assert.equal(posts, 1);
});

test('audio-play compatible child reaches one coordinator over private Unix IPC and runs helper once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-ipc-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = join(dir, 'helper'), source = join(dir, 'source.wav'), journal = new ArbitrationJournal(join(dir, 'journal'));
  await writeFile(helper, '#!/usr/bin/env node\nconst hash="a".repeat(64); process.stdout.write(JSON.stringify({outcome:"completed",settled:true,wavSha256:hash,frames:2,operationId:"fake",operation:{result:{wavSha256:hash,playbackComplete:true,expectedFrames:2,playbackHeadFrames:2}}}));\n'); await chmod(helper, 0o700);
  await writeFile(source, 'synthetic audio only'); await journal.init();
  let exclusive = false;
  const listener = { async beginExclusive() { if (exclusive) throw Error('busy'); exclusive = true; }, async endExclusive() { exclusive = false; },
    async snapshot() { return { intentEnabled: false, mode: 'press_stop', intentRevision: 1, connected: true, listening: 'idle', sessionId: null,
      guardReleased: true, deviceStopConfirmed: true, finalTailPersisted: true, finalAcked: true }; },
    async pauseForPlayback() {}, async waitSettled() {}, async resumeIfUnchanged() {} };
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const expectedHelperSha256 = createHash('sha256').update(await readFile(helper)).digest('hex');
  const coordinator = new MediaCoordinator({ listener, journal, audioExecutor: helperExecutor({ executable: helper, expectedHelperSha256, stateDir: dir, linkPath: source }) });
  const { server, path } = await createAudioIpc({ coordinator, folder: dir, allowedRoots: [dir] });
  try {
    const client = fileURLToPath(new URL('./audio-ipc-client.mjs', import.meta.url));
    const code = await new Promise((resolve, reject) => { const child = spawn(process.execPath, [client, '--file', source, '--volume', '80'],
      { env: { ...process.env, CANBOT_MEDIA_SOCKET: path }, stdio: 'ignore' }); child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0); assert.equal(exclusive, false); assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert(!(await readdir(dir)).some(name => name.startsWith('audio-') || name.startsWith('admission-')));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('an unexecutable helper is proven not started and does not leave media permanently locked', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-helper-exec-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = join(dir, 'helper'), source = join(dir, 'source.wav'), journal = new ArbitrationJournal(join(dir, 'journal'));
  await writeFile(helper, '#!/usr/bin/env node\nconst hash="a".repeat(64); process.stdout.write(JSON.stringify({outcome:"completed",settled:true,wavSha256:hash,frames:2,operationId:"fake",operation:{result:{wavSha256:hash,playbackComplete:true,expectedFrames:2,playbackHeadFrames:2}}}));\n');
  await chmod(helper, 0o600); await writeFile(source, 'synthetic'); await journal.init();
  let exclusive = false;
  const listener = { async beginExclusive() { if (exclusive) throw Error('busy'); exclusive = true; }, async endExclusive() { exclusive = false; },
    async snapshot() { return { intentEnabled: false, mode: 'press_stop', intentRevision: 1, connected: true, listening: 'idle', sessionId: null,
      guardReleased: true, deviceStopConfirmed: true, finalTailPersisted: true, finalAcked: true }; },
    async pauseForPlayback() {}, async waitSettled() {}, async resumeIfUnchanged() {} };
  const { readFile } = await import('node:fs/promises'); const { createHash } = await import('node:crypto');
  const helperSha = createHash('sha256').update(await readFile(helper)).digest('hex');
  const coordinator = new MediaCoordinator({ listener, journal, audioExecutor: helperExecutor({ executable: helper, expectedHelperSha256: helperSha, stateDir: dir, linkPath: source }) });
  const { server, path } = await createAudioIpc({ coordinator, folder: dir, allowedRoots: [dir] });
  const rpc = request => new Promise((resolve, reject) => { const s = connect(path); let text = '';
    s.on('connect', () => s.write(JSON.stringify(request) + '\n')); s.on('data', b => { text += b; }); s.on('error', reject);
    s.on('close', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); });
  try {
    const id = randomUUID(); const rejected = await rpc({ action: 'play', requestId: id, file: source, volume: 80 });
    assert.equal(rejected.outcome, 'rejected'); assert.equal(rejected.code, 'playback_not_started');
    assert.equal(exclusive, false); const prior = (await rpc({ action: 'receipt', requestId: id })).receipt;
    assert.equal(prior.state, 'completed'); assert.equal(prior.playbackState, 'not_started'); assert.equal(prior.playbackSent, false);
    assert.equal((await rpc({ action: 'play', requestId: id, file: source, volume: 80 })).outcome, 'unknown');
    await chmod(helper, 0o700);
    assert.equal((await rpc({ action: 'play', requestId: randomUUID(), file: source, volume: 80 })).outcome, 'completed');
    assert.equal(exclusive, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('an error reported after a helper spawned is still unknown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-helper-after-spawn-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = join(dir, 'helper'), source = join(dir, 'source.wav'); await writeFile(helper, 'fake'); await writeFile(source, 'fake audio');
  const { EventEmitter } = await import('node:events'); const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto'); const sha = p => createHash('sha256').update(p).digest('hex');
  const fakeSpawn = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => { child.emit('spawn'); const error = new Error('late failure'); error.code = 'EACCES'; child.emit('error', error); }); return child; };
  const run = helperExecutor({ executable: helper, expectedHelperSha256: sha(await readFile(helper)), stateDir: dir, linkPath: source, spawnImpl: fakeSpawn });
  assert.equal((await run({ path: source, sha256: sha(await readFile(source)), volume: 80 })).state, 'unknown');
});

test('IPC bounds paths and unknown timeout stays read-only under same request ID', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-ipc-safe-')), allowed = join(dir, 'allowed');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises'); await mkdir(allowed, { mode: 0o700 });
  const source = join(allowed, 'source.wav'), outside = join(dir, 'outside.wav');
  await writeFile(source, 'synthetic'); await writeFile(outside, 'outside');
  const journal = new ArbitrationJournal(join(dir, 'journal')); await journal.init(); let sends = 0, exclusive = false;
  const listener = { async beginExclusive() { if (exclusive) throw Error('busy'); exclusive = true; }, async endExclusive() { exclusive = false; },
    async snapshot() { return { intentEnabled: false, mode: 'press_stop', intentRevision: 1, connected: true, listening: 'idle', sessionId: null,
      guardReleased: true, deviceStopConfirmed: true, finalTailPersisted: true, finalAcked: true }; },
    async pauseForPlayback() {}, async waitSettled() {}, async resumeIfUnchanged() {} };
  const coordinator = new MediaCoordinator({ listener, journal, audioExecutor: async () => { sends++; return new Promise(() => {}); } });
  const { server, path } = await createAudioIpc({ coordinator, folder: dir, allowedRoots: [allowed], timeoutMs: 80, maxSnapshotBytes: 9 });
  const rpc = request => new Promise((resolve, reject) => {
    const socket = connect(path); let result = ''; socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', b => { result += b; }); socket.on('error', reject);
    socket.on('close', () => { try { resolve(result ? JSON.parse(result) : null); } catch (e) { reject(e); } });
  });
  try {
    const forbidden = randomUUID();
    assert.equal((await rpc({ action: 'play', requestId: forbidden, file: outside, volume: 50 })).code, 'audio_path_not_allowed'); assert.equal(sends, 0);
    const id = randomUUID(); assert.equal(await rpc({ action: 'play', requestId: id, file: source, volume: 50 }), null);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal((await rpc({ action: 'receipt', requestId: id })).receipt.state, 'unknown');
    assert.equal((await rpc({ action: 'play', requestId: id, file: source, volume: 50 })).outcome, 'unknown'); assert.equal(sends, 1);
    assert.equal((await rpc({ action: 'play', requestId: randomUUID(), file: source, volume: 50 })).code, 'snapshot_capacity_reached');
    assert.equal(sends, 1); assert.equal((await readdir(dir)).filter(n => n.startsWith('audio-')).length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('completed receipt rotation keeps compact durable anti-replay IDs and fails closed at capacity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-retired-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new ArbitrationJournal(dir, { maxReceipts: 2, maxRetired: 1 }); await journal.init();
  const hash = 'a'.repeat(64), ids = Array.from({ length: 4 }, () => randomUUID());
  for (const id of ids.slice(0, 3)) { const { record } = await journal.reserve(id, hash); await journal.write({ ...record, state: 'completed' }); await journal.clearActive(id); }
  const retired = await journal.retired(); assert.equal(retired.length, 1);
  const old = retired[0].requestId; assert.equal((await journal.read(old)).reason, 'receipt_retired_no_replay');
  assert.equal((await journal.reserve(old, hash)).created, false);
  await assert.rejects(journal.reserve(ids[3], hash), /retired_journal_capacity/);
});

test('uncertain reconnect latch survives process object recreation and cannot silently begin twice', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-reconnect-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new ReconnectLatch(dir); assert.equal(await first.pending(), null); await first.begin();
  const restarted = new ReconnectLatch(dir); assert.equal((await restarted.pending()).state, 'pending_outcome_unknown');
  await assert.rejects(restarted.begin(), { code: 'EEXIST' });
});

test('actual Python flock guard protects real HeadChannel one-shot and releases on verified receipt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-real-guard-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const instance = randomUUID(); let operation, posts = 0;
  const head = { clock: Date.now, captureOnce: HeadChannel.prototype.captureOnce,
    async request(_channel, path, options = {}) {
      if (path === '/v1/status') return { schemaVersion: 'canbot.diagnostics.v2', foreground: true, instanceId: instance, lastSequence: 0, activeOperation: null };
      if (path === '/v1/tone') { operation = options.body; posts++; return {}; }
      if (path === `/v1/operations/${operation?.operationId}`) return { operationId: operation.operationId, kind: 'tone', sequence: operation.sequence, settled: true, state: 'complete', result: {} };
      throw Error('unexpected');
    } };
  const result = await guardedCapture({ head, kind: 'tone', guardFactory: () => withReleaseProof(new StreamGuard({ stateDir: dir })) });
  assert.equal(result.state, 'completed'); assert.equal(result.guardReleased, true); assert.equal(posts, 1);
  const g = new StreamGuard({ stateDir: dir }); await g.lock(); g.releaseUnknown(); // flock is available after real child exit
});

test('explicit stop preempts an in-flight asynchronous resume', async () => {
  const oldId = randomUUID(), newId = randomUUID(), instance = randomUUID();
  const engine = { state: 'running', sessionId: oldId, head: { async request() { return { foreground: true, instanceId: instance, activeOperation: null }; } },
    client: { operation: { instanceId: instance } }, status() { return { state: this.state, sessionId: this.sessionId, microphone: 'unknown' }; },
    async requestStop() { this.state = 'stopped'; }, async start() { this.sessionId = newId; this.state = 'starting'; }, runner: Promise.resolve() };
  const controller = { engine, queue: Promise.resolve(), state: { config: { mode: 'continuous' } },
    status() { return engine.status(); }, async apply(action) { if (action.desiredEnabled === false) engine.state = 'stopping'; }, async onDeviceReconnect() {} };
  const listener = installControllerListener(controller); await listener.beginExclusive();
  const before = await listener.snapshot(); assert.equal((await listener.pauseForPlayback({ sessionId: oldId, intentRevision: before.intentRevision })).accepted, true);
  const pending = listener.resumeIfUnchanged({ expectedIntentRevision: before.intentRevision, previousSessionId: oldId });
  for (let i = 0; i < 100 && engine.sessionId !== newId; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(engine.state, 'starting');
  await controller.apply({ action: 'set_enabled', desiredEnabled: false, expectedSessionId: newId });
  assert.equal((await pending).state, 'not_resumed'); assert.equal(engine.state, 'stopping');
  await listener.endExclusive();
});

test('manual-mode intent survives playback, but a screen stop while paused prevents resume', async t => {
  const { VoiceController } = await import('../voice/voice-control.mjs');
  for (const stopWhilePaused of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'manual-playback-intent-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const instance = randomUUID(); let starts = 0;
    const engine = {
      state: 'idle', sessionId: null, client: null, runner: Promise.resolve(),
      head: { async request() { return { foreground: true, instanceId: instance, activeOperation: null }; } },
      status() { return { state: this.state, sessionId: this.sessionId,
        microphone: this.state === 'running' ? 'active' : 'idle', deviceStopConfirmed: this.state === 'stopped',
        capture: this.client?.status().capture }; },
      async start() {
        starts++; this.sessionId = randomUUID(); this.state = 'running';
        this.client = { operation: { instanceId: instance }, finished: true,
          spool: { finished: true, gap: false, ackedThrough: 1, finalState: { settled: true, finalSequence: 1 } },
          guard: { lock() {}, reserve() {}, settle() {}, child: { exitCode: 0, signalCode: null } },
          status: () => ({ deviceStopConfirmed: true, capture: { gap: false, tailBoundaryUnknown: true } }) };
      },
      async requestStop() { this.state = 'stopped'; },
    };
    const controller = await VoiceController.create({ engine, journalDir: dir });
    const listener = installControllerListener(controller);
    await controller.model({ action: 'configure', expectedConfigRevision: 1,
      config: { mode: 'press_stop', silenceMs: 1500, batch: { strategy: 'duration_ms', threshold: 3000 } } });
    await controller.model({ action: 'set_enabled', expectedConfigRevision: 2, desiredEnabled: true, expectedSessionId: null });
    const previousSessionId = engine.sessionId, journal = new ArbitrationJournal(join(dir, 'media'));
    await journal.init(); await listener.beginExclusive();
    const playback = { async playOnce() {
      assert.equal(controller.status().phase, 'paused_playback'); assert.equal(controller.status().enabled, true);
      if (stopWhilePaused) {
        const command = { requestId: randomUUID(), receiverInstance: randomUUID(), sequence: 1,
          action: 'set_enabled', expectedConfigRevision: 2, desiredEnabled: false, expectedSessionId: previousSessionId };
        const receipt = await controller.device(command, Buffer.from(JSON.stringify(command)));
        assert.equal(receipt.state, 'settled'); assert.equal(controller.status().enabled, false);
      }
      return { state: 'completed' };
    } };
    const arbiter = new PlaybackArbiter({ listener, playback, journal });
    const result = await arbiter.play({ requestId: randomUUID(), payloadHash: 'a'.repeat(64) });
    assert.equal(result.state, 'completed');
    assert.equal(result.resumeState, stopWhilePaused ? 'intent_changed_or_offline' : 'resumed');
    assert.equal(result.gap.tailBoundaryUnknown, true);
    assert.equal(starts, stopWhilePaused ? 1 : 2);
    if (!stopWhilePaused) assert.notEqual(engine.sessionId, previousSessionId);
    await listener.endExclusive();
  }
});

test('busy listener rejection is durable and subsequent screen request can start', async t => {
  const { VoiceController } = await import('../voice/voice-control.mjs');
  const dir=await mkdtemp(join(tmpdir(),'voice-busy-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  let state='idle', id=null, starts=0;
  const e={status:()=>({state,sessionId:id}),start:async()=>{starts++;state='running';id=randomUUID();},requestStop:async()=>{state='stopping';}};
  const c=await VoiceController.create({engine:e,journalDir:dir}), listener=installControllerListener(c), receiver=randomUUID();
  const command=seq=>({requestId:randomUUID(),receiverInstance:receiver,sequence:seq,action:'set_enabled',expectedConfigRevision:1,desiredEnabled:true,expectedSessionId:null});
  await listener.beginExclusive(); const first=command(1), result=await c.device(first,Buffer.from(JSON.stringify(first)));
  assert.equal(result.state,'rejected');assert.equal(result.code,'exclusive_media_busy');assert.equal(starts,0);
  assert.deepEqual(c.receipt(first.requestId),result);await listener.endExclusive();
  const next=command(2);assert.equal((await c.device(next,Buffer.from(JSON.stringify(next)))).state,'settled');assert.equal(starts,1);
});

test('coordinator releases exclusivity after proven idle offline rejection and later playback succeeds', async t => {
  const dir=await mkdtemp(join(tmpdir(),'voice-offline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const journal=new ArbitrationJournal(dir);await journal.init();let exclusive=false,connected=false,plays=0;
  const listener={beginExclusive:async()=>{if(exclusive)throw Error('exclusive_media_busy');exclusive=true;},endExclusive:async()=>{exclusive=false;},
    snapshot:async()=>({intentEnabled:false,mode:'silence_stop',intentRevision:0,connected,listening:'idle',sessionId:null,
      guardReleased:true,deviceStopConfirmed:true,finalTailPersisted:true,finalAcked:true}),
    pauseForPlayback:async()=>{throw Error('unexpected');},waitSettled:async()=>{throw Error('unexpected');},resumeIfUnchanged:async()=>{throw Error('unexpected');}};
  const coordinator=new MediaCoordinator({listener,journal,head:{},guardFactory:()=>{},audioExecutor:async()=>{}});
  const execute=async()=>{plays++;return {state:'completed',settled:true,guardReleased:true,value:{ok:true}};};
  const first=await coordinator.run('tone','{}',execute);assert.equal(first.arbitration.state,'rejected');assert.equal(first.arbitration.reason,'device_unavailable');
  assert.equal(exclusive,false);assert.equal(plays,0);connected=true;
  const second=await coordinator.run('tone','{}',execute);assert.equal(second.arbitration.state,'completed');assert.equal(plays,1);assert.equal(exclusive,false);
});

test('offline IPC returns durable rejected receipt and retains snapshot without playback', async t => {
  const dir=await mkdtemp(join(tmpdir(),'canbot-ipc-offline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,'source.wav');await writeFile(source,'synthetic');const journal=new ArbitrationJournal(join(dir,'journal'));await journal.init();
  let exclusive=false,plays=0;
  const listener={beginExclusive:async()=>{if(exclusive)throw Error('busy');exclusive=true;},endExclusive:async()=>{exclusive=false;},
    snapshot:async()=>({intentEnabled:false,mode:'silence_stop',intentRevision:0,connected:false,listening:'idle',sessionId:null,
      guardReleased:true,deviceStopConfirmed:true,finalTailPersisted:true,finalAcked:true}),
    pauseForPlayback:async()=>{},waitSettled:async()=>{},resumeIfUnchanged:async()=>{}};
  const coordinator=new MediaCoordinator({listener,journal,audioExecutor:async()=>{plays++;return {state:'unknown'};}});
  const {server,path}=await createAudioIpc({coordinator,folder:dir,allowedRoots:[dir]});
  const requestId=randomUUID();const result=await new Promise((resolve,reject)=>{const sock=connect(path);let text='';sock.on('connect',()=>sock.write(JSON.stringify({action:'play',requestId,file:source,volume:80})+'\n'));sock.on('data',b=>{text+=b;});sock.on('error',reject);sock.on('close',()=>resolve(JSON.parse(text)));});
  try {
    assert.equal(result.outcome,'rejected');assert.equal(result.code,'device_unavailable');assert.equal(result.cleanup,'retained_confirmed_rejected');
    assert.equal(plays,0);assert.equal(exclusive,false);assert.equal((await coordinator.receipt(requestId)).state,'rejected');
    assert((await readdir(dir)).some(x=>x.startsWith('audio-')));
  } finally {await new Promise(r=>server.close(r));}
});
