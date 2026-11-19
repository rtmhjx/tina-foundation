import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import paths from './paths.cjs';
import archive from './fusion-session-archive.cjs';
import { runIntake } from './fusion-intake.mjs';
import { revisionAwareIntake } from './fusion-intake-revisions.mjs';

const canonical = JSON.stringify;
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function foundationInput(batch, message) {
  return { eventId: batch.sessionId + ':' + message.id + ':' + (message.revision ?? 1),
    input: { source: { sessionId: batch.sessionId, id: message.id }, payload: { text: message.text } } };
}
function intakeFixture() {
  const rows = new Map(), revisions = [];
  const sink = { async ingestConversation(batch) {
    const incoming = batch.messages.map(message => foundationInput(batch, message));
    for (const row of incoming) if (rows.has(row.eventId) && rows.get(row.eventId).contentHash !== digest(row.input.payload)) {
      throw Object.assign(new Error('conflict'), { code: 'EVENT_CONFLICT' });
    }
    let added = 0;
    for (const row of incoming) if (!rows.has(row.eventId)) {
      rows.set(row.eventId, { id: row.eventId, source: row.input.source, payload: row.input.payload, contentHash: digest(row.input.payload) }); added++;
    }
    return { sourceIds: incoming.map(row => row.eventId), added, jobIds: [] };
  } };
  const wrapped = revisionAwareIntake(sink, { foundationInput, foundationCanonical: canonical,
    readSource: async id => { if (!rows.has(id)) throw Object.assign(new Error('missing'), { status: 404 }); return rows.get(id); },
    onRevision: async row => revisions.push(row) });
  return { rows, revisions, wrapped };
}

test('explicit target required; deployment state and shared observer paths are configurable', () => {
  assert.throws(() => paths.resolveOpsPaths({ env: {} }), /CORTICO_FUSION_STATE/);
  const state = resolve('test-runtime/deployments/new');
  const resolved = paths.resolveOpsPaths({ env: { CORTICO_FUSION_STATE: state } });
  assert.equal(resolved.state, state);
  assert.equal(resolved.memoryCompatOrigin, 'http://127.0.0.1:8895');
  assert.equal(resolved.legacyObserver, resolve(state, '../../assembly/session-archive/tina-session-archive.js'));
  assert.equal(resolved.nativeArchive, resolve(state, '../../cortico-self/tina-main-native'));
});

test('rewritten source keeps original and ordered revisions; replay is idempotent', async () => {
  const f = intakeFixture();
  const batch = text => ({ sessionId: 'session', messages: [{ id: 'message', text }] });
  await f.wrapped.ingestConversation(batch('original'));
  const original = structuredClone(f.rows.get('session:message:1'));
  assert.equal((await f.wrapped.ingestConversation(batch('changed'))).added, 1);
  assert.equal((await f.wrapped.ingestConversation(batch('changed'))).added, 0);
  assert.equal((await f.wrapped.ingestConversation(batch('changed-again'))).added, 1);
  assert.deepEqual(f.rows.get('session:message:1'), original);
  assert.equal(f.rows.size, 3);
  assert.deepEqual(f.revisions.map(row => row.revision), [2, 3]);
  assert.ok(f.revisions.every(row => row.originalBytesRetained && row.newBytesRetained));
});

test('conflicting source identity is rejected without creating a revision', async () => {
  const f = intakeFixture();
  await f.wrapped.ingestConversation({ sessionId: 's', messages: [{ id: 'm', text: 'old' }] });
  f.rows.get('s:m:1').source.id = 'somebody-else';
  await assert.rejects(f.wrapped.ingestConversation({ sessionId: 's', messages: [{ id: 'm', text: 'new' }] }), { code: 'NATIVE_CONFLICT_ORIGIN_MISMATCH' });
  assert.equal(f.rows.size, 1);
  assert.equal(f.revisions.length, 0);
});

