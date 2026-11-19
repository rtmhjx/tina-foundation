import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoordinatedCanbotWorld } from './integrated-world.mjs';
import { CANBOT_DEFAULTS } from '../config.mjs';
import { VoiceController } from '../voice/voice-control.mjs';

test('voice credential is resolved only at start and cannot reuse media credential', async () => {
  const cfg = { ...CANBOT_DEFAULTS, headEnabled: true, apiBaseUrl: 'http://127.0.0.1:1', mediaBaseUrl: 'http://127.0.0.1:1',
    avatarBaseUrl: 'http://127.0.0.1:1', headUplinkBind: '127.0.0.1', headUplinkPort: 0 };
  let reads = 0, started = 0; const shared = 'a'.repeat(64);
  const world = new CoordinatedCanbotWorld({ cfg, token: () => '', mediaToken: () => shared, avatarToken: () => 'b'.repeat(64),
    voice: { token: () => { reads++; return shared; }, stateDir: '/tmp/g', spoolRoot: '/tmp/s', journalDir: '/tmp/j' },
    media: { journalDir: '/tmp/m', ipcDir: '/tmp/i', allowedRoots: ['/tmp'], helper: '/bin/true', helperSha256: 'a'.repeat(64), linkPath: '/tmp/l' } });
  world.head.start = async () => { started++; }; world.tools(); assert.equal(reads, 0);
  await assert.rejects(world.start({}), /voice_token_invalid_or_reused/); assert.equal(reads, 1); assert.equal(started, 0);
});

test('coordinated world mounts real tools; failed reconnect stays observable and polling continues', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-coordinated-world-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const ipc = join(dir, 'ipc'); await mkdir(ipc, { mode: 0o700 });
  const cfg = { ...CANBOT_DEFAULTS, headEnabled: true, apiBaseUrl: 'http://127.0.0.1:1', mediaBaseUrl: 'http://127.0.0.1:1',
    avatarBaseUrl: 'http://127.0.0.1:1', headUplinkBind: '127.0.0.1', headUplinkPort: 0 };
  const world = new CoordinatedCanbotWorld({ cfg, token: () => '', mediaToken: () => 'a'.repeat(64), avatarToken: () => 'a'.repeat(64),
    voice: { token: 'v'.repeat(64), port: 0, pollMs: 20, stateDir: join(dir, 'guard'), spoolRoot: join(dir, 'spool'), journalDir: join(dir, 'voice'), stt: async () => '' },
    media: { journalDir: join(dir, 'media'), ipcDir: ipc, allowedRoots: [dir], helper: '/bin/true', helperSha256: 'a'.repeat(64), linkPath: join(dir, 'link.json') } });
  const instance = randomUUID(); let operation, posts = 0, online = true, attempts = 0, warnings = 0;
  world.head.start = async () => {}; world.head.stop = async () => {}; world.client.request = async () => { throw Error('offline'); };
  world.head.request = async (_channel, path, options = {}) => {
    if (path === '/v1/status') return { schemaVersion: 'canbot.diagnostics.v2', foreground: online, instanceId: instance, lastSequence: 0, activeOperation: null,
      microphoneCapture: { supportsStream: true } };
    if (path === '/v1/tone') { operation = options.body; posts++; return {}; }
    if (path === `/v1/operations/${operation?.operationId}`) return { operationId: operation.operationId, kind: 'tone', sequence: operation.sequence, settled: true, state: 'complete', result: {} };
    throw Error('unexpected');
  };
  const original = VoiceController.prototype.onDeviceReconnect;
  VoiceController.prototype.onDeviceReconnect = async () => { attempts++; throw Error('synthetic'); };
  t.after(() => { VoiceController.prototype.onDeviceReconnect = original; });
  const host = { pushEvent: async e => ({ ...e, cursor: 1 }), log: { warn() { warnings++; } } };
  try {
    await world.start(host); assert.equal(attempts, 1); assert.equal(world.voiceReconnectError, 'voice_reconnect_outcome_unknown');
    const status = JSON.parse((await world.tools().find(x => x.name === 'canbot_voice_control').handler({ action: 'status' })).text);
    assert.equal(status.reconnectError, 'voice_reconnect_outcome_unknown');
    const result = await world.tools().find(x => x.name === 'canbot_tone').handler({}, {});
    assert.equal(result.failed, undefined); assert.equal(posts, 1);
    await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(attempts, 1);
    online = false; await new Promise(resolve => setTimeout(resolve, 60)); online = true; await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(attempts, 1); assert.equal(warnings, 2);
  } finally { await world.stop(); }
});

