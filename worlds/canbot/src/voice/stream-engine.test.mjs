import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StreamEngine } from './stream-engine.mjs';

function wav() {
  const b = Buffer.alloc(32044); b.write('RIFF', 0); b.writeUInt32LE(b.length-8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24);
  b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(32000,40);
  for (let i=0;i<16000;i++) b.writeInt16LE(Math.round(8000*Math.sin(i*.2)),44+i*2); return b;
}

test('press-stop path records one stream, settles software, then delivers external transcript with boundary uncertainty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-engine-')), recording = wav(), instance = randomUUID(), events = [];
  const metadata = { sequence: 1, startFrame: 0, frameCount: 16000, sha256: createHash('sha256').update(recording).digest('hex'), bytes: recording.length, final: false };
  let streamId, ack = 0, stopped = false, posts = 0, settledGuard = false;
  const head = { async request(_port, path, options = {}) {
    if (path === '/v1/status') return { schemaVersion: 'canbot.diagnostics.v2', foreground: true, instanceId: instance, lastSequence: 0,
      activeOperation: null, microphoneCapture: { supportsStream: true } };
    if (path === '/v1/microphone-stream') { posts++; streamId = options.body.operationId; return {}; }
    if (path.endsWith('/ack')) { ack = options.body.throughSequence; return {}; }
    if (path.endsWith('/stop')) { stopped = true; return { settled: false }; }
    if (path.includes('/chunks/')) return { bytes: recording };
    if (path === `/v1/microphone-stream/${streamId}`) return { operationId: streamId, instanceId: instance, state: stopped ? 'complete' : 'recording',
      sampleRate: 16000, channels: 1, bitsPerSample: 16, chunks: ack ? [] : [metadata], lastAckSequence: ack,
      stopRequested: stopped, settled: stopped, tailState: stopped ? 'empty_read_unknown' : 'pending', tailBoundaryUnknown: stopped,
      finalProduced: false, finalEmpty: stopped, finalSequence: stopped ? 1 : null, gap: null, hardwareReleaseConfirmed: false };
    throw Error('unexpected');
  } };
  const guardFactory = () => ({ async reserve() {}, async settle() { settledGuard = true; }, releaseUnknown() {} });
  const engine = new StreamEngine({ head, stateDir: dir, spoolRoot: join(dir,'spool'), guardFactory,
    host: { pushEvent: async event => { events.push(event); return { cursor: events.length }; } }, stt: async () => '你好', sleep: ms => new Promise(r => setTimeout(r, Math.min(ms,5))) });
  try {
    await engine.start({ mode: 'press_stop', silenceMs: 1500, batch: { strategy: 'duration_ms', threshold: 60000 } });
    for (let i=0;i<100 && ack===0;i++) await new Promise(r => setTimeout(r,5));
    assert.equal(ack,1); await engine.requestStop(); await engine.runner;
    const status = engine.status(); assert.equal(status.state, 'stopped'); assert.equal(status.deviceStopConfirmed,true);
    assert.equal(status.hardwareReleaseConfirmed,false); assert.equal(status.deviceHardwareContinuityVerified,false);
    assert.equal(settledGuard,true); assert.equal(posts,1); assert.equal(events[0].origin,'external');
    assert.equal(events[0].meta.tailBoundaryUnknown,true); assert.equal(events[0].text,'你好');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('continuous device chunks archive ASR progress and deliver a pause observation through the real outbox', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-continuous-progress-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const voice = wav(), silence = Buffer.from(voice); silence.fill(0, 44);
  const chunks = [voice, silence, silence]; const instance = randomUUID(), events = [];
  const meta = chunks.map((bytes, index) => ({ sequence: index + 1, startFrame: index * 16000,
    frameCount: 16000, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), final: false }));
  let streamId, ack = 0, stopped = false, settledGuard = false;
  const head = { async request(_port, path, options = {}) {
    if (path === '/v1/status') return { schemaVersion: 'canbot.diagnostics.v2', foreground: true, instanceId: instance,
      lastSequence: 0, activeOperation: null, microphoneCapture: { supportsStream: true } };
    if (path === '/v1/microphone-stream') { streamId = options.body.operationId; return {}; }
    if (path.endsWith('/ack')) { ack = options.body.throughSequence; return {}; }
    if (path.endsWith('/stop')) { stopped = true; return {}; }
    if (path.includes('/chunks/')) return { bytes: chunks[Number(path.split('/').at(-1)) - 1] };
    if (path === `/v1/microphone-stream/${streamId}`) return { operationId: streamId, instanceId: instance,
      state: stopped ? 'complete' : 'recording', sampleRate: 16000, channels: 1, bitsPerSample: 16,
      chunks: meta.filter(item => item.sequence > ack), lastAckSequence: ack, stopRequested: stopped, settled: stopped,
      tailState: stopped ? 'empty_read_unknown' : 'pending', tailBoundaryUnknown: stopped,
      finalProduced: false, finalEmpty: stopped, finalSequence: stopped ? 3 : null, gap: null };
    throw Error('unexpected');
  } };
  const engine = new StreamEngine({ head, stateDir: dir, spoolRoot: join(dir, 'spool'),
    guardFactory: () => ({ async reserve() {}, async settle() { settledGuard = true; }, releaseUnknown() {} }),
    host: { pushEvent: async (event, options) => { events.push({ event, options }); return { cursor: events.length }; } },
    stt: async () => '你好机器人', sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))) });
  await engine.start({ mode: 'continuous', silenceMs: 1500, batch: { strategy: 'duration_ms', threshold: 60000 } });
  for (let i = 0; i < 200 && !events.some(x => x.event.meta?.boundary === 'pause_candidate'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const preview = events.find(x => x.event.type === 'canbot.speech.partial');
  const pause = events.find(x => x.event.meta?.boundary === 'pause_candidate');
  assert(preview && pause); assert.equal(preview.options.deliver, false); assert.equal(pause.options.trigger, 'flush');
  assert.match(pause.event.text, /^CANBOT_AUDIO_OBSERVATION /);
  const modelObservation = JSON.parse(pause.event.text.slice('CANBOT_AUDIO_OBSERVATION '.length));
  assert.equal(modelObservation.transcript, '你好机器人'); assert.equal(modelObservation.boundary, 'pause_candidate');
  assert.equal(modelObservation.speechRevision, pause.event.meta.speechRevision); assert.equal(pause.event.origin, 'external');
  assert.equal(preview.event.meta.streamId, pause.event.meta.streamId); assert.equal(pause.event.meta.observedQuietMs >= 1500, true);
  await engine.requestStop(); await engine.runner; assert.equal(engine.status().state, 'stopped'); assert(settledGuard);
});

