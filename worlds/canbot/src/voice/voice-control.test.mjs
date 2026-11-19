import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VoiceController, voiceServer } from './voice-control.mjs';

function engine() {
  let current = { state: 'idle', sessionId: null, microphone: 'idle', deviceStopConfirmed: true, capture: { lastSequence: 0 } };
  return { status: () => ({ ...current }), start: async () => { current = { ...current, state: 'running', sessionId: randomUUID(), microphone: 'unknown' }; },
    requestStop: async () => { current = { ...current, state: 'stopping', stopRequested: true }; } };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'voice-controller-')), e = engine();
  return { dir, e, controller: await VoiceController.create({ engine: e, journalDir: dir }) };
}
const raw = v => Buffer.from(JSON.stringify(v));
const cmd = (instance, sequence, options = {}) => ({ requestId: randomUUID(), receiverInstance: instance, sequence,
  action: 'set_enabled', expectedConfigRevision: 1, desiredEnabled: true, expectedSessionId: null, ...options });

test('default off, persistent replay receipt, explicit session-matched stop', async () => {
  const { dir, e, controller: c } = await fixture();
  try {
    assert.equal(c.status().state, 'idle'); assert.equal(c.status().receiverLastSequence, 0);
    const instance = randomUUID(), start = cmd(instance, 1), r1 = await c.device(start, raw(start));
    assert.equal(r1.state, 'settled'); assert.equal(c.status().state, 'running');
    assert.deepEqual(await c.device(start, raw(start)), r1);
    const forged = { ...start, desiredEnabled: false }; await assert.rejects(c.device(forged, raw(forged)), /request_id_conflict/);
    const missing = cmd(instance, 2, { desiredEnabled: false, expectedSessionId: null });
    assert.equal((await c.device(missing, raw(missing))).code, 'expected_session_required');
    const id = c.status().sessionId, stop = cmd(instance, 3, { desiredEnabled: false, expectedSessionId: id, expectedConfigRevision: 999 });
    assert.equal((await c.device(stop, raw(stop))).state, 'settled'); assert.equal(c.status().state, 'stopping');
    const fresh = await VoiceController.create({ engine: e, journalDir: dir });
    assert.equal(fresh.receipt(start.requestId).state, 'settled'); assert.equal(fresh.status().receiverLastSequence, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('serialized configuration CAS and retired receiver protection', async () => {
  const { dir, controller: c } = await fixture();
  try {
    const instance = randomUUID(), cfg = { mode: 'silence_stop', silenceMs: 1500, batch: { strategy: 'characters', threshold: 10 } };
    const a = cmd(instance, 1, { action: 'configure', config: cfg }); delete a.desiredEnabled; delete a.expectedSessionId;
    const b = cmd(instance, 2, { action: 'configure', config: cfg }); delete b.desiredEnabled; delete b.expectedSessionId;
    const results = await Promise.all([c.device(a, raw(a)), c.device(b, raw(b))]);
    assert.equal(results[0].state, 'settled'); assert.equal(results[1].code, 'configuration_conflict');
    const newInstance = randomUUID(), newer = cmd(newInstance, 1, { expectedConfigRevision: 2 });
    assert.equal((await c.device(newer, raw(newer))).state, 'settled');
    const stale = cmd(instance, 3, { expectedConfigRevision: 2 }); assert.equal((await c.device(stale, raw(stale))).code, 'receiver_retired');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unknown engine outcome is never replayed and stop remains possible', async () => {
  const { dir, e, controller: c } = await fixture();
  try {
    const realStart = e.start; e.start = async options => { await realStart(options); throw Error('lost response'); };
    const instance = randomUUID(), start = cmd(instance, 1), first = await c.device(start, raw(start));
    assert.equal(first.state, 'pending_outcome_unknown'); assert.deepEqual(await c.device(start, raw(start)), first);
    const other = cmd(instance, 2); assert.equal((await c.device(other, raw(other))).code, 'previous_request_unsettled');
    const stop = cmd(instance, 3, { desiredEnabled: false, expectedSessionId: c.status().sessionId });
    assert.equal((await c.device(stop, raw(stop))).state, 'settled'); assert.equal(c.status().state, 'stopping');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTTP uses independent bearer, blocks browser origins, and exposes original receipt', async () => {
  const { dir, controller: c } = await fixture(), token = 'q'.repeat(48), server = voiceServer({ controller: c, token });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/v1/voice-status')).status, 401);
    assert.equal((await fetch(base + '/v1/voice-status', { headers: { authorization: `Bearer ${token}`, origin: 'http://evil' } })).status, 403);
    const instance = randomUUID(), request = cmd(instance, 1);
    const response = await fetch(base + '/v1/voice-control', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal((await response.json()).state, 'settled');
    const receipt = await fetch(`${base}/v1/voice-receipts/${request.requestId}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await receipt.json()).state, 'settled');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test('only continuous mode can autostart on reconnection after verified recovery', async () => {
  const { dir, e, controller: c } = await fixture();
  try {
    assert.equal((await c.onDeviceReconnect()).autoStart, 'disabled_for_mode');
    const configure = cmd(randomUUID(), 1, { action: 'configure', config: { mode: 'continuous', silenceMs: 1500, batch: { strategy: 'characters', threshold: 12 } } });
    delete configure.desiredEnabled; delete configure.expectedSessionId;
    await c.device(configure, raw(configure));
    assert.equal((await c.onDeviceReconnect()).autoStart, 'recovery_unknown');
    e.recoveryReady = async () => ({ safeToStart: false });
    assert.equal((await c.onDeviceReconnect()).autoStart, 'recovery_unknown');
    e.recoveryReady = async () => ({ safeToStart: true });
    assert.equal((await c.onDeviceReconnect()).autoStart, 'requested'); assert.equal(c.status().state, 'running');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('same-text error after engine effect is still unknown', async () => {
  const {dir,e,controller:c}=await fixture();
  try {
    const start=e.start;e.start=async opts=>{await start(opts);throw Error('exclusive_media_busy');};
    const req=cmd(randomUUID(),1);const r=await c.device(req,raw(req));
    assert.equal(r.state,'pending_outcome_unknown');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('full detailed and tombstone ledgers retain a dedicated durable stop slot', async () => {
  const dir=await mkdtemp(join(tmpdir(),'voice-capacity-'));let state='running',calls=0,id=randomUUID();
  const e={status:()=>({state,sessionId:id}),start:async()=>{},requestStop:async()=>{calls++;state='stopping';}};
  try {
    const c=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:1}});
    const prior=randomUUID(),retired=randomUUID(),receiver=randomUUID();
    c.state.receipts[prior]={requestId:prior,sha256:'a'.repeat(64),state:'settled'};
    c.state.retiredReceipts[retired]={sha256:'b'.repeat(64)};
    const stop=cmd(receiver,1,{desiredEnabled:false,expectedSessionId:id});
    const result=await c.device(stop,raw(stop));assert.equal(result.state,'settled');assert.equal(calls,1);
    assert.equal(c.status().receiptStorage.emergencyStopOccupied,true);assert.deepEqual(c.receipt(stop.requestId),result);
    assert.deepEqual(await c.device(stop,raw(stop)),result);assert.equal(calls,1);
    const restart=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:1}});
    assert.deepEqual(restart.receipt(stop.requestId),result);
    state='idle';id=null;await assert.rejects(restart.model({action:'set_enabled',desiredEnabled:true,expectedSessionId:null,expectedConfigRevision:1}),/receipt_capacity_reached/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('emergency stop unknown is retained, never compacted or submitted twice', async () => {
  const dir=await mkdtemp(join(tmpdir(),'voice-capacity-'));let state='running',calls=0;const id=randomUUID();
  const e={status:()=>({state,sessionId:id}),start:async()=>{},requestStop:async()=>{calls++;state='stopping';throw Error('lost');}};
  try {
    const c=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:1}}),prior=randomUUID(),retired=randomUUID();
    c.state.receipts[prior]={requestId:prior,sha256:'a'.repeat(64),state:'settled'};c.state.retiredReceipts[retired]={sha256:'b'.repeat(64)};
    const stop=cmd(randomUUID(),1,{desiredEnabled:false,expectedSessionId:id});const result=await c.device(stop,raw(stop));
    assert.equal(result.state,'pending_outcome_unknown');assert.deepEqual(await c.device(stop,raw(stop)),result);assert.equal(calls,1);
    const recovered=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:1}});
    assert.equal(recovered.receipt(stop.requestId).state,'pending_outcome_unknown');assert.equal(recovered.pendingUnknown(),true);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('terminal detailed receipts compact into persistent anti-replay tombstones', async () => {
  const dir=await mkdtemp(join(tmpdir(),'voice-capacity-'));let state='idle',id=null,calls=0;
  const e={status:()=>({state,sessionId:id}),start:async()=>{calls++;state='running';id=randomUUID();},requestStop:async()=>{state='stopping';}};
  try {
    const c=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:2}}),receiver=randomUUID();
    const first=cmd(receiver,1);assert.equal((await c.device(first,raw(first))).state,'settled');
    const second=cmd(receiver,2,{desiredEnabled:false,expectedSessionId:id});assert.equal((await c.device(second,raw(second))).state,'settled');
    assert.equal(c.receipt(first.requestId).state,'settled');assert.equal(c.receipt(first.requestId).compacted,true);
    assert.equal(c.receipt(first.requestId).sha256,(await import('node:crypto')).createHash('sha256').update(raw(first)).digest('hex'));
    assert.equal((await c.device(first,raw(first))).state,'settled');assert.equal(calls,1);
    const changed={...first,desiredEnabled:false};await assert.rejects(c.device(changed,raw(changed)),/request_id_conflict/);
    const recovered=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:2}});
    assert.equal(recovered.receipt(first.requestId).state,'settled');assert.equal(recovered.receipt(first.requestId).compacted,true);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('invalid stop envelopes cannot occupy emergency slot when all ledgers are full', async () => {
  const dir=await mkdtemp(join(tmpdir(),'voice-capacity-'));const receiver=randomUUID(),oldReceiver=randomUUID(),id=randomUUID();let calls=0;
  const e={status:()=>({state:'running',sessionId:id}),start:async()=>{},requestStop:async()=>{calls++;}};
  try {
    const c=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:1}}),prior=randomUUID(),retired=randomUUID();
    c.state.currentReceiver=receiver;c.state.sequence=5;c.state.retiredReceivers=[oldReceiver];
    c.state.receipts[prior]={requestId:prior,sha256:'a'.repeat(64),state:'settled'};c.state.retiredReceipts[retired]={sha256:'b'.repeat(64)};
    const stale=cmd(receiver,5,{desiredEnabled:false,expectedSessionId:id});const old=cmd(oldReceiver,9,{desiredEnabled:false,expectedSessionId:id});
    const wrong=cmd(receiver,6,{desiredEnabled:false,expectedSessionId:randomUUID()});
    assert.equal((await c.device(stale,raw(stale))).code,'sequence_retired');assert.equal((await c.device(old,raw(old))).code,'receiver_retired');
    assert.equal((await c.device(wrong,raw(wrong))).code,'session_conflict');
    assert.equal(c.receipt(stale.requestId).code,'sequence_retired');assert.equal(c.receipt(old.requestId).code,'receiver_retired');
    assert.deepEqual(await c.device(stale,raw(stale)),c.receipt(stale.requestId));assert.equal(c.state.stopReceipt,null);assert.equal(calls,0);
    const valid=cmd(receiver,6,{desiredEnabled:false,expectedSessionId:id});assert.equal((await c.device(valid,raw(valid))).state,'settled');
    assert.equal(calls,1);assert.deepEqual(await c.device(valid,raw(valid)),c.receipt(valid.requestId));assert.equal(calls,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('occupied stop reserve prevents starting even when normal receipt ledger has room', async () => {
  const dir=await mkdtemp(join(tmpdir(),'voice-capacity-'));let calls=0;const e={status:()=>({state:'idle',sessionId:null}),start:async()=>{calls++;},requestStop:async()=>{}};
  try {
    const c=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:2,maxRetired:1}}),old=randomUUID(),retired=randomUUID();
    c.state.stopReceipt={requestId:old,sha256:'a'.repeat(64),state:'settled'};c.state.retiredReceipts[retired]={sha256:'b'.repeat(64)};
    const req=cmd(randomUUID(),1);const result=await c.device(req,raw(req));assert.equal(result.state,'rejected');assert.equal(result.code,'receipt_capacity_reached');
    assert.equal(calls,0);await assert.rejects(c.model({action:'set_enabled',desiredEnabled:true,expectedSessionId:null,expectedConfigRevision:1}),/receipt_capacity_reached/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('compacted rejected receipt remains verifiable by screen SHA and rejection code', async () => {
  const dir=await mkdtemp(join(tmpdir(),'voice-receipt-'));const e=engine();
  try {
    const c=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:2,maxPreflight:1}}),receiver=randomUUID();
    const rejected=cmd(receiver,1,{desiredEnabled:false,expectedSessionId:null});const r=await c.device(rejected,raw(rejected));
    assert.equal(r.state,'rejected');assert.equal(r.code,'expected_session_required');
    const start=cmd(receiver,2);assert.equal((await c.device(start,raw(start))).state,'settled');
    const compacted=c.receipt(rejected.requestId);assert.equal(compacted.sha256,r.sha256);assert.equal(compacted.state,'rejected');
    assert.equal(compacted.code,'expected_session_required');assert.equal(compacted.compacted,true);
    assert.equal((await c.device(rejected,raw(rejected))).sha256,r.sha256);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('stop arriving after automatic completion is a durable no-effect rejection and does not occupy stop slot', async () => {
  const dir=await mkdtemp(join(tmpdir(),'voice-autostop-'));const id=randomUUID(),receiver=randomUUID();
  const e={status:()=>({state:'stopped',sessionId:id}),start:async()=>{},requestStop:async()=>{throw Error('must_not_call');}};
  try {
    const c=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:1,maxPreflight:2}}),a=randomUUID(),b=randomUUID();
    c.state.receipts[a]={requestId:a,sha256:'a'.repeat(64),state:'settled'};c.state.retiredReceipts[b]={sha256:'b'.repeat(64)};
    const stop=cmd(receiver,1,{desiredEnabled:false,expectedSessionId:id});const r=await c.device(stop,raw(stop));
    assert.equal(r.state,'rejected');assert.equal(r.code,'session_already_stopped');assert.equal(c.state.stopReceipt,null);
    assert.equal(c.receipt(stop.requestId).sha256,r.sha256);assert.deepEqual(await c.device(stop,raw(stop)),r);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('full bounded preflight ledger reports limited recovery but preserves emergency stop', async () => {
  const dir=await mkdtemp(join(tmpdir(),'voice-preflight-capacity-')),receiver=randomUUID(),id=randomUUID();let stops=0;
  const e={status:()=>({state:'running',sessionId:id}),start:async()=>{},requestStop:async()=>{stops++;}};
  try {
    const c=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:1,maxPreflight:1}});
    const a=randomUUID(),b=randomUUID(),x=randomUUID();c.state.currentReceiver=receiver;c.state.sequence=5;
    c.state.receipts[a]={requestId:a,sha256:'a'.repeat(64),state:'settled'};c.state.retiredReceipts[b]={sha256:'b'.repeat(64)};
    c.state.preflightRejections[x]={requestId:x,sha256:'c'.repeat(64),state:'rejected',code:'sequence_retired'};
    assert.equal(c.status().receiptStorage.preflightFull,true);assert.equal(c.status().receiptStorage.preflightNearCapacity,true);
    const invalid=cmd(receiver,5,{desiredEnabled:false,expectedSessionId:id});const rejected=await c.device(invalid,raw(invalid));
    assert.equal(rejected.receiptPersisted,false);assert.equal(c.receipt(invalid.requestId),null);assert.equal(c.state.stopReceipt,null);
    const stop=cmd(receiver,6,{desiredEnabled:false,expectedSessionId:id});assert.equal((await c.device(stop,raw(stop))).state,'settled');assert.equal(stops,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('at receiver generation capacity a new authenticated receiver can stop the exact active session without reviving retired identity', async () => {
  const dir=await mkdtemp(join(tmpdir(),'voice-receiver-capacity-')),id=randomUUID(),current=randomUUID();let stops=0;
  const e={status:()=>({state:'running',sessionId:id}),start:async()=>{},requestStop:async()=>{stops++;}};
  try {
    const c=await VoiceController.create({engine:e,journalDir:dir,limits:{maxReceipts:1,maxRetired:1}});
    const a=randomUUID(),b=randomUUID();c.state.currentReceiver=current;c.state.sequence=8;c.state.retiredReceivers=Array.from({length:64},()=>randomUUID());
    c.state.receipts[a]={requestId:a,sha256:'a'.repeat(64),state:'settled'};c.state.retiredReceipts[b]={sha256:'b'.repeat(64)};
    const retiredStop=cmd(c.state.retiredReceivers[0],9,{desiredEnabled:false,expectedSessionId:id});
    assert.equal((await c.device(retiredStop,raw(retiredStop))).code,'receiver_retired');assert.equal(stops,0);
    const fresh=cmd(randomUUID(),1,{desiredEnabled:false,expectedSessionId:id});const result=await c.device(fresh,raw(fresh));
    assert.equal(result.state,'settled');assert.equal(stops,1);assert.equal(c.state.currentReceiver,current);assert.equal(c.state.sequence,8);
    assert.deepEqual(await c.device(fresh,raw(fresh)),result);assert.equal(stops,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});
