import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const release = path.join(root, 'artifacts/tina-cortico-fusion-20261113-r4');
const read = file => JSON.parse(fs.readFileSync(file));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const install = read(path.join(release, 'INSTALLATION_RECEIPT.json'));
const verify = read(path.join(release, 'PACKAGE_VERIFICATION.json'));
const suite = read(path.join(root, 'docs/FUSION4_ROOT_TEST_RESULT.json'));
const official = read(path.join(root, 'docs/FUSION4_OFFICIAL_RESULT.json'));
const benchmarkFile = path.join(root, '.tina-fusion-dev/release-efficiency-r4-final/benchmark-receipt.json');
const bench = read(benchmarkFile);
const sourceFilesMatch = suite.files.filter(row => row.file !== 'package.json')
  .every(row => hash(path.join(root, row.file)) === hash(path.join(release, row.file)));
const developmentManifest = read(path.join(root, 'package.json'));
const releaseManifest = read(path.join(release, 'package.json'));
for (const field of ['name', 'version', 'type', 'exports', 'dependencies', 'engines']) assert.deepEqual(releaseManifest[field], developmentManifest[field]);
assert.ok(install.complete && verify.complete && suite.failed === 0 && official.status === 'passed' && bench.status === 'PASS' && sourceFilesMatch);
const variants = official.variants.map(variant => {
  const totals = variant.usageProjection.totals;
  return { mode: variant.mode, calls: totals.calls, uncachedInput: totals.uncachedInputTokens,
    cachedInput: totals.cacheReadTokens, output: totals.outputTokens,
    totalTokens: totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens,
    scenarioElapsedMs: variant.measurements.totalScenarioElapsedMs, cleanup: variant.cleanup };
});
const report = { format: 1, productVersion: developmentManifest.version, status: 'complete', recordedAt: new Date().toISOString(),
  releaseDirectory: release, sourceFilesMatchValidatedCheckout: sourceFilesMatch,
  manifestSemanticsMatch: true, packageScriptsChangedForStandaloneInstall: true,
  rootChecks: { passed: suite.passed, failed: suite.failed, originalSkipped: suite.skipped,
    supplementalLegacyPassed: suite.supplementalLegacyChecks.passed, previouslySkippedCovered: 2 },
  official: { status: official.status, observedNotControlledModelRanking: true, variants,
    sourceCredentialUnchanged: official.sourceCredentialIntegrity.unchanged, prices: null },
  installedRelease: { offline: install.offline, commands: install.commands.map(command => ({ command: command.command, exitCode: command.exitCode })),
    verifiedFiles: verify.verifiedFiles, manifestSha256: verify.payloadIntegrity.manifestSha256,
    sourceBuilt: verify.sourceBuilt, importedModulesIsolated: verify.importedModulesIsolated,
    sharedBackend: verify.sharedBackend, credentialConfigured: verify.credentialConfigured, coreReactivation: verify.coreReactivation },
  installedReleaseFeatureBenchmark: { status: bench.status, summary: bench.summary, receiptSha256: hash(benchmarkFile) },
  earlierAttempt: { installRejectedBeforeManifestWasReady: true, sourceFilesModified: false,
    failedLog: '.tina-fusion-dev/fusion4-install.log', finalInstallComplete: true },
  boundaries: ['Official live provider: DeepSeek only; no prices fabricated',
    'All model tasks and Memory facts synthetic', 'Other real model/provider performance is not established by the deterministic fixture',
    'Optional desktop shell, external account login and long-duration production soak are outside this release gate'],
  evidence: [...['FUSION4_ROOT_TEST_RESULT.json', 'FUSION4_OFFICIAL_RESULT.json', 'FUSION4_EFFICIENCY_RESULT.json', 'FUSION4_UI_RESULT.json']
    .map(file => ({ file: 'docs/' + file, sha256: hash(path.join(root, 'docs', file)) })),
  ...['INSTALLATION_RECEIPT.json', 'PACKAGE_VERIFICATION.json'].map(file => ({ file, sha256: hash(path.join(release, file)) }))] };
const bytes = JSON.stringify(report, null, 2) + '\n';
fs.writeFileSync(path.join(root, 'docs/FUSION4_RELEASE_RESULT.json'), bytes);
fs.writeFileSync(path.join(release, 'FUSION4_RELEASE_RESULT.json'), bytes);
console.log(JSON.stringify({ status: report.status, verifiedFiles: verify.verifiedFiles, sourceFilesMatch, variants }));
