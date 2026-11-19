// Materialize Linux binaries for the frozen, relocated DSH closure. This does
// not replace the separately compiled native overlay or install another DSH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'linux', 'Only Linux is supported by this installer.');
assert.equal(process.arch, 'x64', 'This frozen platform selection is Linux x64.');
assert.ok(process.report.getReport().header.glibcVersionRuntime, 'glibc is required.');
const root = await realpath(resolve(process.argv[2] ?? join(import.meta.dirname, '..')));
const runtime = join(root, 'runtime/dsh-0.1.5-rc.2');
const packages = join(runtime, 'node_modules/.packages');
const platform = join(runtime, '.platform-deps');
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = path => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
assert.equal(JSON.parse(await readFile(join(runtime, 'package.json'))).version, '0.1.5-rc.2');
assert.ok(inside(await realpath(runtime)), 'Runtime must belong to the supplied release.');

const selection = new Map([
  ['koffi', ['@koromix/koffi-linux-x64']],
  ['sharp', ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']],
  ['node-addon-require-builtin', ['node-addon-require-builtin-linux-x64-gnu']],
  ['esbuild', ['@esbuild/linux-x64']],
  ['@vscode/ripgrep', ['@vscode/ripgrep-linux-x64']],
]);
const owners = [];
const binaryOwners = [];
const dependencies = {};
for (const entry of await readdir(packages, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(packages, entry.name), manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(await readFile(manifestPath));
  if (manifest.name === '@deepseek-ai/node-addon-system-linux-x64') {
    assert.equal(manifest.version, '0.1.2', 'Unexpected frozen system native package version.');
    dependencies[manifest.name] = manifest.version;
    binaryOwners.push({ dir, name: manifest.name, version: manifest.version });
  }
  if (!selection.has(manifest.name)) continue;
  for (const name of selection.get(manifest.name)) {
    const version = manifest.optionalDependencies?.[name];
    assert.match(version ?? '', /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, 'Require an exact frozen optional dependency.');
    assert.ok(!dependencies[name] || dependencies[name] === version, 'Conflicting platform versions.');
    dependencies[name] = version;
  }
  owners.push({ dir, name: manifest.name, version: manifest.version });
}
assert.equal(new Set(owners.map(row => row.name)).size, selection.size, 'Missing frozen package owner.');
assert.equal(binaryOwners.length, 1, 'Missing frozen Linux system binary package.');
await mkdir(platform, { recursive: true });
assert.ok(inside(await realpath(platform)), 'Platform packages must remain in this release.');
const packagePath = join(platform, 'package.json');
const specification = { name: 'tina-fusion-linux-platform', version: '1.0.0', private: true, dependencies };
let changed = !existsSync(packagePath);
if (!changed) {
  const previous = JSON.parse(await readFile(packagePath));
  assert.equal(previous.name, specification.name);
  assert.equal(previous.private, true);
  for (const [name, version] of Object.entries(previous.dependencies)) assert.equal(dependencies[name], version,
    'Refusing to replace a previously pinned platform dependency.');
  changed = Object.keys(previous.dependencies).length !== Object.keys(dependencies).length;
}
if (changed) await writeFile(packagePath, JSON.stringify(specification, null, 2) + '\n');
const npmCli = [process.env.npm_execpath,
  resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  '/usr/share/nodejs/npm/bin/npm-cli.js'].find(path => path && existsSync(path));
assert.ok(npmCli, 'npm CLI not found.');
const lockPath = join(platform, 'package-lock.json');
const result = spawnSync(process.execPath, [npmCli, existsSync(lockPath) && !changed ? 'ci' : 'install',
  '--ignore-scripts', '--no-audit', '--no-fund', ...(process.argv.includes('--offline') ? ['--offline'] : [])],
{ cwd: platform, stdio: 'inherit', env: { ...process.env, npm_config_update_notifier: 'false' } });
assert.equal(result.status, 0, 'Platform dependency installation failed.');

const links = [];
// The frozen native-custom-loader resolves from its own directory, so its
// optional binary must also be visible from the runtime's common module root.
for (const owner of [...owners, { dir: runtime, name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }]) {
  for (const name of selection.get(owner.name) ?? Object.keys(dependencies).filter(name => !binaryOwners.some(row => row.name === name))) {
    const target = await realpath(join(platform, 'node_modules', name));
    const link = join(owner.dir, 'node_modules', name);
    assert.ok(inside(target) && inside(link), 'Platform link must remain inside this release.');
    await mkdir(dirname(link), { recursive: true });
    let existing;
    try { existing = await lstat(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      assert.ok(existing.isSymbolicLink(), `Refusing to replace existing non-link: ${link}`);
      assert.equal(await realpath(link), target, `Refusing to replace an unrelated link: ${link}`);
    } else await symlink(relative(dirname(link), target), link, 'dir');
    links.push({ owner: `${owner.name}@${owner.version}`, link: relative(root, link),
      target: await readlink(link), resolved: relative(root, target) });
  }
}
// The source closure already has this package's manifest and links but omitted
// its native bin directory. Fill only that missing directory; preserve its code.
for (const owner of binaryOwners) {
  const target = await realpath(join(platform, 'node_modules', owner.name, 'bin'));
  const link = join(owner.dir, 'bin');
  assert.ok(inside(target) && inside(link));
  let existing;
  try { existing = await lstat(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    assert.ok(existing.isSymbolicLink(), 'Refusing to replace an existing native bin directory.');
    assert.equal(await realpath(link), target);
  } else await symlink(relative(dirname(link), target), link, 'dir');
  links.push({ owner: `${owner.name}@${owner.version}`, link: relative(root, link),
    target: await readlink(link), resolved: relative(root, target) });
}

async function fileInventory(dir, prefix = '') {
  const files = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name), name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await fileInventory(path, name + '/'));
    else if (entry.isFile()) { const bytes = await readFile(path); files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) }); }
    else if (entry.isSymbolicLink()) files.push({ path: name, symlink: await readlink(path) });
  }
  return files;
}
const lockBytes = await readFile(lockPath), lock = JSON.parse(lockBytes);
const installed = [];
for (const [key, record] of Object.entries(lock.packages)) {
  if (!key.startsWith('node_modules/')) continue;
  const path = join(platform, key);
  if (!existsSync(path)) continue;
  const manifest = JSON.parse(await readFile(join(path, 'package.json')));
  const files = await fileInventory(path);
  installed.push({ name: manifest.name, version: manifest.version, integrity: record.integrity,
    resolved: record.resolved, contentSha256: sha(JSON.stringify(files)), files });
}

