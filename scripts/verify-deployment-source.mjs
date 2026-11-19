/** Bind a deployed release to the exact code used by a completed real Max run. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyPackagePayload } from './fusion-package-integrity.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const path = relative(root, file); return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); };
const sourceRoots = ['src', 'upstream/cortico/src', 'vendor/host-self-mem/package',
  ...['dsh-agent-loop', 'dsh-compaction-basic', 'dsh-token-meter', 'dsh-session', 'dsh-session-controller',
    'dsh-tools', 'dsh-file-upload', 'dsh-host-client'].map(name => 'upstream/' + name + '/src')];
const sourceFiles = ['vendor/self-mem-lock.json', 'vendor/self-mem-build-manifest.json'];
const metadataFiles = ['runtime-manifest.json', 'runtime-links.json', 'package.json'];
const requiredChecks = ['allRequiredPhases', 'supportingPhaseChecks', 'exactWireModelEffort', 'actualReturnedModelEffort',
  'noFallbackOrUltraClaim', 'automaticPressureCommitted', 'ownedHardRestart', 'twoDistinctProcessExecutions',
  'codeStable', 'finalShutdownComplete', 'noUnresolvedFailure'];
const requiredRuntimePackages = ['cordis', 'dsh-agent-loop', 'dsh-compaction-basic', 'dsh-token-meter', 'dsh-session',
  'dsh-api-session-controller', 'dsh-tools', 'dsh-client-file-upload', 'dsh-session-persistence-jsonl',
  'dsh-session-format', 'dsh-session-format-catalog', 'dsh-llm'];

function safePath(path) {
  assert.ok(typeof path === 'string' && path && !isAbsolute(path) && !/[\\:\0]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe snapshot path.');
  return path;
}
async function checkedBytes(root, path) {
  const target = await realpath(join(root, safePath(path)));
  assert.ok(inside(root, target), 'Code file escapes its declared release or Provider root.');
  return readFile(target);
}
async function fileNames(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await fileNames(directory, path + '/'));
    else if (entry.isFile()) result.push(path);
    else throw new Error('Source tree contains an unexpected link: ' + path);
  }
  return result.sort();
}
function exactFile(bytes, row) {
  assert.equal(bytes.length, row.bytes, 'Acceptance file size mismatch: ' + row.path);
  assert.equal(hash(bytes), row.sha256, 'Acceptance file hash mismatch: ' + row.path);
}
function verifySnapshot(snapshot, acceptance) {
  assert.equal(snapshot.kind, 'tina-code-snapshot-v1');
  assert.ok(Array.isArray(snapshot.files) && snapshot.files.length > 0);
  const seen = new Set();
  for (const row of snapshot.files) {
    safePath(row.path);
    assert.ok(!seen.has(row.path), 'Duplicate snapshot path.'); seen.add(row.path);
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && /^[a-f0-9]{64}$/.test(row.sha256));
  }
  assert.equal(hash(JSON.stringify(snapshot.files)), snapshot.sha256, 'Acceptance snapshot checksum mismatch.');
  const subset = predicate => hash(JSON.stringify(snapshot.files.filter(predicate)));
  assert.equal(subset(row => !row.path.startsWith('runtime/')), snapshot.sourceSha256);
  assert.equal(subset(row => row.path.startsWith('runtime/')), snapshot.runtimeSha256);
  assert.equal(subset(row => row.path.startsWith('market/')), snapshot.marketSha256);
  assert.equal(snapshot.fileCount, snapshot.files.length);
  assert.equal(acceptance.kind, 'tina-gpt-max-full-acceptance-v1');
  assert.equal(acceptance.passed, true, 'Only a completed real Max acceptance may authorize release identity.');
  assert.equal(acceptance.plan?.model, 'gpt-6-astra');
  assert.equal(acceptance.plan?.effort, 'max');
  assert.ok(Object.keys(acceptance.checks ?? {}).length > 0 && Object.values(acceptance.checks).every(value => value === true));
  for (const key of requiredChecks) assert.equal(acceptance.checks[key], true, 'Required real acceptance check missing: ' + key);
  for (const phase of ['chat', 'rp', 'read', 'compaction', 'restart']) {
    const result = acceptance.phases?.find(row => row.name === phase);
    assert.equal(result?.passed, true, 'Missing completed phase: ' + phase);
    assert.ok(Object.keys(result.checks ?? {}).length > 0 && Object.values(result.checks).every(value => value === true));
  }
  for (const key of ['sha256', 'sourceSha256', 'runtimeSha256', 'marketSha256']) assert.equal(acceptance.source?.[key], snapshot[key]);
  assert.equal(acceptance.source.files, snapshot.fileCount);
}

/** Read code only from an explicit independent new state; never inspect account files. */
async function marketRoots(stateRoot) {
  stateRoot = await realpath(resolve(stateRoot));
  const extensions = await realpath(join(stateRoot, 'extensions'));
  assert.ok(inside(stateRoot, extensions), 'Provider extensions escape the new deployment state.');
  const chatgpt = await realpath(join(extensions, 'node_modules/cortico-provider-chatgpt'));
  assert.ok(inside(extensions, chatgpt));
  const require = createRequire(join(chatgpt, 'package.json'));
  let coo = dirname(require.resolve('cortico-provider-coo'));
  for (;;) {
    try { if (JSON.parse(await readFile(join(coo, 'package.json'))).name === 'cortico-provider-coo') break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(coo); if (parent === coo) throw new Error('Installed coo Provider package root missing.'); coo = parent;
  }
  coo = await realpath(coo);
  assert.ok(inside(extensions, coo), 'Provider dependency points outside the new independent extension tree.');
  assert.equal(JSON.parse(await readFile(join(chatgpt, 'package.json'))).name, 'cortico-provider-chatgpt');
  return { stateRoot, packages: new Map([['cortico-provider-chatgpt', chatgpt], ['cortico-provider-coo', coo]]) };
}

export async function verifyDeploymentSource({ releaseRoot, stateRoot, snapshotFile, acceptanceFile, outputFile } = {}) {
  const root = await realpath(resolve(releaseRoot));
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).name, 'tina-cordis', 'This gate targets the standalone deployment; host packages require a selected external runtime.');
  const snapshotBytes = await readFile(resolve(snapshotFile));
  const acceptanceBytes = await readFile(resolve(acceptanceFile));
  const snapshot = JSON.parse(snapshotBytes), acceptance = JSON.parse(acceptanceBytes);
  verifySnapshot(snapshot, acceptance);
  const integrity = await verifyPackagePayload(root);
  const currentManifestBytes = await readFile(join(root, 'PACKAGE_MANIFEST.json'));
  let originalManifestBytes;
  try { originalManifestBytes = await readFile(join(root, 'PACKAGE_MANIFEST.original.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; originalManifestBytes = currentManifestBytes; }
  const rows = new Map(snapshot.files.map(row => [row.path, row]));
  const compared = [];
  const excluded = [];
  for (const row of snapshot.files.filter(row => row.path.startsWith('src/legacy/'))) {
    excluded.push({ path: row.path, reason: 'Legacy prototypes are intentionally excluded from both product distributions.' });
  }
  for (const prefix of sourceRoots) {
    const expected = snapshot.files.filter(row => row.path.startsWith(prefix + '/') && !row.path.startsWith('src/legacy/'));
    assert.ok(expected.length > 0, 'Acceptance source inventory missing: ' + prefix);
    const actualNames = await fileNames(join(root, prefix));
    assert.deepEqual(actualNames, expected.map(row => row.path.slice(prefix.length + 1)).sort(), 'Shipped source file allowlist differs from accepted code: ' + prefix);
    for (const row of expected) { exactFile(await checkedBytes(root, row.path), row); compared.push(row.path); }
  }
  for (const path of sourceFiles) {
    const row = rows.get(path); assert.ok(row, 'Acceptance SelfMem lock missing.');
    exactFile(await checkedBytes(root, path), row); compared.push(path);
  }
  const sourceManifest = JSON.parse(await readFile(join(root, 'FUSION-SOURCE.json')));
  assert.equal(sourceManifest.legacyIncluded, false);
  assert.equal(sourceManifest.sourceTreeSha256, hash(JSON.stringify(sourceManifest.files)), 'Shared source manifest checksum mismatch.');
  const currentModules = snapshot.files.filter(row => row.path.startsWith('src/') && !row.path.startsWith('src/legacy/'));
  assert.deepEqual(sourceManifest.files.map(row => row.path).sort(), currentModules.map(row => row.path).sort());
  for (const row of sourceManifest.files) assert.deepEqual({ path: row.path, bytes: row.bytes, sha256: row.sha256 }, rows.get(row.path));

  const runtime = await realpath(join(root, 'runtime/dsh-0.1.5-rc.2'));
  assert.ok(inside(root, runtime));
  const require = createRequire(join(runtime, 'package.json'));
  const nativeRows = snapshot.files.filter(row => row.path.startsWith('runtime/@deepseek-ai/'));
  const packageNames = [...new Set(nativeRows.map(row => row.path.split('/')[2]))];
  assert.deepEqual(packageNames.sort(), [...requiredRuntimePackages].sort(), 'Required native runtime inventory differs.');
  const runtimePackages = [];
  for (const name of packageNames) {
    const entry = require.resolve('@deepseek-ai/' + name);
    const lib = await realpath(dirname(entry));
    const packageRoot = dirname(lib);
    assert.ok(inside(runtime, packageRoot), 'Runtime dependency escapes the selected release: ' + name);
    const prefix = 'runtime/@deepseek-ai/' + name + '/';
    const expected = nativeRows.filter(row => row.path.startsWith(prefix));
    const expectedLib = expected.filter(row => row.path.startsWith(prefix + 'lib/'));
    assert.deepEqual(await fileNames(lib), expectedLib.map(row => row.path.slice((prefix + 'lib/').length)).sort(), 'Native library file allowlist differs: ' + name);
    for (const row of expected) { exactFile(await checkedBytes(packageRoot, row.path.slice(prefix.length)), row); compared.push(row.path); }
    runtimePackages.push({ name: '@deepseek-ai/' + name, verifiedFiles: expected.length, resolved: relative(root, packageRoot).split(sep).join('/') });
  }
  const runtimeMetadata = [];
  for (const name of metadataFiles) {
    const row = rows.get('runtime/' + name); assert.ok(row, 'Acceptance runtime metadata missing: ' + name);
    const bytes = await checkedBytes(runtime, name);
    runtimeMetadata.push({ path: 'runtime/' + name, acceptanceSha256: row.sha256, releaseSha256: hash(bytes), equal: hash(bytes) === row.sha256,
      policy: 'Metadata is verified by the original package allowlist/materialization receipt; actual native libraries always require exact accepted bytes.' });
  }
  const market = await marketRoots(stateRoot);
  let marketFiles = 0;
  for (const [name, directory] of market.packages) {
    const prefix = 'market/' + name + '/';
    const expected = snapshot.files.filter(row => row.path.startsWith(prefix));
    assert.ok(expected.length > 0, 'Acceptance Provider inventory missing: ' + name);
    assert.deepEqual(await fileNames(join(directory, 'src')), expected.filter(row => row.path.startsWith(prefix + 'src/')).map(row => row.path.slice((prefix + 'src/').length)).sort());
    for (const row of expected) { exactFile(await checkedBytes(directory, row.path.slice(prefix.length)), row); compared.push(row.path); marketFiles++; }
  }
  const supporting = snapshot.files.filter(row => !compared.includes(row.path)
    && !row.path.startsWith('src/legacy/') && !metadataFiles.some(name => row.path === 'runtime/' + name));
  for (const row of supporting) {
    assert.ok(['scripts/acceptance-gpt-max.mjs', 'scripts/lib/acceptance-gpt-max-receipt.mjs',
      'artifacts/validation/native-context-build-freeze.json'].includes(row.path), 'Unclassified acceptance code path: ' + row.path);
    excluded.push({ path: row.path, reason: 'Acceptance runner or build evidence, not a shipped runtime module.' });
  }
  const report = { schema: 'tina-release-acceptance/v1', status: 'passed', verifiedAt: new Date().toISOString(),
    releaseRoot: root, stateRoot: market.stateRoot, model: 'gpt-6-astra', effort: 'max',
    acceptanceSha256: hash(acceptanceBytes), codeSnapshotFileSha256: hash(snapshotBytes), codeSnapshotSha256: snapshot.sha256,
    packageManifestSha256: hash(currentManifestBytes), originalPackageManifestSha256: hash(originalManifestBytes),
    packageIntegrity: integrity, materialization: JSON.parse(currentManifestBytes).materialization ?? null,
    exactRuntimeBytes: true, counts: { source: compared.length - nativeRows.length - marketFiles, runtime: nativeRows.length,
      market: marketFiles, compared: compared.length, excluded: excluded.length }, runtimePackages, runtimeMetadata,
    comparedFiles: compared.sort(), excluded, inputFiles: { snapshot: resolve(snapshotFile), acceptance: resolve(acceptanceFile) } };
  const target = resolve(outputFile ?? join(root, 'RELEASE-ACCEPTANCE.json'));
  assert.equal(target, join(root, 'RELEASE-ACCEPTANCE.json'), 'Release acceptance output must be the release root marker.');
  const temporary = join(root, '.release-acceptance-' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
  return report;
}

async function main() {
  const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
  const required = name => { const value = option(name); if (!value) throw new Error('--' + name + ' is required.'); return value; };
  const report = await verifyDeploymentSource({ releaseRoot: required('release'), stateRoot: required('state'),
    snapshotFile: required('snapshot'), acceptanceFile: required('acceptance') });
  console.log(JSON.stringify({ status: report.status, releaseRoot: report.releaseRoot, counts: report.counts,
    receipt: join(report.releaseRoot, 'RELEASE-ACCEPTANCE.json'), exactRuntimeBytes: report.exactRuntimeBytes }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'RELEASE_SOURCE_MISMATCH', message: error.message })); process.exitCode = 1; });
}
