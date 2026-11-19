import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { TinaSelfMem } from '../src/core.mjs';
import { TinaSelfMemPersona } from '../src/cortico-bot.mjs';
import { canonical, digest } from '../vendor/capture/journal.mjs';
import { createFusionContextMaintenance, createSqliteContextMaintenanceStore } from '../../../../src/fusion-context-maintenance.mjs';

function record(seq, text) {
  const event = { seq, type: 'user/message', time: 1700000000000 + seq,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } };
  return { item: { type: 'message', id: `synthetic-${seq}`, role: 'user', status: 'completed',
    content: [{ type: 'input_text', text }] }, context: { nativeSeq: seq, native: { sessionId: 'main', event } } };
}

function derivedRecord(seq, text, plugin, ephemeral = false) {
  const item = record(seq, text);
  item.context.native.event.data.source = { kind: 'plugin', plugin };
  if (ephemeral) item.context.ephemeral = true;
  return item;
}

test('real SelfMem and durable coordinator reconcile after native commit but prefix refresh failure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tina-coordinator-integration-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const loaded = { rootDir: root, dataDir: join(root, 'data'), memoryDir: join(root, 'memory'),
    config: { selfMem: { agentId: 'synthetic' } } };
  const mem = new TinaSelfMem({ dataDir: join(root, 'shared') });
  let persona = new TinaSelfMemPersona(loaded, [], { mem });
  let store = createSqliteContextMaintenanceStore(join(root, 'coordinator.sqlite'));
  let nativeCommits = 0, refreshes = 0;
  const snapshot = { sessionId: 'main', generation: 4, digest: 'synthetic-request-view-v1', records: [record(101, 'captured original'),
    record(102, 'protected current input')], surfaceSeqs: [101, 102], revalidate: () => true };
  const native = {
    async verifySnapshot({ sessionId, snapshot: view }) {
      return sessionId === view.sessionId && view.records.every(item => item.context.native.sessionId === sessionId)
        && view.surfaceSeqs.every(seq => view.records.some(item => item.context.native.event.seq === seq));
    },
    async commit({ sessionId, operationId, generation, prepared, guardPlan }) {
      nativeCommits++;
      assert.equal(prepared.snapshotDigest, digest(canonical(snapshot.records)));
      assert.deepEqual(prepared.sourceCoverage.snapshotIds, [101, 102]);
      const guard = await guardPlan({ sessionId, compactionId: 'native-synthetic-1',
        visibleSeqs: [101, 102], shadowedSeqs: [101] });
      assert.equal(guard.allow, true); assert.equal(guard.revalidate(), true);
      return { operationId, sessionId, generation, durable: true, method: 'native-compact', markerSeq: 103,
        coverage: { snapshotDigest: prepared.snapshotDigest, sourceComplete: true,
          coveredNativeSeqs: [101], protectedNativeSeqs: [102] } };
    },
    async inspect() { throw new Error('native outcome was already durably recorded'); },
  };
  const inputProtection = async () => ({ safe: true, unknown: false, protectedNativeSeqs: [102], revalidate: () => true });
  const refreshPrefix = async () => { if (++refreshes === 1) throw new Error('synthetic prefix failure'); };
  let coordinator = createFusionContextMaintenance({ store, participant: persona, native, inputProtection, refreshPrefix });
  try {
    await assert.rejects(coordinator.maintain({ sessionId: 'main', operationId: 'operation-1', generation: 4,
      reason: 'manual', boundary: 'idle', snapshot }), /synthetic prefix failure/);
    assert.equal(nativeCommits, 1);
    assert.equal(persona.window, 1);
    assert.equal((await coordinator.status({ sessionId: 'main' })).phase, 'activating');
    await assert.rejects(coordinator.beforeRequest({ sessionId: 'main' }), { code: 'CONTEXT_RECOVERY_REQUIRED' });
    const ref = persona.handoff.ref;
    await persona.dispose(); store.close();

    persona = new TinaSelfMemPersona(loaded, [], { mem });
    store = createSqliteContextMaintenanceStore(join(root, 'coordinator.sqlite'));
    coordinator = createFusionContextMaintenance({ store, participant: persona, native, inputProtection, refreshPrefix });
    const resumed = await coordinator.reconcile({ sessionId: 'main' });
    assert.equal(resumed.status, 'complete');
    assert.equal(nativeCommits, 1);
    assert.equal(persona.window, 1);
    assert.equal(persona.handoff.ref, ref);
    assert.equal(await coordinator.beforeRequest({ sessionId: 'main' }), true);
    const row = persona.journal.rows().find(item => `src:${item.sourceId}` === ref);
    assert.equal(row.kind, 'handoff'); assert.equal(row.derived, true); assert.equal(row.transitional, true);
    assert.equal(row.derivedFrom.length, 2);
  } finally {
    await persona.dispose(); store.close(); await mem.close();
  }
});