test('stop preempts device startup before recording submission', async () => {
  let resolveStatus, posts = 0, reserves = 0;
  const status = new Promise(resolve => { resolveStatus = resolve; });
  const instance = randomUUID();
  const engine = new StreamEngine({ head: { request: async (_port, path) => {
    if (path === '/v1/status') return status;
    posts++; throw Error('unexpected');
  } }, host: { pushEvent: async () => ({ cursor: 1 }) }, stt: async () => '',
  stateDir: tmpdir(), spoolRoot: tmpdir(),
  guardFactory: () => ({ async reserve() { reserves++; }, async settle() {}, releaseUnknown() {} }) });
  const started = await engine.start({ mode: 'press_stop', silenceMs: 1500, batch: { strategy: 'duration_ms', threshold: 3000 } });
  assert.match(started.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(started.state, 'starting');
  await engine.requestStop();
  resolveStatus({ schemaVersion: 'canbot.diagnostics.v2', foreground: true, instanceId: instance,
    lastSequence: 0, activeOperation: null, microphoneCapture: { supportsStream: true } });
  await engine.runner;
  assert.equal(engine.status().state, 'idle'); assert.equal(posts, 0); assert.equal(reserves, 0);
  assert.equal(engine.status().hardwareReleaseConfirmed, false);
});

test('failed old device generation is quarantined and same engine can safely start on new generation', async t => {
  const dir=await mkdtemp(join(tmpdir(),'voice-generation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let instance=randomUUID(),online=true,stream=null,stopped=false,sequence=0,starts=0;
  const head={async request(_kind,path,options={}) {
    if(!online)throw Error('offline');
    if(path==='/v1/status')return {schemaVersion:'canbot.diagnostics.v2',foreground:true,instanceId:instance,lastSequence:sequence,activeOperation:null,microphoneCapture:{supportsStream:true}};
    if(path==='/v1/microphone-stream') {stream=options.body.operationId;sequence=options.body.sequence;stopped=false;starts++;return {};}
    if(path===`/v1/microphone-stream/${stream}/stop`){stopped=true;return {};}
    if(path===`/v1/microphone-stream/${stream}`)return {operationId:stream,instanceId:instance,state:stopped?'complete':'recording',
      sampleRate:16000,channels:1,bitsPerSample:16,chunks:[],lastAckSequence:0,settled:stopped,
      tailState:stopped?'empty':'pending',tailBoundaryUnknown:false,finalProduced:false,finalEmpty:stopped,finalSequence:null,gap:null};
    throw Error('unexpected');
  }};
  const engine=new StreamEngine({head,host:{pushEvent:async()=>({cursor:1})},stt:async()=>'',stateDir:join(dir,'state'),spoolRoot:join(dir,'spool'),sleep:ms=>new Promise(r=>setTimeout(r,Math.min(ms,5)))});
  const cfg={mode:'continuous',silenceMs:1500,batch:{strategy:'duration_ms',threshold:3000}};
  await engine.start(cfg);for(let i=0;i<200&&engine.state!=='running';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(engine.state,'running');const oldId=engine.sessionId,oldInstance=instance;
  online=false;await engine.runner;assert.equal(engine.state,'failed');
  // Same generation is never isolated, even if it reports idle.
  online=true;for(let i=0;i<50&&engine.client.guard.child.exitCode===null;i++)await new Promise(r=>setTimeout(r,5));
  const same=await engine.recoveryReady();assert.equal(same.safeToStart,false);assert.equal(engine.state,'failed');
  instance=randomUUID();assert.notEqual(instance,oldInstance);
  const fresh=await engine.recoveryReady();assert.equal(fresh.safeToStart,true);assert.equal(engine.state,'idle');
  assert.equal(engine.previousSession.status,'interrupted_unresolved');assert.equal(engine.previousSession.hardwareReleaseConfirmed,false);
  const files=await (await import('node:fs/promises')).readdir(join(dir,'state'));
  assert.ok(files.includes(`quarantine-${oldId}.json`));
  await engine.start(cfg);for(let i=0;i<200&&engine.state!=='running';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(starts,2);assert.notEqual(engine.sessionId,oldId);await engine.requestStop();await engine.runner;assert.equal(engine.state,'stopped');
});

test('real engine auto-silence settles before stale screen stop, which is rejected without occupying stop reserve', async t => {
  const { VoiceController }=await import('./voice-control.mjs');const dir=await mkdtemp(join(tmpdir(),'voice-auto-stop-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const sound=wav();sound.fill(0,44+16000);const instance=randomUUID(),meta={sequence:1,startFrame:0,frameCount:16000,sha256:createHash('sha256').update(sound).digest('hex'),bytes:sound.length,final:false};
  let stream,ack=0,stopped=false,stops=0;const head={async request(_kind,path,options={}){
    if(path==='/v1/status')return {schemaVersion:'canbot.diagnostics.v2',foreground:true,instanceId:instance,lastSequence:0,activeOperation:null,microphoneCapture:{supportsStream:true}};
    if(path==='/v1/microphone-stream'){stream=options.body.operationId;return {};}
    if(path.endsWith('/ack')){ack=options.body.throughSequence;return {};}
    if(path.endsWith('/stop')){stops++;stopped=true;return {};}
    if(path.includes('/chunks/'))return {bytes:sound};
    if(path===`/v1/microphone-stream/${stream}`)return {operationId:stream,instanceId:instance,state:stopped?'complete':'recording',sampleRate:16000,channels:1,bitsPerSample:16,
      chunks:ack?[]:[meta],lastAckSequence:ack,stopRequested:stopped,settled:stopped,tailState:stopped?'empty':'pending',tailBoundaryUnknown:false,
      finalProduced:false,finalEmpty:stopped,finalSequence:stopped?1:null,gap:null};
    throw Error('unexpected');
  }};
  const engine=new StreamEngine({head,host:{pushEvent:async()=>({cursor:1})},stt:async()=>'',stateDir:join(dir,'state'),spoolRoot:join(dir,'spool'),sleep:ms=>new Promise(r=>setTimeout(r,Math.min(ms,5)))});
  const c=await VoiceController.create({engine,journalDir:join(dir,'voice'),limits:{maxReceipts:1,maxRetired:1,maxPreflight:2}});
  const config={mode:'silence_stop',silenceMs:100,batch:{strategy:'duration_ms',threshold:3000}};
  await c.model({action:'configure',expectedConfigRevision:1,config});
  await c.model({action:'set_enabled',desiredEnabled:true,expectedSessionId:null,expectedConfigRevision:2});const oldId=c.status().sessionId;
  await engine.runner;assert.equal(engine.state,'stopped');assert.equal(stops,1);
  const a=randomUUID(),b=randomUUID();c.state.receipts[a]={requestId:a,sha256:'a'.repeat(64),state:'settled'};c.state.retiredReceipts[b]={sha256:'b'.repeat(64)};
  const req={requestId:randomUUID(),receiverInstance:randomUUID(),sequence:1,action:'set_enabled',expectedConfigRevision:2,desiredEnabled:false,expectedSessionId:oldId};
  const result=await c.device(req,Buffer.from(JSON.stringify(req)));assert.equal(result.state,'rejected');assert.equal(result.code,'session_already_stopped');
  assert.equal(c.state.stopReceipt,null);assert.equal(stops,1);assert.equal(c.receipt(req.requestId).sha256,result.sha256);
});
