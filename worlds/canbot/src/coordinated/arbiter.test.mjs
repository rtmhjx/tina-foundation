import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ArbitrationJournal } from './journal.mjs';
import { PlaybackArbiter } from './arbiter.mjs';

const hash = 'a'.repeat(64), intent = () => ({ requestId: randomUUID(), payloadHash: hash });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, changes = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-arbiter-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new ArbitrationJournal(dir); await journal.init(); const calls = [];
  const state = { intentEnabled: true, mode: 'continuous', intentRevision: 7, connected: true,
    listening: 'active', sessionId: 'session-1', guardReleased: false, deviceStopConfirmed: false,
    finalTailPersisted: false, finalAcked: false };
  const listener = {
    snapshot: async () => { calls.push('snapshot'); return { ...state }; },
    pauseForPlayback: async value => { calls.push(['pause', value]); return { accepted: true }; },
    waitSettled: async value => { calls.push(['settled', value]); state.listening = 'idle'; state.guardReleased = true;
      return { sessionId: value.sessionId, settled: true, deviceStopConfirmed: true, guardReleased: true, finalTailPersisted: true,
        finalAcked: true, gap: false, tailBoundaryUnknown: true }; },
    resumeIfUnchanged: async value => { calls.push(['resume', value]);
      return { state: state.intentRevision === value.expectedIntentRevision && state.intentEnabled && ['continuous', 'press_stop'].includes(state.mode) && state.connected ? 'resumed' : 'not_resumed' }; },
    ...changes.listener,
  };
  const playback = { playOnce: async value => { calls.push(['play', value]); return { state: 'completed' }; }, ...changes.playback };
  let time = 100; const clock = () => time += 20;
  return { journal, state, calls, listener, playback, arbiter: new PlaybackArbiter({ listener, playback, journal, clock,
    limits: { snapshotMs: 100, pauseMs: 100, settleMs: 100, playbackMs: 100, resumeMs: 100 } }) };
}

test('pause, persist/ACK/settle/release, play, then atomic resume with honest gap metadata', async t => {
  const f = await fixture(t), request = intent(); const result = await f.arbiter.play(request);
  assert.equal(result.state, 'completed'); assert.equal(result.playbackState, 'completed'); assert.equal(result.resumeState, 'resumed');
  assert.equal(result.gap.tailBoundaryUnknown, true); assert.equal(result.gap.actualAcousticGapMs, null);
  assert.equal(result.gap.hardwareContinuityVerified, false); assert.equal(result.hardwareReleaseConfirmed, false);
  assert.deepEqual(f.calls.map(x => Array.isArray(x) ? x[0] : x), ['snapshot', 'pause', 'settled', 'play', 'snapshot', 'resume']);
  assert.equal(f.calls.at(-1)[1].expectedIntentRevision, 7); assert.equal((await f.journal.read(request.requestId)).state, 'completed');
  const count = f.calls.length; assert.equal((await f.arbiter.play(request)).state, 'completed'); assert.equal(f.calls.length, count);
  await assert.rejects(f.arbiter.play({ ...request, payloadHash: 'b'.repeat(64) }), /request_id_conflict/);
});

test('manual stop, config change, disconnect, or noncontinuous mode suppresses resume', async t => {
  for (const mutate of [s => { s.intentEnabled = false; s.intentRevision++; }, s => { s.mode = 'press_stop'; s.intentRevision++; },
    s => { s.connected = false; }, s => { s.mode = 'silence_stop'; }]) {
    const f = await fixture(t); f.playback.playOnce = async () => { mutate(f.state); return { state: 'completed' }; };
    const result = await f.arbiter.play(intent()); assert.equal(result.state, 'completed'); assert.equal(result.resumeState, 'intent_changed_or_offline');
    assert(!f.calls.some(x => Array.isArray(x) && x[0] === 'resume'));
  }
});

test('manual recording resumes after playback only when its original intent remains unchanged', async t => {
  const unchanged = await fixture(t); unchanged.state.mode = 'press_stop';
  const resumed = await unchanged.arbiter.play(intent());
  assert.equal(resumed.state, 'completed'); assert.equal(resumed.resumeState, 'resumed');
  assert.equal(resumed.gap.reason, 'playback_pause'); assert.equal(resumed.gap.hardwareContinuityVerified, false);

  for (const mutate of [s => { s.intentEnabled = false; s.intentRevision++; },
    s => { s.connected = false; }, s => { s.mode = 'continuous'; }]) {
    const changed = await fixture(t); changed.state.mode = 'press_stop';
    changed.playback.playOnce = async () => { mutate(changed.state); return { state: 'completed' }; };
    const result = await changed.arbiter.play(intent());
    assert.equal(result.resumeState, 'intent_changed_or_offline');
    assert(!changed.calls.some(x => Array.isArray(x) && x[0] === 'resume'));
  }
});

test('known capture gap, incomplete final chunk, or unreleased lock forbids playback', async t => {
  for (const problem of [{ gap: true }, { finalAcked: false }, { finalTailPersisted: false }, { guardReleased: false }, { settled: false }, { sessionId: 'other-session' }]) {
    const f = await fixture(t); f.listener.waitSettled = async () => ({ sessionId: 'session-1', settled: true, deviceStopConfirmed: true, guardReleased: true,
      finalTailPersisted: true, finalAcked: true, gap: false, tailBoundaryUnknown: false, ...problem });
    const result = await f.arbiter.play(intent()); assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'capture_settlement_unproven');
    assert(!f.calls.some(x => Array.isArray(x) && x[0] === 'play'));
  }
});

