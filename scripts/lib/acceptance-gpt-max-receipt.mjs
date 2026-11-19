import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requiredPhases = ['chat', 'rp', 'read', 'compaction', 'restart'];

/** Code-only fingerprints. Provider .env, account metadata and memories are never enumerated. */
export async function acceptanceCodeSnapshot(root) {
  const rows = [];
  const add = async (path, label) => {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) {
        if (['node_modules', '.git'].includes(child)) continue;
        await add(join(path, child), label + '/' + child);
      }
    } else if (info.isFile()) rows.push({ path: label, bytes: info.size, sha256: hash(await readFile(path)) });
  };
  for (const path of ['src', 'upstream/cortico/src', 'vendor/host-self-mem/package',
    'vendor/self-mem-lock.json', 'vendor/self-mem-build-manifest.json',
    'scripts/acceptance-gpt-max.mjs', 'scripts/lib/acceptance-gpt-max-receipt.mjs', 'scripts/lib/acceptance-gpt-max-state.mjs',
    'scripts/lib/native-file-read-evidence.mjs',
    'artifacts/validation/native-context-build-freeze.json']) await add(join(root, path), path);
  for (const name of ['dsh-agent-loop', 'dsh-compaction-basic', 'dsh-token-meter', 'dsh-session',
    'dsh-session-controller', 'dsh-tools', 'dsh-file-upload', 'dsh-host-client']) {
    await add(join(root, 'upstream', name, 'src'), 'upstream/' + name + '/src');
  }
  const runtime = join(root, 'runtime/dsh-0.1.5-rc.2');
  const require = createRequire(join(runtime, 'package.json'));
  for (const name of ['cordis', 'dsh-agent-loop', 'dsh-compaction-basic', 'dsh-token-meter', 'dsh-session',
    'dsh-api-session-controller', 'dsh-tools', 'dsh-client-file-upload', 'dsh-session-persistence-jsonl',
    'dsh-session-format', 'dsh-session-format-catalog', 'dsh-llm']) {
    const entry = require.resolve('@deepseek-ai/' + name);
    const directory = dirname(entry);
    await add(directory, 'runtime/@deepseek-ai/' + name + '/lib');
    await add(join(directory, '..', 'package.json'), 'runtime/@deepseek-ai/' + name + '/package.json');
  }
  for (const path of ['runtime-manifest.json', 'runtime-links.json', 'package.json']) await add(join(runtime, path), 'runtime/' + path);
  const market = join(root, '.tina-fusion-dev/provider-acceptance/extensions/node_modules/cortico-provider-chatgpt');
  for (const path of ['src', 'package.json']) await add(join(market, path), 'market/cortico-provider-chatgpt/' + path);
  const marketRequire = createRequire(join(market, 'package.json'));
  const cooEntry = marketRequire.resolve('cortico-provider-coo');
  let cooRoot = dirname(cooEntry);
  // The fixed market archive exposes src/index.ts. Ascend only until its own
  // package manifest; no account/state directories are traversed.
  for (;;) {
    try { if (JSON.parse(await readFile(join(cooRoot, 'package.json'), 'utf8')).name === 'cortico-provider-coo') break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(cooRoot); if (parent === cooRoot) throw new Error('Pinned coo package root missing'); cooRoot = parent;
  }
  for (const path of ['src', 'package.json']) await add(join(cooRoot, path), 'market/cortico-provider-coo/' + path);
  rows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const subset = prefix => hash(JSON.stringify(rows.filter(row => row.path.startsWith(prefix))));
  return { kind: 'tina-code-snapshot-v1', files: rows, sha256: hash(JSON.stringify(rows)),
    sourceSha256: hash(JSON.stringify(rows.filter(row => !row.path.startsWith('runtime/')))), runtimeSha256: subset('runtime/'),
    marketSha256: subset('market/'), fileCount: rows.length };
}

