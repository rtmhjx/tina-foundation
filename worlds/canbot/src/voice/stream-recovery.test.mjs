import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { recoverCompletedStream, isolateInterruptedGeneration } from './stream-recovery.mjs';

test('recovery clears only a fully processed and ACKed matching operation; never resends event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice-recovery-')), stateDir = join(root, 'state'), spoolRoot = join(root, 'spool');
  const id = randomUUID(), instance = randomUUID(), folder = join(spoolRoot, id), outbox = join(folder, 'outbox');
  await mkdir(stateDir, { recursive: true }); await mkdir(outbox, { recursive: true });
  await writeFile(join(stateDir, 'unsettled.json'), JSON.stringify({ operationId: id, instanceId: instance, kind: 'microphone_stream' }));
  await writeFile(join(folder, 'manifest.json'), JSON.stringify({ streamId: id, finished: true, gap: false, ackedThrough: 1, finalState: { settled: true, finalSequence: 1 } }));
  await writeFile(join(outbox, 'processing.json'), JSON.stringify({ streamId: id, state: 'complete' }));
  const eventPath = join(outbox, `${randomUUID()}.json`); await writeFile(eventPath, JSON.stringify({ state: 'pending_outcome_unknown' }));
  let settled = 0; const guardFactory = () => ({ recover: async () => {}, settle: async () => { settled++; }, waitReleased: async () => true, releaseUnknown() {} });
  const head = { request: async (_kind, path) => path === '/v1/status' ? { instanceId: instance, activeOperation: null } :
    { instanceId: instance, operationId: id, settled: true, state: 'complete', gap: null, tailState: 'empty', finalSequence: 1, lastAckSequence: 1 } };
  try {
    assert.equal((await recoverCompletedStream({ head, stateDir, spoolRoot, guardFactory })).reason, 'event_outcome_unknown');
    assert.equal(settled, 0); await writeFile(eventPath, JSON.stringify({ state: 'confirmed', cursor: 2 }));
    assert.equal((await recoverCompletedStream({ head, stateDir, spoolRoot, guardFactory })).recovered, true); assert.equal(settled, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new device generation isolates interrupted old operation; same generation stays blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice-recovery-')), id = randomUUID(), old = randomUUID(), fresh = randomUUID();
  await writeFile(join(root, 'unsettled.json'), JSON.stringify({ operationId: id, instanceId: old, kind: 'microphone_stream' }));
  let isolated = 0, current = old;
  const guardFactory = () => ({ recover: async () => {}, quarantine: async (key, generation) => { assert.equal(key, id); assert.equal(generation, fresh); isolated++; }, waitReleased: async () => true, releaseUnknown() {} });
  const head = { request: async () => ({ instanceId: current, foreground: true, activeOperation: null, microphoneCapture: { supportsStream: true } }) };
  try {
    assert.equal((await isolateInterruptedGeneration({ head, stateDir: root, guardFactory })).isolated, false);
    current = fresh; const result = await isolateInterruptedGeneration({ head, stateDir: root, guardFactory });
    assert.equal(result.isolated, true); assert.equal(result.eventDeliveryUnknown, true); assert.equal(isolated, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
