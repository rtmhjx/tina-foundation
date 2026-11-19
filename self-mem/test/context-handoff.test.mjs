import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TinaSelfMem } from '../src/core.mjs';
import { TinaSelfMemPersona } from '../src/cortico-bot.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tina-handoff-tx-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const loaded = { rootDir: root, dataDir: join(root, 'data'), memoryDir: join(root, 'memory'),
    config: { selfMem: { agentId: 'synthetic' } } };
  const mem = new TinaSelfMem({ dataDir: join(root, 'shared') });
  const persona = () => new TinaSelfMemPersona(loaded, [], { mem });
  return { root, mem, persona };
}

function record(seq, text, source = { kind: 'user' }, sessionId = 'main') {
  const event = { seq, type: 'user/message', time: 1700000000000 + seq,
    data: { role: 'user', content: [{ type: 'text', text }], source } };
  return { item: { type: 'message', id: `synthetic-${seq}`, role: 'user', status: 'completed',
    content: [{ type: 'input_text', text }] }, context: { nativeSeq: seq, native: { sessionId, event } } };
}

const receipt = prepared => ({ operationId: prepared.operationId, sessionId: prepared.sessionId,
  generation: prepared.generation, durable: true, method: 'native-compact', markerSeq: 99,
  coverage: { snapshotDigest: prepared.snapshotDigest, sourceComplete: true,
    coveredNativeSeqs: [...prepared.sourceCoverage.snapshotIds], protectedNativeSeqs: [] } });

test('prepare preserves the active window and retries the same original sources', async t => {
  const { mem, persona: create } = fixture(t);
  const persona = create();
  try {
    const snapshot = [record(11, 'synthetic original'), record(12, 'another original')];
    const first = await persona.prepareContextHandoff({ operationId: 'prepare-1', generation: 7, snapshot });
    assert.equal(persona.window, 0);
    assert.equal(persona.handoff, null);
    assert.equal(first.semanticCoverage, null);
    assert.deepEqual(first.sourceCoverage.snapshotIds, [11, 12]);
    assert.equal(first.sourceCoverage.complete, true);
    assert.deepEqual(first.sourceCoverage.seqRefs.map(row => row.seq), [11, 12]);
    assert.ok(first.sourceCoverage.seqRefs.every(row => row.refs.length === 1
      && first.sourceCoverage.sourceRefs.includes(row.refs[0])));
    assert.deepEqual(first.retainedTail, snapshot);
    const index = persona.journal.rows().find(row => 'src:' + row.sourceId === first.navigation.ref);
    assert.equal(index.derived, true);
    assert.equal(index.transitional, true);
    assert.deepEqual(index.derivedFrom, first.sourceCoverage.sourceRefs);
    const again = await persona.prepareContextHandoff({ operationId: 'prepare-1', generation: 7, snapshot });
    assert.deepEqual(again, first);
    assert.equal(persona.journal.rows().length, 3);
    await assert.rejects(persona.prepareContextHandoff({ operationId: 'prepare-1', generation: 7,
      snapshot: [record(11, 'changed')] }), { code: 'HANDOFF_OPERATION_CONFLICT' });
  } finally { await persona.dispose(); await mem.close(); }
});

