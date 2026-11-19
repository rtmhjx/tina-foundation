import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const productRoot = resolve(import.meta.dirname, '..');
const marker = '.fusion-memory-setup.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function fusionNpmCli() {
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js', '/usr/share/nodejs/npm/bin/npm-cli.js'].find(path => path?.endsWith('npm-cli.js') && existsSync(path));
  if (!cli) throw new Error('The npm CLI shipped with Node.js is required.');
  return cli;
}

/** Verify the shipped package before either packaging or first-run installation. */
export async function readFusionMemoryBundle(root = productRoot) {
  const lock = JSON.parse(await readFile(join(root, 'vendor', 'self-mem-lock.json'), 'utf8'));
  if (lock.format !== 1 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(lock.package ?? '')
    || typeof lock.version !== 'string' || !lock.version || !/^[a-z0-9][a-z0-9._-]*\.tgz$/i.test(lock.archive ?? '')
    || !/^[a-f0-9]{64}$/.test(lock.archiveSha256 ?? '')) throw new Error('Invalid self-mem source lock.');
  const archive = join(root, 'vendor', lock.archive);
  if (hash(await readFile(archive)) !== lock.archiveSha256) throw new Error('Self-mem package hash mismatch.');
  const pkg = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], {encoding:'utf8', windowsHide:true}));
  if (pkg.name !== lock.package || pkg.version !== lock.version || pkg.type !== 'module' || pkg.cortico?.kind !== 'bot') {
    throw new Error('Self-mem package identity or Bot manifest differs from the source lock.');
  }
  if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) {
    throw new Error('The bundled self-mem Bot must contain its runtime dependencies.');
  }
  return {lock, archive};
}

async function stateCondition(stateDir) {
  try {
    const entry = await lstat(stateDir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return 'existing';
    return (await readdir(stateDir)).length ? 'existing' : 'empty';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** Install the locked Bot through npm and Cortico's loader, preserving every existing deployment. */
export async function setupFusionMemory({root = productRoot, stateDir = process.env.CORTICO_FUSION_STATE ?? join(root, '.tina-fusion-dev', 'app')} = {}) {
  root = resolve(root);
  stateDir = resolve(stateDir);
  if (await stateCondition(stateDir) === 'existing') return {status:'preserved', stateDir, reason:'existing-state'};
  const {lock, archive} = await readFusionMemoryBundle(root);
  await mkdir(dirname(stateDir), {recursive:true});
  // Failed installs remain reviewable beside the target; a retry starts a fresh candidate.
  // The actual state is not populated until npm and the official Bot loader both succeed.
  const staging = await mkdtemp(join(dirname(stateDir), '.' + basename(stateDir) + '.self-mem-'));
  const extensions = join(staging, 'extensions');
  const receipt = {format:1, status:'installing', stateDir, staging, startedAt:new Date().toISOString(),
    package:lock.package, version:lock.version, archiveSha256:lock.archiveSha256};
  const record = () => writeFile(join(staging, marker), JSON.stringify(receipt, null, 2) + '\n');
  await record();
  try {
    await mkdir(extensions);
    await writeFile(join(extensions, 'package.json'), JSON.stringify({name:'cortico-extensions', private:true, dependencies:{}}, null, 2) + '\n');
    const args = [fusionNpmCli(), 'install', archive, '--offline', '--ignore-scripts', '--legacy-peer-deps',
      '--no-audit', '--no-fund', '--save-exact', '--cache', join(root, '.install-cache', 'npm')];
    const installed = spawnSync(process.execPath, args, {cwd:extensions, encoding:'utf8', windowsHide:true});
    receipt.installExitCode = installed.status;
    if (installed.error) throw installed.error;
    if (installed.status !== 0) throw new Error('Self-mem offline npm install failed: ' + (installed.stderr || installed.stdout).trim());
    const pkgDir = join(extensions, 'node_modules', ...lock.package.split('/'));
    const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
    if (pkg.name !== lock.package || pkg.version !== lock.version) throw new Error('Installed self-mem package identity mismatch.');
    const {selectFusionBot} = await import('../src/fusion-bot-selection.mjs');
    const selected = await selectFusionBot({stateDir:staging, bot:lock.package, corticoRoot:join(root, 'upstream', 'cortico')});
    if (selected.source !== 'extension' || selected.botPackage?.name !== lock.package) throw new Error('Self-mem was not selected through the extension loader.');
    await mkdir(selected.deployDir, {recursive:true});
    await writeFile(join(selected.deployDir, 'config.json'), JSON.stringify({worlds:{console:{enabled:true}}}, null, 2) + '\n', {flag:'wx'});
    receipt.botId = selected.definition.id;
    receipt.status = 'complete';
    receipt.finishedAt = new Date().toISOString();
    await record();
    const condition = await stateCondition(stateDir);
    if (condition === 'existing') throw new Error('The target state changed during setup; its files were preserved.');
    if (condition === 'empty') await rmdir(stateDir);
    await rename(staging, stateDir);
    return {...receipt, staging:undefined, receipt:join(stateDir, marker)};
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.message : String(error);
    receipt.finishedAt = new Date().toISOString();
    await record();
    throw new Error('Self-mem setup failed; the target state was not initialized. Evidence: ' + join(staging, marker), {cause:error});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--state' || !args[1])) throw new Error('Usage: setup-fusion-memory.mjs [--state directory]');
  console.log(JSON.stringify(await setupFusionMemory(args.length ? {stateDir:args[1]} : {})));
}