test('archive appends identical raw prefixes and refuses changed history without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-archive-'));
  const source = join(root, 'source.zstd'), destination = join(root, 'archive', 'session.v3.jsonl.zstd');
  await writeFile(source, Buffer.from([1, 2, 3]));
  assert.equal(archive.capture(source, destination).bytes, 3);
  await appendFile(source, Buffer.from([4, 5]));
  assert.equal(archive.capture(source, destination).bytes, 2);
  assert.equal(archive.capture(source, destination).reconciled, true);
  await writeFile(source, Buffer.from([0, 2, 3, 4, 5]));
  assert.throws(() => archive.capture(source, destination), /NATIVE_ARCHIVE_PREFIX_CHANGED/);
  assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 3, 4, 5]));
  const records = (await readFile(join(root, 'archive', 'capture-manifest.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 3);
  assert.ok(records.every(row => row.completeFrameChecked === false));
});

test('observer retains shared old archive, waits for stability and starts original legacy observer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-observer-'));
  const state = join(root, 'deployments', 'candidate'), destination = join(root, 'shared-archive');
  const source = join(state, 'native/dsh-embedded/home/sessions/new-workspace/new-session/session.v3.jsonl.zstd');
  await mkdir(join(destination, 'old-workspace', 'old-session'), { recursive: true });
  const old = join(destination, 'old-workspace', 'old-session', 'session.v3.jsonl.zstd');
  await writeFile(old, 'old immutable bytes');
  await mkdir(resolve(source, '..'), { recursive: true });
  await writeFile(source, 'new partial frame');
  const loaded = [];
  const observer = archive.start({ env: { CORTICO_FUSION_STATE: state, CORTICO_NATIVE_ARCHIVE: destination },
    loadLegacyObserver: module => loaded.push(module), onError: error => { throw error; } });
  try {
    assert.equal(loaded.length, 1);
    assert.match(loaded[0], /tina-session-archive\.js$/);
    assert.deepEqual(observer.scan(), []);
    assert.equal(observer.scan().length, 1);
    assert.deepEqual(observer.scan(), []);
    assert.equal(await readFile(old, 'utf8'), 'old immutable bytes');
    assert.equal(await readFile(join(destination, 'new-workspace/new-session/session.v3.jsonl.zstd'), 'utf8'), 'new partial frame');
  } finally { observer.stop(); }
});

test('collector uses existing cursor/cache and source paths; catch-up changes no config bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-intake-'));
  await mkdir(join(root, 'intake'));
  const config = { endpoint: 'http://127.0.0.1:8895/api/intake/conversation', stateFile: 'collector-state.sqlite', cacheDir: 'cache',
    tokenEnv: 'LOCAL_TEST_TOKEN', maxRecords: 10, sources: [{ kind: 'dsh-personal-sessions', root: '/home/user/.dsh/sessions' }] };
  const file = join(root, 'intake', 'collector.json');
  await writeFile(file, JSON.stringify(config));
  const before = await readFile(file);
  const f = intakeFixture();
  let closed = false, captured;
  const modules = async path => path.endsWith('memorybase-compat.mjs') ? { foundationInput, foundationCanonical: canonical } : {
    createHttpIntake: options => { assert.equal(options.token, 'private-fixture-only'); return f.wrapped; },
    createIntakeState: path => { assert.equal(path, join(root, 'intake', 'collector-state.sqlite')); return { close() { closed = true; } }; },
    collectAgentSources: async options => { captured = options; return { added: 0, processed: 0, readLines: 0, sources: options.sources, errors: [], unsupported: [], budgetExhausted: false }; },
  };
  await runIntake({ stateDir: root, env: { LOCAL_TEST_TOKEN: 'private-fixture-only' }, catchUp: true, loadModule: modules, log() {} });
  assert.equal(closed, true);
  assert.equal(captured.maxRecords, 10000);
  assert.equal(captured.cacheDir, join(root, 'intake', 'cache'));
  assert.equal(captured.sources[0].root, resolve(root, 'intake', '/home/user/.dsh/sessions'));
  assert.deepEqual(await readFile(file), before);
});