test('native receipt is required, rejects unknown coverage and wrong identity, then reconciles after restart', async t => {
  const { mem, persona: create } = fixture(t);
  let persona = create();
  try {
    const snapshot = [record(21, 'preserve this')];
    const prepared = await persona.prepareContextHandoff({ operationId: 'recover-1', generation: 'g1', snapshot });
    await assert.rejects(persona.commitContextHandoff({ operationId: 'recover-1', generation: 'g1' }),
      { code: 'HANDOFF_RECEIPT_MISMATCH' });
    await assert.rejects(persona.commitContextHandoff({ operationId: 'recover-1', generation: 'g1',
      nativeReceipt: { ...receipt(prepared), sessionId: 'other' } }), { code: 'HANDOFF_RECEIPT_MISMATCH' });
    const bad = receipt(prepared); bad.coverage.protectedNativeSeqs = [21];
    await assert.rejects(persona.commitContextHandoff({ operationId: 'recover-1', generation: 'g1', nativeReceipt: bad }),
      { code: 'HANDOFF_COVERAGE_UNVERIFIED' });
    assert.equal(persona.window, 0);
    await persona.dispose();
    persona = create();
    assert.equal(persona.window, 0);
    const committed = await persona.reconcileContextHandoff({ operationId: 'recover-1', generation: 'g1',
      nativeReceipt: receipt(prepared) });
    assert.equal(committed.window, 1);
    assert.equal(persona.window, 1);
    assert.equal(persona.handoff.ref, prepared.navigation.ref);
    assert.deepEqual(await persona.reconcileContextHandoff({ operationId: 'recover-1', generation: 'g1',
      nativeReceipt: receipt(prepared) }), committed);
    assert.equal(persona.window, 1);
    const conflict = { ...receipt(prepared), markerSeq: 100 };
    await assert.rejects(persona.commitContextHandoff({ operationId: 'recover-1', generation: 'g1', nativeReceipt: conflict }),
      { code: 'HANDOFF_RECEIPT_CONFLICT' });
  } finally { await persona.dispose(); await mem.close(); }
});

test('unknown native identity cannot certify source coverage or activate a window', async t => {
  const { mem, persona: create } = fixture(t);
  const persona = create();
  try {
    const snapshot = [{ item: { id: 'no-native-seq', type: 'message', role: 'user', content: 'synthetic' }, context: {} }];
    const prepared = await persona.prepareContextHandoff({ operationId: 'missing-seq', generation: 1, snapshot });
    assert.equal(prepared.sourceCoverage.complete, false);
    assert.equal(prepared.sourceCoverage.sourceRefs.length, 1);
    await assert.rejects(persona.commitContextHandoff({ operationId: 'missing-seq', generation: 1,
      nativeReceipt: receipt(prepared) }), { code: 'HANDOFF_COVERAGE_UNVERIFIED' });
    assert.equal(persona.window, 0);
  } finally { await persona.dispose(); await mem.close(); }
});

test('native compact and maintenance messages remain derived, never human conversation originals', async t => {
  const { mem, persona: create } = fixture(t);
  const persona = create();
  try {
    const summary = record(31, 'synthetic compact summary', { kind: 'plugin', plugin: 'compact' });
    const marker = record(32, 'synthetic maintenance marker', { kind: 'plugin', plugin: 'cortico-native-handoff' });
    marker.context.ephemeral = true;
    const human = record(33, 'synthetic human original');
    const refs = [summary, marker, human].map(entry => persona.captureRecord(entry));
    const rows = persona.journal.rows();
    const [summaryRow, markerRow, humanRow] = refs.map(ref => rows.find(row => 'src:' + row.sourceId === ref));
    assert.equal(summaryRow.kind, 'checkpoint'); assert.equal(summaryRow.derived, true);
    assert.equal(markerRow.kind, 'context'); assert.equal(markerRow.derived, true);
    assert.equal(humanRow.kind, 'conversation'); assert.equal(humanRow.derived, undefined);
    await persona.flush();
    const prepared = await persona.prepareContextHandoff({ operationId: 'marker-covered', generation: 1,
      snapshot: [summary, marker, human, { ...human, item: { ...human.item, id: 'same-native-other-projection' } }] });
    assert.equal(prepared.sourceCoverage.complete, true);
    assert.deepEqual(prepared.sourceCoverage.snapshotIds, [31, 32, 33]);
    assert.equal(prepared.sourceCoverage.seqRefs.find(row => row.seq === 32).refs[0], refs[1]);
    assert.equal(prepared.sourceCoverage.seqRefs.find(row => row.seq === 33).refs.length, 1);
  } finally { await persona.dispose(); await mem.close(); }
});

test('a failed ingest acknowledgment preserves captures and retries without advancing the window', async t => {
  const { mem, persona: create } = fixture(t);
  const persona = create();
  const stats = mem.stats.bind(mem);
  try {
    let fail = true;
    mem.stats = async (...args) => { if (fail) { fail = false; throw new Error('synthetic lost acknowledgment'); } return stats(...args); };
    const snapshot = [record(41, 'captured before acknowledgment')];
    await assert.rejects(persona.prepareContextHandoff({ operationId: 'retry-1', generation: 3, snapshot }), /synthetic lost acknowledgment/);
    assert.equal(persona.window, 0);
    assert.ok(persona.journal.pendingCount() > 0);
    const prepared = await persona.prepareContextHandoff({ operationId: 'retry-1', generation: 3, snapshot });
    assert.equal(prepared.sourceCoverage.complete, true);
    assert.equal(persona.journal.pendingCount(), 0);
    assert.equal(persona.journal.rows().length, 2);
    assert.equal(persona.window, 0);
  } finally { mem.stats = stats; await persona.dispose(); await mem.close(); }
});