/** Full deployment gate; a successful restart phase alone can never satisfy it. */
export function fullMaxAcceptanceReceipt(report, checkpoint, hardRestart, snapshotBefore, snapshotAfter) {
  const phases = requiredPhases.map(name => {
    const result = report.phases.findLast(row => row.name === name);
    return { name, passed: result?.passed === true && checkpoint.completedPhases.includes(name), checks: result?.checks ?? {},
      startedAt: result?.startedAt ?? null, finishedAt: result?.finishedAt ?? null, elapsedMs: result?.elapsedMs ?? null };
  });
  const supportingPhases = report.phases.filter(row => !requiredPhases.includes(row.name))
    .map(row => ({ name: row.name, passed: row.passed, checks: row.checks, elapsedMs: row.elapsedMs,
      startedAt: row.startedAt, finishedAt: row.finishedAt }));
  const completedResponses = report.requests.filter(row => row.terminal?.event === 'response.completed');
  const checks = {
    allRequiredPhases: phases.every(row => row.passed && Object.keys(row.checks).length > 0 && Object.values(row.checks).every(value => value === true)),
    supportingPhaseChecks: supportingPhases.every(row => row.passed === true && Object.keys(row.checks ?? {}).length > 0
      && Object.values(row.checks).every(value => value === true)),
    exactWireModelEffort: report.requests.length > 0 && report.requests.every(row => row.request?.model === 'gpt-6-astra' && row.request.reasoningEffort === 'max'),
    actualReturnedModelEffort: completedResponses.length > 0 && completedResponses.every(row =>
      row.terminal.response?.model === 'gpt-6-astra' && row.terminal.response.reasoningEffort === 'max'),
    noFallbackOrUltraClaim: report.fallbackRequests === 0 && report.ultraClaim === false,
    automaticPressureCommitted: report.automaticCompaction?.passed === true
      && report.automaticCompaction.maintenance?.reason === 'pressure'
      && report.automaticCompaction.maintenance?.nativeReceipt?.durable === true,
    ownedHardRestart: hardRestart?.killedBySupervisor === true && hardRestart.orderlyAppClose === false
      && hardRestart.exit?.signal === 'SIGKILL' && hardRestart.ready?.pid === hardRestart.childPid
      && hardRestart.ready?.nativeSessionId === report.nativeSessionId,
    twoDistinctProcessExecutions: report.executions.length >= 2
      && report.executions.some(row => row.pid === hardRestart?.childPid)
      && report.executions.at(-1)?.pid !== hardRestart?.childPid,
    codeStable: snapshotBefore?.sha256 === snapshotAfter?.sha256 && Boolean(snapshotBefore?.sha256)
      && report.executions.every(row => row.codeSnapshotSha256 === snapshotBefore.sha256
        && row.finalCodeSnapshotSha256 === snapshotBefore.sha256)
      && hardRestart?.ready?.codeSnapshotSha256 === snapshotBefore.sha256,
    finalShutdownComplete: report.shutdownCompleted === true && !report.shutdownError
      && report.executions.at(-1)?.shutdownCompleted === true,
    noUnresolvedFailure: !report.failure && !report.supervisorFailure && report.executions.at(-1)?.exitCode === 0,
  };
  return { kind: 'tina-gpt-max-full-acceptance-v1', version: 1, finishedAt: new Date().toISOString(),
    passed: Object.values(checks).every(Boolean), plan: { model: 'gpt-6-astra', effort: 'max', requiredPhases },
    checks, phases, supportingPhases, nativeSessionId: report.nativeSessionId, contextPolicy: report.plan.contextPolicy,
    source: { sha256: snapshotAfter.sha256, sourceSha256: snapshotAfter.sourceSha256,
      runtimeSha256: snapshotAfter.runtimeSha256, marketSha256: snapshotAfter.marketSha256, files: snapshotAfter.fileCount,
      manifest: 'code-snapshot.json' },
    hardRestart, automaticCompaction: { checks: report.automaticCompaction?.checks,
      maintenance: report.automaticCompaction?.maintenance, initialWindow: report.automaticCompaction?.initialMemory?.window,
      finalWindow: report.automaticCompaction?.finalMemory?.window },
    requests: { count: report.requests.length, completed: completedResponses.length,
      errors: report.requests.filter(row => row.failure || row.http?.status >= 400 || ['response.failed', 'response.incomplete'].includes(row.terminal?.event)).length,
      requestedModels: [...new Set(report.requests.map(row => row.request.model))],
      requestedEfforts: [...new Set(report.requests.map(row => row.request.reasoningEffort))],
      actualModels: [...new Set(completedResponses.map(row => row.terminal.response.model))],
      actualEfforts: [...new Set(completedResponses.map(row => row.terminal.response.reasoningEffort))] },
    shutdown: { finalComplete: report.shutdownCompleted === true, error: report.shutdownError ?? null,
      beforeRestartOrderlyClose: false }, detailReport: 'result.json' };
}