test('consecutive native compactions archive the earlier ephemeral maintenance marker as derived', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tina-coordinator-consecutive-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const loaded = { rootDir: root, dataDir: join(root, 'data'), memoryDir: join(root, 'memory'),
    config: { selfMem: { agentId: 'synthetic' } } };
  const mem = new TinaSelfMem({ dataDir: join(root, 'shared') });
  let persona = new TinaSelfMemPersona(loaded, [], { mem });
  const store = createSqliteContextMaintenanceStore(join(root, 'coordinator.sqlite'));
  const native = {
    async verifySnapshot({ sessionId, snapshot: view }) {
      return sessionId === view.sessionId && view.records.every(item => item.context.native.sessionId === sessionId)
        && view.surfaceSeqs.every(seq => view.records.some(item => item.context.native.event.seq === seq));
    },
    async commit({ sessionId, operationId, generation, prepared, snapshot, guardPlan }) {
      const covered = generation === 1 ? [201] : [202, 203];
      const protectedNativeSeqs = generation === 1 ? [] : [204];
      for (const seq of covered) {
        const row = prepared.sourceCoverage.seqRefs.find(item => item.seq === seq);
        assert.ok(row?.refs.length && row.refs.every(ref => prepared.sourceCoverage.sourceRefs.includes(ref)));
      }
      const guard = await guardPlan({ sessionId, compactionId: `native-${generation}`,
        visibleSeqs: snapshot.surfaceSeqs, shadowedSeqs: covered });
      assert.equal(guard.revalidate(), true);
      return { operationId, sessionId, generation, durable: true, method: 'native-compact', markerSeq: 300 + generation,
        coverage: { snapshotDigest: prepared.snapshotDigest, sourceComplete: true,
          coveredNativeSeqs: covered, protectedNativeSeqs } };
    },
    async inspect() { throw new Error('not needed'); },
  };
  const inputProtection = async ({ snapshot }) => ({ safe: true, unknown: false,
    protectedNativeSeqs: snapshot.surfaceSeqs.includes(204) ? [204] : [], revalidate: () => true });
  const coordinator = createFusionContextMaintenance({ store, participant: persona, native, inputProtection, refreshPrefix: async () => {} });
  try {
    const first = { sessionId: 'main', generation: 1, digest: 'synthetic-view-first', records: [record(201, 'first original')], surfaceSeqs: [201], revalidate: () => true };
    assert.equal((await coordinator.maintain({ sessionId: 'main', operationId: 'first', generation: 1,
      boundary: 'idle', snapshot: first })).status, 'complete');
    assert.equal(persona.window, 1);
    const summary = derivedRecord(202, 'first native checkpoint', 'compact');
    const marker = derivedRecord(203, 'first native maintenance marker', 'cortico-native-handoff', true);
    const second = { sessionId: 'main', generation: 2, digest: 'synthetic-view-second', records: [summary, marker, record(204, 'protected input')],
      surfaceSeqs: [202, 203, 204], revalidate: () => true };
    assert.equal((await coordinator.maintain({ sessionId: 'main', operationId: 'second', generation: 2,
      boundary: 'idle', snapshot: second })).status, 'complete');
    assert.equal(persona.window, 2);
    const rows = persona.journal.rows();
    const stored = rows.find(row => row.original?.event?.seq === 203);
    assert.equal(stored.kind, 'context'); assert.equal(stored.derived, true);
    const checkpoint = rows.find(row => row.original?.event?.seq === 202);
    assert.equal(checkpoint.kind, 'checkpoint'); assert.equal(checkpoint.derived, true);
    await persona.dispose(); persona = new TinaSelfMemPersona(loaded, [], { mem });
    assert.equal(persona.window, 2);
    assert.ok(persona.handoff.ref.startsWith('src:handoff:'));
  } finally { await persona.dispose(); store.close(); await mem.close(); }
});