test('two sessions sharing a journal commit distinct windows and heads without cross-session activation', async t => {
  const { mem, persona: create } = fixture(t);
  const a = create(); const b = create(); b.sourceSessionId = 'session-b';
  try {
    const first = await a.prepareContextHandoff({ operationId: 'same-operation-id', generation: 1,
      snapshot: [record(51, 'only session A')] });
    const second = await b.prepareContextHandoff({ operationId: 'same-operation-id', generation: 1,
      snapshot: [record(61, 'only session B', { kind: 'user' }, 'session-b')] });
    await a.commitContextHandoff({ operationId: 'same-operation-id', generation: 1, nativeReceipt: receipt(first) });
    await b.commitContextHandoff({ operationId: 'same-operation-id', generation: 1, nativeReceipt: receipt(second) });
    assert.equal(a.window, 1); assert.equal(b.window, 1);
    assert.equal(a.handoff.ref, first.navigation.ref); assert.equal(b.handoff.ref, second.navigation.ref);
    a.loadSessionHandoffState(); b.loadSessionHandoffState();
    assert.equal(a.handoff.ref, first.navigation.ref); assert.equal(b.handoff.ref, second.navigation.ref);
    await assert.rejects(b.reconcileContextHandoff({ operationId: 'same-operation-id', generation: 1,
      nativeReceipt: receipt(first) }), { code: 'HANDOFF_RECEIPT_MISMATCH' });
  } finally { await a.dispose(); await b.dispose(); await mem.close(); }
});

test('missing or contradictory native identity is incomplete, and the legacy SDK hook remains valid', async t => {
  const { mem, persona: create } = fixture(t);
  const persona = create();
  try {
    const conflicting = record(71, 'contradictory native identity');
    conflicting.context.nativeSeq = 72;
    const prepared = await persona.prepareContextHandoff({ operationId: 'bad-identity', generation: 2,
      snapshot: [conflicting, { context: {} }] });
    assert.equal(prepared.sourceCoverage.complete, false);
    const unknownEphemeral = record(74, 'unknown ephemeral'); unknownEphemeral.context.ephemeral = true;
    const unknown = await persona.prepareContextHandoff({ operationId: 'unknown-ephemeral', generation: 2,
      snapshot: [unknownEphemeral] });
    assert.equal(unknown.sourceCoverage.complete, false);
    assert.deepEqual(unknown.sourceCoverage.snapshotIds, []);
    const projectionOnly = record(75, 'projection without the complete native event');
    delete projectionOnly.context.native.event;
    const incomplete = await persona.prepareContextHandoff({ operationId: 'projection-only', generation: 2,
      snapshot: [projectionOnly] });
    assert.equal(incomplete.sourceCoverage.complete, false);
    assert.equal(incomplete.sourceCoverage.sourceRefs.length, 1);
    const foreign = record(76, 'foreign session', { kind: 'user' }, 'other-session');
    const mismatch = await persona.prepareContextHandoff({ operationId: 'foreign-session', generation: 2,
      snapshot: [foreign] });
    assert.equal(mismatch.sourceCoverage.complete, false);
    assert.deepEqual(await persona.onHandoff([record(73, 'legacy host source')]), { tail: null });
    assert.equal(persona.window, 0);
  } finally { await persona.dispose(); await mem.close(); }
});

