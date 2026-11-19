// Model-free upgrade preflight. Inputs are read only; only an explicit new
// verification directory receives a working copy of the existing usage ledger.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const option = name => process.argv.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
const required = name => { const value = option(name); if (!value) throw new Error('Missing option: ' + name); return resolve(value); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contained = (root, file) => { const path = relative(root, file); return path && !path.startsWith('..') && !isAbsolute(path); };

async function main() {
  if (!process.argv.includes('--cold-snapshot')) throw new Error('Use only an established cold backup copy and pass --cold-snapshot.');
  const snapshot = await realpath(required('--snapshot-root'));
  const oldRoot = await realpath(required('--old-root'));
  const newRoot = await realpath(required('--new-root'));
  const journal = await realpath(required('--native-journal'));
  const usage = await realpath(required('--usage-jsonl'));
  if (!contained(snapshot, journal) || !contained(snapshot, usage)) throw new Error('Both private inputs must remain inside the explicit backup snapshot root.');
  const outputRoot = required('--output-dir');
  await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(join(await realpath(outputRoot), 'usage-replay-'));
  const reportFile = join(directory, 'receipt.json');
  const report = { version: 1, startedAt: new Date().toISOString(), snapshot, oldRoot, newRoot,
    journal, usage, directory, privateContentPrinted: false, modelRequests: 0, originalInputsChanged: false, passed: false };
  let stage = 'hash-inputs';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('Network is disabled during offline usage replay.'), { code: 'SNAPSHOT_NETWORK_FORBIDDEN' }); };
  try {
    const [nativeBytes, usageBytes, oldSource, newSource] = await Promise.all([
      readFile(journal), readFile(usage), readFile(join(oldRoot, 'src/fusion-usage.mjs')), readFile(join(newRoot, 'src/fusion-usage.mjs')),
    ]);
    report.inputHashes = { journal: hash(nativeBytes), usage: hash(usageBytes), oldProjection: hash(oldSource), newProjection: hash(newSource) };
    let clearBytes;
    try { clearBytes = await readFile(usage + '.replay-clear.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (clearBytes) report.inputHashes.clearWatermark = hash(clearBytes);
    const working = join(directory, 'usage.jsonl');
    await copyFile(usage, working);
    if (clearBytes) await writeFile(working + '.replay-clear.json', clearBytes);

    stage = 'decode-native-journal';
    const runtime = resolve(option('--runtime') ?? join(newRoot, 'runtime/dsh-0.1.5-rc.2'));
    const nativeRequire = createRequire(join(runtime, 'package.json'));
    const loadNative = name => import(pathToFileURL(nativeRequire.resolve(name)).href);
    const [{ Context }, { default: JsonlSessionPersistence }] = await Promise.all([
      loadNative('@deepseek-ai/cordis'), loadNative('@deepseek-ai/dsh-session-persistence-jsonl'),
    ]);
    // Node's one-shot decompressor may stop after the first concatenated frame.
    // Use it ONLY to discover the first header; the original backend below owns
    // complete-frame scanning, checksums, logical decoding and strict validation.
    const prefix = journal.endsWith('.zstd') ? zstdDecompressSync(nativeBytes) : nativeBytes;
    const firstLineEnd = prefix.indexOf(10);
    assert.ok(firstLineEnd >= 0, 'The first stored header must be newline-terminated.');
    const header = JSON.parse(prefix.subarray(0, firstLineEnd).toString('utf8'));
    assert.equal(header.type, 'session');
    const ctx = new Context();
    const mounted = ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'native-copy'),
      compression: journal.endsWith('.zstd') ? 'zstd' : 'none' });
    let stored;
    try {
      await mounted.await();
      const backend = ctx.sessionPersistence;
      // readStoredLog verifies physical path identity. Use its own pinned path
      // function on the private working copy, without rewriting header or rows.
      const nativeCopy = backend.locate(header).path;
      await mkdir(dirname(nativeCopy), { recursive: true });
      await writeFile(nativeCopy, nativeBytes, { flag: 'wx', mode: 0o600 });
      stored = await backend.readStoredLog(nativeCopy, header.id);
      assert.equal(stored.tornTruncateTo, undefined, 'Cold backup has a torn final frame or incomplete row.');
      assert.equal(stored.recoveredTail.length, 0, 'Cold backup would require native tail repair.');
      assert.equal(hash(await readFile(nativeCopy)), report.inputHashes.journal, 'Native reader changed its working copy.');
      report.nativeReader = { package: '@deepseek-ai/dsh-session-persistence-jsonl', method: 'readStoredLog',
        completeFrames: true, tailRepairRequired: false, byteIdenticalCopy: true };
    } finally { await mounted.dispose(); }
    const { events } = stored;
    report.nativeSessionId = header.id;
    report.nativeEvents = events.length;
    report.nativeTerminals = events.filter(event => ['assistant/message', 'assistant/attempt', 'compaction/summary', 'compaction/end'].includes(event.type)).length;

    stage = 'replay-existing-ledger';
    const [{ createFusionUsageProjection }, { UsageLog }, { SessionTracker }] = await Promise.all([
      import(pathToFileURL(join(newRoot, 'src/fusion-usage.mjs')).href),
      import(pathToFileURL(join(newRoot, 'upstream/cortico/src/core/usage-log.ts')).href),
      import(pathToFileURL(join(newRoot, 'upstream/cortico/src/core/sessions.ts')).href),
    ]);
    const initialLog = new UsageLog(working);
    const originalRows = initialLog.readAll();
    const target = originalRows.find(row => row.attempt?.meters.native?.sessionId === header.id);
    const decl = { id: target?.sessionId ?? 'main', label: target?.label ?? 'Tina' };
    if (target && target.role !== decl.id) throw new Error('Unsupported legacy session role mapping; inspect locally.');
    report.existingRows = originalRows.length;
    const replay = () => {
      const log = new UsageLog(working);
      const tracker = new SessionTracker('UTC', row => log.append(row));
      const projection = createFusionUsageProjection({ sessionId: header.id, decl, tracker, usageLog: log });
      projection.replay(events); projection.close(events);
      return { log, inspection: projection.inspect(), sessionCalls: tracker.list()[0]?.calls ?? 0 };
    };
    const first = replay();
    const once = await readFile(working);
    assert.deepEqual(once.subarray(0, usageBytes.length), usageBytes, 'Existing ledger bytes were rewritten.');
    const after = first.log.readAll();
    assert.deepEqual(after.slice(0, originalRows.length), originalRows, 'Original immutable receipts changed.');
    const identities = after.map(row => row.recordId ?? row.attempt?.id).filter(Boolean);
    assert.equal(new Set(identities).size, identities.length, 'Duplicate durable receipt identity.');
    report.firstReplay = { ...first.inspection, sessionCalls: first.sessionCalls, totalRows: after.length,
      newlyRecoveredRows: after.length - originalRows.length,
      addedEventTypes: after.slice(originalRows.length).map(row => row.attempt?.meters.native?.eventType ?? 'unknown') };
    stage = 'repeat-replay';
    const second = replay();
    assert.deepEqual(await readFile(working), once, 'Repeated replay appended or changed receipts.');
    assert.equal(second.sessionCalls, first.sessionCalls);
    report.secondReplay = { ...second.inspection, totalRows: second.log.count(), sessionCalls: second.sessionCalls };
    stage = 'verify-inputs-unchanged';
    assert.equal(hash(await readFile(journal)), report.inputHashes.journal);
    assert.equal(hash(await readFile(usage)), report.inputHashes.usage);
    if (clearBytes) {
      assert.deepEqual(await readFile(usage + '.replay-clear.json'), clearBytes);
      assert.deepEqual(await readFile(working + '.replay-clear.json'), clearBytes);
    }
    report.workingLedgerHash = hash(once); report.passed = true;
  } catch (error) {
    // Never print source lines or schema error payloads from a private journal.
    report.failure = { stage, name: error.name, code: error.code ?? 'SNAPSHOT_REPLAY_FAILED' };
    process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
    report.finishedAt = new Date().toISOString();
    await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify({ passed: report.passed, reportFile, existingRows: report.existingRows,
    newlyRecoveredRows: report.firstReplay?.newlyRecoveredRows ?? null, failure: report.failure ?? null }));
}

try { await main(); }
catch (error) { console.error(JSON.stringify({ passed: false, stage: 'preflight', code: error.code ?? 'SNAPSHOT_PREFLIGHT_FAILED' })); process.exitCode = 1; }