test('timeout or cancellation of a pause never plays or retries the unknown effect', async t => {
  for (const cancel of [false, true]) {
    const gate = deferred(), abort = new AbortController(), f = await fixture(t);
    f.listener.pauseForPlayback = async () => { f.calls.push('pause_pending'); return gate.promise; };
    const request = intent(), pending = f.arbiter.play({ ...request, signal: abort.signal });
    while (!f.calls.includes('pause_pending')) await new Promise(r => setTimeout(r, 1));
    if (cancel) abort.abort();
    const result = await pending; assert.equal(result.state, 'unknown'); assert.equal(result.playbackSent, false); assert.equal(result.paused, null);
    gate.resolve({ accepted: true }); await new Promise(r => setTimeout(r, 5));
    const count = f.calls.length; assert.equal((await f.arbiter.play(request)).state, 'unknown'); assert.equal(f.calls.length, count);
  }
});

test('uncertain playback or lost response never triggers capture restart or automatic replay', async t => {
  const pendingPlayback = deferred(), f = await fixture(t); let attempts = 0;
  f.playback.playOnce = async () => { attempts++; return pendingPlayback.promise; };
  const request = intent(), result = await f.arbiter.play(request);
  assert.equal(result.state, 'unknown'); assert.equal(result.phase, 'playback_requested'); assert.equal(result.playbackSent, null);
  pendingPlayback.resolve({ state: 'completed' }); await new Promise(r => setTimeout(r, 5));
  assert.equal(attempts, 1); assert(!f.calls.some(x => Array.isArray(x) && x[0] === 'resume'));
  assert.equal((await f.arbiter.play(request)).state, 'unknown'); assert.equal(attempts, 1);
  await assert.rejects(f.arbiter.play(intent()), /previous_arbitration_unsettled/);
});

test('a newer stop arriving between resume preflight and atomic CAS prevents resume', async t => {
  const f = await fixture(t); f.listener.resumeIfUnchanged = async args => { f.state.intentRevision++; f.state.intentEnabled = false;
    return { state: f.state.intentRevision === args.expectedIntentRevision ? 'resumed' : 'not_resumed' }; };
  const result = await f.arbiter.play(intent()); assert.equal(result.resumeState, 'not_resumed');
});

test('second in-process playback is refused while the first is in flight', async t => {
  const gate = deferred(), f = await fixture(t); f.playback.playOnce = () => gate.promise;
  const running = f.arbiter.play(intent()); while (!f.state.guardReleased) await new Promise(r => setTimeout(r, 1));
  const blocked = await f.arbiter.play(intent()); assert.equal(blocked.reason, 'arbiter_busy'); assert.equal(blocked.playbackSent, false);
  gate.resolve({ state: 'completed' }); assert.equal((await running).state, 'completed');
});

test('restart with an unfinished durable intent never repeats pause or playback', async t => {
  const f = await fixture(t), request = intent(); await f.journal.reserve(request.requestId, request.payloadHash);
  const other = new PlaybackArbiter({ listener: f.listener, playback: f.playback, journal: f.journal });
  assert.equal((await other.play(request)).reason, 'previous_outcome_unresolved'); assert.deepEqual(f.calls, []);
  await assert.rejects(other.play(intent()), /previous_arbitration_unsettled/);
});

test('idle capture still requires verified software stop, final tail, ACK and released shared lock', async t => {
  const f = await fixture(t); f.state.listening = 'idle'; f.state.guardReleased = false;
  const result = await f.arbiter.play(intent()); assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'idle_safety_unproven');
  assert(!f.calls.some(x => Array.isArray(x) && x[0] === 'play'));
});

test('verified not-started playback may resume only the unchanged continuous intent', async t => {
  const f = await fixture(t); f.playback.playOnce = async () => ({ state: 'not_started' });
  const result = await f.arbiter.play(intent()); assert.equal(result.playbackSent, false); assert.equal(result.resumeState, 'resumed');
});

test('unknown resume receipt preserves the latch and does not issue another start', async t => {
  const f = await fixture(t), request = intent(); let attempts = 0;
  f.listener.resumeIfUnchanged = async () => { attempts++; throw Error('lost response'); };
  const result = await f.arbiter.play(request); assert.equal(result.state, 'unknown'); assert.equal(result.phase, 'resume_requested');
  assert.equal(result.playbackSent, true); assert.equal(attempts, 1);
  assert.equal((await f.arbiter.play(request)).state, 'unknown'); assert.equal(attempts, 1);
  await assert.rejects(f.arbiter.play(intent()), /previous_arbitration_unsettled/);
});

test('another request ID is blocked by a durable unknown record even if its latch went missing', async t => {
  const f = await fixture(t), request = intent(); const { record } = await f.journal.reserve(request.requestId, request.payloadHash);
  await f.journal.write({ ...record, state: 'unknown', phase: 'playback_requested' });
  const { unlink } = await import('node:fs/promises'); await unlink(join(f.journal.folder, 'active.json'));
  await assert.rejects(f.arbiter.play(intent()), /previous_arbitration_unsettled/);
});

test('offline proven idle rejects before playback and clears arbitration gate', async t => {
  const f = await fixture(t); Object.assign(f.state, {connected:false,listening:'idle',sessionId:null,
    guardReleased:true,deviceStopConfirmed:true,finalTailPersisted:true,finalAcked:true});
  const first=await f.arbiter.play(intent()); assert.equal(first.state,'rejected');
  assert.equal(first.reason,'device_unavailable'); assert.equal(first.playbackSent,false);
  assert(!f.calls.some(x=>Array.isArray(x)&&x[0]==='play'));
  f.state.connected=true; const second=await f.arbiter.play(intent()); assert.equal(second.state,'completed');
});