test('the same session generation cannot activate twice under different operations', async t => {
  const { mem, persona: create } = fixture(t);
  const persona = create();
  try {
    const first = await persona.prepareContextHandoff({ operationId: 'generation-first', generation: 9,
      snapshot: [record(81, 'first generation source')] });
    await persona.commitContextHandoff({ operationId: 'generation-first', generation: 9, nativeReceipt: receipt(first) });
    const head = persona.handoff.ref;
    const second = await persona.prepareContextHandoff({ operationId: 'generation-second', generation: 9,
      snapshot: [record(82, 'same generation different operation')] });
    await assert.rejects(persona.commitContextHandoff({ operationId: 'generation-second', generation: 9,
      nativeReceipt: receipt(second) }), { code: 'HANDOFF_GENERATION_CONFLICT' });
    assert.equal(persona.window, 1);
    assert.equal(persona.handoff.ref, head);
    assert.ok(persona.journal.rows().some(row => row.content === 'same generation different operation'));
  } finally { await persona.dispose(); await mem.close(); }
});

test('existing duplicate committed generations fail visibly without deleting either record', async t => {
  const { root, mem, persona: create } = fixture(t);
  const journalDir = join(root, 'data', 'tina-self-mem');
  mkdirSync(journalDir, { recursive: true });
  const journalPath = join(journalDir, 'capture.sqlite');
  const db = new DatabaseSync(journalPath);
  db.exec(`CREATE TABLE handoff_operations (operation_id TEXT NOT NULL, session_id TEXT NOT NULL,
    generation TEXT NOT NULL, expected_window INTEGER NOT NULL, payload TEXT NOT NULL,
    phase TEXT NOT NULL, receipt TEXT, PRIMARY KEY (session_id, operation_id))`);
  const insert = db.prepare(`INSERT INTO handoff_operations
    (session_id,operation_id,generation,expected_window,payload,phase) VALUES (?,?,?,?,?,'committed')`);
  insert.run('main', 'legacy-a', '9', 0, '{}');
  insert.run('main', 'legacy-b', '9', 1, '{}');
  db.close();
  try {
    assert.throws(() => create(), { code: 'HANDOFF_GENERATION_CONFLICT' });
    const verify = new DatabaseSync(journalPath, { readOnly: true });
    try { assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM handoff_operations WHERE session_id='main' AND generation='9'").get().n, 2); }
    finally { verify.close(); }
  } finally { await mem.close(); }
});

test('native in-session system and developer events are covered as derived context, while frozen head is excluded', async t => {
  const { mem, persona: create } = fixture(t);
  const persona = create();
  const control = (seq, role, text) => {
    const message = { role, content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'runtime-control' } };
    const event = { seq, type: 'system/message', time: 1700000000000 + seq, data: { turn: 3, step: 2, message } };
    return { item: { type: 'message', id: `control-${seq}`, role, status: 'completed',
      content: [{ type: 'input_text', text }] }, context: { nativeSeq: seq, native: { sessionId: 'main', event } } };
  };
  try {
    const head = control(80, 'system', 'frozen system head'); head.context.head = true;
    const system = control(81, 'system', 'new mid-session system context');
    const developer = control(82, 'developer', 'new mid-session developer control');
    const human = record(83, 'real user input');
    const duplicateProjection = { ...system, item: { ...system.item, id: 'second-projection' } };
    const snapshot = [head, system, developer, human, duplicateProjection];
    const prepared = await persona.prepareContextHandoff({ operationId: 'control-coverage', generation: 1, snapshot });
    assert.equal(prepared.sourceCoverage.complete, true);
    assert.deepEqual(prepared.sourceCoverage.snapshotIds, [81, 82, 83]);
    assert.equal(prepared.sourceCoverage.sourceRefs.length, 3);
    for (const entry of [system, developer]) {
      const seq = entry.context.nativeSeq;
      const refs = prepared.sourceCoverage.seqRefs.find(row => row.seq === seq).refs;
      assert.equal(refs.length, 1);
      const row = persona.journal.rows().find(value => `src:${value.sourceId}` === refs[0]);
      assert.equal(row.kind, 'context'); assert.equal(row.derived, true); assert.equal(row.transitional, true);
      assert.equal(row.role, entry.item.role);
      assert.equal(row.content, entry.item.content[0].text);
      assert.deepEqual(row.original.event, entry.context.native.event);
    }
    assert.equal(persona.journal.rows().some(row => row.content === 'frozen system head'), false);
    const repeated = await persona.prepareContextHandoff({ operationId: 'control-coverage', generation: 1, snapshot });
    assert.deepEqual(repeated, prepared);
    const unknown = await persona.prepareContextHandoff({ operationId: 'control-unknown', generation: 2,
      snapshot: [{ item: { type: 'message', id: 'unknown-control', role: 'system', content: 'unknown' }, context: {} }] });
    assert.equal(unknown.sourceCoverage.complete, false);
    const unknownRow = persona.journal.rows().find(row => row.content === 'unknown');
    assert.equal(unknownRow.kind, 'context'); assert.equal(unknownRow.derived, true);
  } finally { await persona.dispose(); await mem.close(); }
});

