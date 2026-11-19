import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StreamGuard } from './stream-guard.mjs';

test('real subprocess holds playback lock; settlement clears durable latch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stream-guard-')); const a = new StreamGuard({ stateDir: dir }), b = new StreamGuard({ stateDir: dir });
  const op = { operationId: randomUUID(), instanceId: randomUUID(), sequence: 1, kind: 'microphone_stream' };
  try {
    await a.reserve(op); assert.equal(JSON.parse(await readFile(join(dir, 'unsettled.json'), 'utf8')).operationId, op.operationId);
    await assert.rejects(b.reserve({ ...op, operationId: randomUUID() }));
    await a.settle(op.operationId, 'completed');
    assert.equal(JSON.parse(await readFile(join(dir, `receipt-${op.operationId}.json`), 'utf8')).state, 'completed');
  } finally { a.releaseUnknown(); b.releaseUnknown(); await rm(dir, { recursive: true, force: true }); }
});

test('parent loss releases OS lock but preserves unresolved latch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stream-guard-')); const a = new StreamGuard({ stateDir: dir });
  const op = { operationId: randomUUID(), instanceId: randomUUID(), sequence: 1, kind: 'microphone_stream' };
  try {
    await a.reserve(op); const exited = new Promise(resolve => a.child.once('exit', resolve)); a.releaseUnknown(); await exited;
    const b = new StreamGuard({ stateDir: dir }); try { await assert.rejects(b.reserve({ ...op, operationId: randomUUID() })); } finally { b.releaseUnknown(); }
    assert.equal(JSON.parse(await readFile(join(dir, 'unsettled.json'), 'utf8')).operationId, op.operationId);
  } finally { a.releaseUnknown(); await rm(dir, { recursive: true, force: true }); }
});
