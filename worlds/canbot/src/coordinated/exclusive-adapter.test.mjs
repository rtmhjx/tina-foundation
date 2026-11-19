import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ArbitrationJournal } from './journal.mjs';
import { ExclusiveMediaAdapter } from './exclusive-adapter.mjs';

async function fixture(t, executeOnce) {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-exclusive-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new ArbitrationJournal(dir); await journal.init(); const calls = [];
  const state = { intentEnabled: true, mode: 'continuous', intentRevision: 4, connected: true, listening: 'active', sessionId: 's1' };
  const listener = {
    snapshot: async () => ({ ...state }),
    pauseForPlayback: async () => { calls.push('pause'); return { accepted: true }; },
    waitSettled: async () => { calls.push('tail_ack_release'); state.listening = 'idle'; return { sessionId: 's1', settled: true,
      deviceStopConfirmed: true, guardReleased: true, finalTailPersisted: true, finalAcked: true, gap: false, tailBoundaryUnknown: true }; },
    resumeIfUnchanged: async ({ expectedIntentRevision }) => { calls.push('resume'); return { state: state.intentEnabled && state.intentRevision === expectedIntentRevision ? 'resumed' : 'not_resumed' }; },
  };
  return { state, calls, adapter: new ExclusiveMediaAdapter({ listener, journal, executeOnce: args => executeOnce(args, state, calls),
    limits: { snapshotMs: 100, pauseMs: 100, settleMs: 100, playbackMs: 100, resumeMs: 100 } }) };
}

test('single microphone with cue stays one exclusive operation and preserves the original media result', async t => {
  const value = { receipt: { state: 'complete' }, blobs: [{ bytes: new Uint8Array([1, 2]), mime: 'audio/wav' }] };
  const f = await fixture(t, async (args, state, calls) => { calls.push('device_once'); assert.equal(args.kind, 'microphone');
    return { state: 'completed', settled: true, guardReleased: true, value }; });
  const request = { requestId: randomUUID(), kind: 'microphone', descriptor: '{"cue":true,"durationMs":6000}' };
  const result = await f.adapter.run(request);
  assert.deepEqual(f.calls, ['pause', 'tail_ack_release', 'device_once', 'resume']);
  assert.equal(result.result, value); assert.equal(result.arbitration.resumeState, 'resumed');
  assert.equal(result.arbitration.gap.tailBoundaryUnknown, true);
  const replay = await f.adapter.run(request); assert.equal(replay.resultAvailable, false); assert.equal(f.calls.length, 4);
  await assert.rejects(f.adapter.run({ ...request, descriptor: '{"cue":false}' }), /request_id_conflict/);
});

test('photo and tone also require a released guard and preserve results', async t => {
  for (const kind of ['photo', 'tone']) {
    const f = await fixture(t, async () => ({ state: 'completed', settled: true, guardReleased: true, value: { kind } }));
    const result = await f.adapter.run({ requestId: randomUUID(), kind, descriptor: 'v1' });
    assert.deepEqual(result.result, { kind }); assert.equal(result.arbitration.state, 'completed');
  }
});

test('missing proof or unknown helper result retains latch and never repeats or resumes', async t => {
  for (const response of [{ state: 'completed', settled: true, guardReleased: false }, { state: 'unknown' }]) {
    let attempts = 0; const f = await fixture(t, async () => { attempts++; return response; });
    const request = { requestId: randomUUID(), kind: 'audio', descriptor: 'sha256:abc' };
    assert.equal((await f.adapter.run(request)).arbitration.state, 'unknown');
    assert.equal((await f.adapter.run(request)).arbitration.state, 'unknown');
    assert.equal(attempts, 1); assert(!f.calls.includes('resume'));
    await assert.rejects(f.adapter.run({ ...request, requestId: randomUUID() }), /previous_arbitration_unsettled/);
  }
});

test('stop while exclusive work is running invalidates continuous resume', async t => {
  const f = await fixture(t, async (_args, state) => { state.intentEnabled = false; state.intentRevision++; return { state: 'completed', settled: true, guardReleased: true, value: 'ok' }; });
  const result = await f.adapter.run({ requestId: randomUUID(), kind: 'video', descriptor: 'v1' });
  assert.equal(result.arbitration.resumeState, 'intent_changed_or_offline'); assert(!f.calls.includes('resume'));
});