const loadOwner = name => { const dir = owners.find(row => row.name === name).dir; return createRequire(join(dir, 'package.json'))(dir); };
const checks = [];
assert.ok(loadOwner('koffi').load('libc.so.6'));
checks.push('koffi-linux-load');
const sharp = loadOwner('sharp');
assert.ok((await sharp({ create: { width: 1, height: 1, channels: 4, background: '#fff' } }).png().toBuffer()).length > 0);
checks.push('sharp-linux-png');
assert.ok(loadOwner('node-addon-require-builtin'));
checks.push('require-builtin-linux-load');
assert.ok(loadOwner('esbuild').transformSync('let x: number = 1', { loader: 'ts' }).code.includes('x'));
checks.push('esbuild-linux-transform');
const rg = loadOwner('@vscode/ripgrep');
assert.equal(spawnSync(rg.rgPath, ['--version'], { encoding: 'utf8' }).status, 0);
checks.push('ripgrep-linux-execute');
const systemEntry = (await readdir(packages)).find(name => name.startsWith('@deepseek-ai+node-addon-system@'));
assert.ok(systemEntry, 'Missing frozen system entry package.');
const flock = await import(pathToFileURL(join(packages, systemEntry, 'lib/flock.js')).href);
await assert.rejects(flock.tryLockExclusive(-1), { code: 'EBADF' });
checks.push('flock-linux-native-syscall');
const manifest = { schema: 'fusion-linux-platform/v1', status: 'passed', generatedAt: new Date().toISOString(),
  root, runtime: relative(root, runtime), platform: process.platform, arch: process.arch,
  glibc: process.report.getReport().header.glibcVersionRuntime, node: process.version,
  lifecycleScriptsExecuted: false, nativeOverlayModified: false, dependencies,
  packageLockSha256: sha(lockBytes), installerSha256: sha(await readFile(import.meta.filename)),
  links, installed, checks };
await writeFile(join(platform, 'PLATFORM-INSTALL.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ status: manifest.status, dependencies, checks, links: links.length,
  manifest: join(platform, 'PLATFORM-INSTALL.json') }, null, 2));
