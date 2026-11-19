// Offline acceptance for newly written compaction records. Both runtimes read
// byte-identical private copies; this script never opens the source for writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = name => process.argv.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
const oldRoot = resolve(option('--old-root') ?? 'F:/CODEX/tina-cordis');
const provenance = JSON.parse(await readFile(resolve(option('--provenance') ?? join(root, 'artifacts/implementation/fusion-context-native-provenance.json')), 'utf8'));
const output = resolve(option('--output') ?? join(root, 'artifacts/implementation/context-legacy-acceptance.json'));
const scratch = await mkdtemp(join(tmpdir(), 'fusion-context-legacy-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const load = runtime => {
  const require = createRequire(join(runtime, 'package.json'));
  return name => import(pathToFileURL(require.resolve(name)).href);
};
const oldLoad = load(join(oldRoot, 'runtime/dsh-0.1.5-rc.2'));
const currentLoad = load(join(root, 'runtime/dsh-0.1.5-rc.2'));
const oldVersion = JSON.parse(await readFile(join(oldRoot, 'package.json'), 'utf8')).version;
async function readStrict(loader, bytes, header, label) {
  const [{ Context }, { default: Persistence }, session] = await Promise.all([
    loader('@deepseek-ai/cordis'), loader('@deepseek-ai/dsh-session-persistence-jsonl'), loader('@deepseek-ai/dsh-session'),
  ]);
  const ctx = new Context();
  const mounted = ctx.plugin(Persistence, { root: join(scratch, label), compression: 'zstd' });
  try {
    await mounted.await();
    const path = ctx.sessionPersistence.locate(header).path;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
    const result = await ctx.sessionPersistence.readStoredLog(path, header.id);
    assert.equal(result.tornTruncateTo, undefined, label + ': no torn final frame may be repaired');
    assert.deepEqual(result.recoveredTail, [], label + ': no recovered tail may be substituted');
    assert.equal(hash(await readFile(path)), hash(bytes), label + ': reader must leave copied bytes unchanged');
    const nodes = session.foldSurface(result.events).nodes;
    const messages = nodes.map(seq => session.deriveEventMessage(result.events.find(event => event.seq === seq))).filter(Boolean);
    return { events: result.events, nodes, messages };
  } finally { await mounted.dispose(); }
}
const newMeterFields = ['llmStreamCoverage', 'llmStreamCall', 'usage', 'replayState'];
const semantic = events => events.map(event => {
  if (!['compaction/summary', 'compaction/end'].includes(event.type)) return event;
  const copy = structuredClone(event);
  for (const key of newMeterFields) delete copy.data[key];
  return copy;
});
const report = { generatedAt: new Date().toISOString(), oldRoot, oldVersion, scratch,
  scope: 'Actual local scripted-provider App journals; no production or external model.',
  sourceBytesUnchanged: true, sessions: [], passed: false };
try {
  const states = [...new Set(provenance.sessions.map(value => value.stateDir))];
  for (const state of states) {
    const directory = join(state, 'native/dsh-embedded/home/sessions');
    const journals = (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name === 'session.v3.jsonl.zstd').map(entry => join(entry.parentPath, entry.name));
    for (const journal of journals) {
      const bytes = await readFile(journal);
      // Discover only the header here. Native strict readers own all frames.
      const prefix = zstdDecompressSync(bytes);
      const header = JSON.parse(prefix.subarray(0, prefix.indexOf(10)).toString());
      const current = await readStrict(currentLoad, bytes, header, 'current-' + header.id);
      const previous = await readStrict(oldLoad, bytes, header, 'old-' + header.id);
      assert.deepEqual(semantic(previous.events), semantic(current.events), 'Old reader must preserve original semantic events, order and source references');
      assert.deepEqual(previous.nodes, current.nodes, 'Old fold must reconstruct the same effective surface');
      assert.deepEqual(previous.messages, current.messages, 'Old derive must reconstruct the same actual message bodies');
      const extras = current.events.filter(event => ['compaction/summary', 'compaction/end'].includes(event.type));
      const preserved = [], ignored = [];
      for (const event of extras) for (const field of newMeterFields) if (Object.hasOwn(event.data, field)) {
        const old = previous.events.find(value => value.seq === event.seq);
        if (!Object.hasOwn(old.data, field)) ignored.push({ seq: event.seq, type: event.type, field });
        else { assert.deepEqual(old.data[field], event.data[field]); preserved.push({ seq: event.seq, type: event.type, field }); }
      }
      assert.equal(hash(await readFile(journal)), hash(bytes));
      report.sessions.push({ journal, sessionId: header.id, sha256: hash(bytes), events: current.events.length,
        surfaceNodes: current.nodes.length, messages: current.messages.length, compactionRecords: extras.length,
        preservedAdditionalFields: preserved, ignoredAdditionalFields: ignored,
        usageCompatibility: 'Read/replay preserves session semantics. The previous runtime does not implement the new summary/failure usage projection; compatibility is not equivalent billing coverage.' });
    }
  }
  assert.ok(report.sessions.some(session => session.compactionRecords > 0), 'Actual compaction records are required');
  const fields = new Set(report.sessions.flatMap(session => [...session.preservedAdditionalFields, ...session.ignoredAdditionalFields].map(row => row.field)));
  for (const field of newMeterFields) assert.ok(fields.has(field), 'Missing actual field coverage: ' + field);
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, code: error.code ?? 'CONTEXT_LEGACY_REPLAY_FAILED', message: error.message };
  process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, oldVersion, output, sessions: report.sessions.length, failure: report.failure }));