test('compaction guidance stays brief, does not embed snapshot or persona, and observes cancellation', () => {
  const persona = Object.create(TinaSelfMemPersona.prototype);
  const marker = 'SYNTHETIC_PRIVATE_SNAPSHOT_MARKER';
  const text = persona.contextCompactionInstruction({ sessionId: 'synthetic', snapshot: [{ text: marker }] });
  assert.equal(typeof text, 'string');
  assert.ok(text.length < 300);
  assert.doesNotMatch(text, new RegExp(marker));
  for (const required of ['原语言', '身份', '关系', '场景', '情绪', '说话习惯', '用户边界', '未完成', '事实', '推断']) assert.ok(text.includes(required), required);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => persona.contextCompactionInstruction({ signal: controller.signal }), { name: 'AbortError' });
});

test('ingress shutdown failure still flushes pending originals before reporting the error', async t => {
  const { mem, persona: create } = fixture(t);
  const persona = create();
  const ingressError = new Error('synthetic ingress close failure');
  try {
    const ref = persona.captureRecord(record(901, 'pending original survives ingress error'));
    assert.equal(persona.journal.pendingCount(), 1);
    persona.memoryIngress = { async close() { throw ingressError; } };
    await assert.rejects(persona.dispose(), error => error === ingressError);
    const source = await mem.readRef(ref);
    assert.equal(source.content, 'pending original survives ingress error');
  } finally { await mem.close(); }
});

test('shutdown preserves flush and resource close errors together', async t => {
  const { mem, persona: create } = fixture(t);
  const persona = create();
  const flushError = new Error('synthetic flush failure');
  const closeError = new Error('synthetic facet close failure');
  try {
    persona.captureRecord(record(902, 'pending original for failing flush'));
    mem.ingestSource = async () => { throw flushError; };
    persona.facet.close = async () => { throw closeError; };
    await assert.rejects(persona.dispose(), error => error instanceof AggregateError
      && error.errors.length === 2 && error.errors[0] === flushError && error.errors[1] === closeError);
  } finally { await mem.close(); }
});

test('SelfMem closes shared storage and retains all earlier close failures', async () => {
  const mem = Object.create(TinaSelfMem.prototype);
  const errors = ['ready', 'index', 'index-close', 'legacy-close', 'shared-close'].map(name => new Error(`synthetic ${name}`));
  const calls = [];
  Object.assign(mem, {
    closed: false,
    _ready: Promise.reject(errors[0]),
    _indexTail: Promise.reject(errors[1]),
    indexDb: { close() { calls.push('index'); throw errors[2]; } },
    legacyRecall: { async close() { calls.push('legacy'); throw errors[3]; } },
    ownsSharedMem: true,
    shared: { async close() { calls.push('shared'); throw errors[4]; } },
  });
  // Mark the independently failing tail observed before close awaits the earlier promise.
  void mem._indexTail.catch(() => {});
  await assert.rejects(mem.close(), error => error instanceof AggregateError
    && error.errors.length === errors.length && error.errors.every((value, index) => value === errors[index]));
  assert.deepEqual(calls, ['index', 'legacy', 'shared']);
});

test('SelfMem leaves borrowed shared storage open on close', async () => {
  const mem = Object.create(TinaSelfMem.prototype);
  let sharedClosed = false;
  Object.assign(mem, { closed: false, _ready: Promise.resolve(), _indexTail: Promise.resolve(),
    indexDb: { close() {} }, legacyRecall: null, ownsSharedMem: false,
    shared: { async close() { sharedClosed = true; } } });
  await mem.close();
  assert.equal(sharedClosed, false);
});
