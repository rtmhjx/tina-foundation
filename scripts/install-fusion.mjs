import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relocateDshRuntime } from './stage-dsh-runtime.mjs';
import { beginPackageMaterialization, finishPackageMaterialization } from './fusion-package-integrity.mjs';
import { fusionNpmCli, readFusionMemoryBundle } from './setup-fusion-memory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.argv.includes('--offline');
const development = process.argv.includes('--development');
const stateOption = process.argv.indexOf('--state');
if (stateOption >= 0 && (!process.argv[stateOption + 1] || process.argv[stateOption + 1].startsWith('--'))) throw new Error('--state requires a directory.');
const stateDir = resolve(stateOption < 0 ? process.env.CORTICO_FUSION_STATE ?? join(root, '.tina-fusion-dev', 'app') : process.argv[stateOption + 1]);
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major !== 24 || minor < 12) throw new Error('This build requires Node.js 24.12 or later within 24.x.');
const npmCli = fusionNpmCli();
const commands = [];
let complete = false;
let payloadIntegrity;
let memoryBot;
function run(file, args, cwd) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(file, args, {
    cwd, stdio: 'inherit', shell: process.platform === 'win32' && file.endsWith('.cmd'),
  });
  commands.push({ command: [file, ...args], cwd, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Install/build command failed with exit code ' + result.status);
}
try {
  const materialization = await beginPackageMaterialization(root, { allowMissing: development });
  payloadIntegrity = materialization.report;
  // Moved Windows junctions must point into this package before either native compiler runs.
  await relocateDshRuntime(join(root, 'runtime', 'dsh-0.1.5-rc.2'));
  run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', '.install-cache/npm',
    ...offline ? ['--offline'] : []], root);
  const cortico = join(root, 'upstream', 'cortico');
  run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['install', '--frozen-lockfile', '--package-import-method=copy', ...offline ? ['--offline'] : []], cortico);
  run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build:web'], cortico);
  run(process.execPath, [join(root, 'scripts', 'build-fusion-native.mjs')], root);
  payloadIntegrity = await finishPackageMaterialization(materialization);
  const {lock:memoryLock} = await readFusionMemoryBundle(root);
  memoryBot = {package:memoryLock.package, version:memoryLock.version, archiveSha256:memoryLock.archiveSha256, stateDir};
  run(process.execPath, ['--expose-internals', '--import', pathToFileURL(join(root, 'upstream', 'cortico', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
    join(root, 'scripts', 'setup-fusion-memory.mjs'), '--state', stateDir], root);
  complete = true;
} finally {
  const lock = JSON.parse(await readFile(join(root, 'vendor', 'cortico-source-lock.json'), 'utf8'));
  const nativeLock = JSON.parse(await readFile(join(root, 'vendor', 'dsh-agent-loop-source-lock.json'), 'utf8'));
  const uploadsLock = JSON.parse(await readFile(join(root, 'vendor', 'dsh-file-upload-source-lock.json'), 'utf8'));
  const toolsLock = JSON.parse(await readFile(join(root, 'vendor', 'dsh-tools-source-lock.json'), 'utf8'));
  await writeFile(join(root, 'INSTALLATION_RECEIPT.json'), JSON.stringify({
    format: 1, node: process.version, offline, development, sourceTreeSha256: lock.sourceTreeSha256, commands,
    nativeSourceTreeSha256: nativeLock.sourceTreeSha256,
    fileUploadsSourceTreeSha256: uploadsLock.sourceTreeSha256, toolsSourceTreeSha256: toolsLock.sourceTreeSha256, payloadIntegrity, memoryBot, complete,
  }, null, 2) + '\n');
}