test('actual stream engine pauses and resumes around a real World tone tool over fake device', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-world-duplex-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const ipc = join(dir, 'ipc'); await mkdir(ipc, { mode: 0o700 });
  const cfg = { ...CANBOT_DEFAULTS, headEnabled: true, apiBaseUrl: 'http://127.0.0.1:1', mediaBaseUrl: 'http://127.0.0.1:1',
    avatarBaseUrl: 'http://127.0.0.1:1', headUplinkBind: '127.0.0.1', headUplinkPort: 0 };
  const world = new CoordinatedCanbotWorld({ cfg, token: () => '', mediaToken: () => 'a'.repeat(64), avatarToken: () => 'a'.repeat(64),
    voice: { token: () => 'v'.repeat(64), port: 0, pollMs: 1000, stateDir: join(dir, 'guard'), spoolRoot: join(dir, 'spool'), journalDir: join(dir, 'voice'), stt: async () => '' },
    media: { journalDir: join(dir, 'media'), ipcDir: ipc, allowedRoots: [dir], helper: '/bin/true', helperSha256: 'a'.repeat(64), linkPath: join(dir, 'link.json') } });
  const instance = randomUUID(); let active = null, streamId = null, tone = null, stops = 0, starts = 0, seq = 0;
  world.head.start = async () => {}; world.head.stop = async () => {}; world.client.request = async () => { throw Error('offline'); };
  world.head.request = async (_channel, path, options = {}) => {
    if (path === '/v1/status') return { schemaVersion: 'canbot.diagnostics.v2', foreground: true, instanceId: instance, lastSequence: seq, activeOperation: active,
      microphoneCapture: { supportsStream: true } };
    if (path === '/v1/microphone-stream') { streamId = options.body.operationId; seq = options.body.sequence; active = 'stream'; starts++; return {}; }
    if (path === `/v1/microphone-stream/${streamId}/stop`) { active = null; stops++; return {}; }
    if (path === `/v1/microphone-stream/${streamId}`) return { operationId: streamId, instanceId: instance, state: active ? 'recording' : 'complete',
      sampleRate: 16000, channels: 1, bitsPerSample: 16, chunks: [], lastAckSequence: 0, settled: !active,
      tailState: active ? 'pending' : 'empty_read_unknown', tailBoundaryUnknown: !active, finalProduced: false, finalEmpty: !active, finalSequence: null, gap: null };
    if (path === '/v1/tone') { tone = options.body; seq = tone.sequence; return {}; }
    if (path === `/v1/operations/${tone?.operationId}`) return { operationId: tone.operationId, kind: 'tone', sequence: tone.sequence, settled: true, state: 'complete', result: {} };
    throw Error('unexpected');
  };
  const host = { pushEvent: async e => ({ ...e, cursor: 1 }), log: { warn() {} } };
  try {
    await world.start(host); const ctl = world.voiceBridge.controller;
    await ctl.model({ action: 'configure', expectedConfigRevision: ctl.status().configRevision,
      config: { mode: 'continuous', silenceMs: 1500, batch: { strategy: 'duration_ms', threshold: 3000 } } });
    for (let i = 0; i < 100 && world.voiceBridge.engine.state !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(starts, 1); assert.equal(world.voiceBridge.engine.state, 'running');
    const result = await world.tools().find(x => x.name === 'canbot_tone').handler({}, {});
    assert.equal(result.failed, undefined); assert.equal(stops, 1);
    for (let i = 0; i < 100 && (starts < 2 || world.voiceBridge.engine.state !== 'running'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(starts, 2); assert.equal(ctl.status().enabled, true);
    await ctl.model({ action: 'set_enabled', expectedConfigRevision: ctl.status().configRevision, desiredEnabled: false, expectedSessionId: ctl.status().sessionId });
    await world.voiceBridge.engine.runner;
  } finally { await world.stop(); }
});

test('World reports offline as definite rejection then allows later tone on recovered device', async t => {
  const dir=await mkdtemp(join(tmpdir(),'voice-world-offline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const ipc=join(dir,'ipc');await mkdir(ipc,{mode:0o700});const cfg={...CANBOT_DEFAULTS,headEnabled:true,
    apiBaseUrl:'http://127.0.0.1:1',mediaBaseUrl:'http://127.0.0.1:1',avatarBaseUrl:'http://127.0.0.1:1',headUplinkBind:'127.0.0.1',headUplinkPort:0};
  const world=new CoordinatedCanbotWorld({cfg,token:()=>'',avatarToken:()=> 'a'.repeat(64),mediaToken:()=> 'a'.repeat(64),
    voice:{token:()=> 'v'.repeat(64),port:0,pollMs:1000,stateDir:join(dir,'state'),spoolRoot:join(dir,'spool'),journalDir:join(dir,'voice'),stt:async()=>''},
    media:{journalDir:join(dir,'media'),ipcDir:ipc,allowedRoots:[dir],helper:'/bin/true',helperSha256:'a'.repeat(64),linkPath:join(dir,'link')}});
  let online=false,op,posts=0;const instance=randomUUID();world.head.start=async()=>{};world.head.stop=async()=>{};world.client.request=async()=>{throw Error('offline');};
  world.head.request=async(_kind,path,options={})=>{
    if(path==='/v1/status')return {schemaVersion:'canbot.diagnostics.v2',foreground:online,instanceId:instance,lastSequence:0,activeOperation:null,microphoneCapture:{supportsStream:true}};
    if(path==='/v1/tone'){posts++;op=options.body;return {};}
    if(path===`/v1/operations/${op?.operationId}`)return {operationId:op.operationId,kind:'tone',sequence:op.sequence,settled:true,state:'complete',result:{}};
    throw Error('unexpected');
  };
  try {
    await world.start({pushEvent:async e=>({...e,cursor:1}),log:{warn(){}}});const tone=world.tools().find(x=>x.name==='canbot_tone');
    const rejected=await tone.handler({},{});assert.equal(rejected.failed,true);const body=JSON.parse(rejected.text);
    assert.equal(body.code,'device_unavailable');assert.equal(body.outcome,'rejected');assert.equal(posts,0);
    online=true;const next=await tone.handler({},{});assert.equal(next.failed,undefined);assert.equal(posts,1);
  } finally {await world.stop();}
});
