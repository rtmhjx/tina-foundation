/** Reviewed source extensions, one explicit target, verify-all before mutation. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, readdir, mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeComponents, nativePackageName } from './native-components.mjs';

const exec = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '..');
const args = process.argv.slice(2);
const runtimeArg = args.find(value => value.startsWith('--runtime='));
if (!runtimeArg) throw new Error('Supply --runtime=<explicit isolated DSH directory>. Default action is a read-only plan.');
if (args.some(arg => !['--apply', '--rollback', '--plan', '--upgrade'].includes(arg) && !arg.startsWith('--runtime='))) {
  throw new Error('Supported arguments: --runtime=<path>, --plan, --apply, --rollback, --upgrade.');
}
const upgrade = args.includes('--upgrade');
const mode = args.includes('--apply') ? 'apply' : args.includes('--rollback') ? 'rollback' : 'plan';
if (args.includes('--apply') && args.includes('--rollback')) throw new Error('Choose one operation.');
if (upgrade && mode === 'rollback') throw new Error('--upgrade cannot be combined with --rollback.');
const runtime = await realpath(resolve(runtimeArg.slice('--runtime='.length)));
const definitions = Object.entries(nativeComponents).map(([component, directory]) => ({ component, directory }));
async function run(component, operation) {
  const result = await exec(process.execPath, [join(scripts, 'install-host-session-controller.mjs'),
    '--runtime=' + runtime, '--component=' + component, ...(operation ? ['--' + operation] : []),
    ...(upgrade ? ['--upgrade'] : [])],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout.trim());
}
const plan = [];
// No file is modified until every selected package and payload has passed its exact baseline check.
for (const definition of definitions) {
  const build = JSON.parse(await readFile(join(root, 'upstream', definition.directory, 'BUILD.json'), 'utf8'));
  const current = await run(definition.component);
  plan.push({ ...definition, package: build.package, baselineSha256: build.baselineSha256,
    overlaySha256: build.overlaySha256, currentSha256: current.sha256,
    state: current.sha256 === build.overlaySha256 ? 'installed' : current.upgradeFromSha256 ? 'upgrade' : 'baseline' });
}

async function packageFiles(packageDir, prefix = '') {
  const files = new Map();
  for (const entry of await readdir(join(packageDir, prefix), { withFileTypes: true })) {
    if (!prefix && entry.name === 'node_modules') continue;
    const relative = join(prefix, entry.name);
    const path = resolve(packageDir, relative);
    if (!path.startsWith(packageDir + sep)) throw new Error('Package transaction path escapes selected runtime.');
    if (entry.isDirectory()) for (const row of await packageFiles(packageDir, relative)) files.set(...row);
    else if (entry.isFile()) files.set(relative, await readFile(path));
    else throw new Error('Unexpected link in native package transaction: ' + relative);
  }
  return files;
}

async function snapshotPackage(component) {
  const directory = await realpath(join(runtime, 'node_modules', nativePackageName(component)));
  if (!directory.startsWith(runtime + sep)) throw new Error('Package transaction escapes selected runtime.');
  return { directory, files: await packageFiles(directory) };
}

async function restorePackage(snapshot) {
  const current = await packageFiles(snapshot.directory);
  for (const path of current.keys()) if (!snapshot.files.has(path)) await unlink(join(snapshot.directory, path));
  for (const [path, bytes] of snapshot.files) {
    await mkdir(dirname(join(snapshot.directory, path)), { recursive: true });
    await writeFile(join(snapshot.directory, path), bytes);
  }
  const restored = await packageFiles(snapshot.directory);
  if (restored.size !== snapshot.files.size
      || [...snapshot.files].some(([path, bytes]) => !restored.get(path)?.equals(bytes))) {
    throw new Error('Native upgrade rollback did not restore the complete previous payload.');
  }
}
if (mode === 'plan') {
  console.log(JSON.stringify({ mode, runtime, verified: true, changes: false, packages: plan }, null, 2));
} else {
  const operations = (mode === 'rollback' ? [...plan].reverse() : plan)
    .filter(row => mode === 'apply' ? row.state !== 'installed' : row.state === 'installed');
  // Upgrade compensation must restore the previous overlay, not downgrade
  // successfully upgraded components to their original stock baselines.
  const snapshots = upgrade ? await Promise.all(operations.map(row => snapshotPackage(row.component))) : [];
  const completed = [];
  try {
    for (const row of operations) {
      await run(row.component, mode);
      completed.push(row);
    }
  } catch (cause) {
    const compensationErrors = [];
    if (upgrade) {
      for (const snapshot of snapshots.reverse()) {
        try { await restorePackage(snapshot); }
        catch (error) { compensationErrors.push({ package: snapshot.directory, error: String(error) }); }
      }
    } else for (const row of completed.reverse()) {
      try { await run(row.component, mode === 'apply' ? 'rollback' : 'apply'); }
      catch (error) { compensationErrors.push({ component: row.component, error: String(error.stderr ?? error) }); }
    }
    throw Object.assign(new Error('Compatibility operation failed; completed changes were reversed where possible.', { cause }),
      { compensationErrors });
  }
  const after = [];
  for (const row of plan) after.push({ component: row.component, ...(await run(row.component)) });
  console.log(JSON.stringify({ mode, runtime, verified: true, changes: operations.length > 0,
    restartRequired: operations.length > 0, packages: after,
    client: 'The enabled main plugin supplies its own browser module through dsh.client; reload the native tab after loading.' }, null, 2));
}
