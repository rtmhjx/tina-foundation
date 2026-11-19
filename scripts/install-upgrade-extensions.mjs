// Install only into a separately prepared, inactive deployment. Authentication
// migration and service activation are deliberately owned by the cutover step.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFusionMemoryBundle } from './setup-fusion-memory.mjs';
import { internalizeLegacyExtensionCode, verifyInternalizedExtensionCode } from './lib/upgrade-extension-code.mjs';

const root = resolve(import.meta.dirname, '..');
const option = key => process.argv.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || !r.startsWith('..') && !isAbsolute(r); };
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const requireNative = createRequire(join(root, 'runtime/dsh-0.1.5-rc.2/package.json'));
const yaml = requireNative('js-yaml');

async function tree(path, skipModules = false, label = '') {
  const rows = [];
  async function visit(file, at) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) rows.push({ path: at, link: await readlink(file) });
    else if (info.isDirectory()) {
      for (const child of (await readdir(file)).sort()) {
        if (child === '.git' || skipModules && child === 'node_modules') continue;
        await visit(join(file, child), at ? at + '/' + child : child);
      }
    } else if (info.isFile()) rows.push({ path: at, sha256: hash(await readFile(file)) });
    else throw new Error('Unsupported package filesystem entry');
  }
  await visit(path, label); return rows;
}

async function packageAt(requester, name) {
  const require = createRequire(join(await realpath(requester), 'package.json'));
  for (const base of require.resolve.paths(name) ?? []) {
    const path = join(base, ...name.split('/'));
    if (await exists(join(path, 'package.json'))) return realpath(path);
  }
  throw new Error('Installed dependency cannot be resolved: ' + name);
}

async function packageInventory(directory) {
  const pkg = await json(join(directory, 'package.json'));
  const packages = {};
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    const path = await realpath(join(directory, 'node_modules', ...name.split('/')));
    const manifest = await json(join(path, 'package.json'));
    packages[name] = { spec, version: manifest.version, payload: hash(JSON.stringify(await tree(path, true))) };
  }
  return packages;
}

async function verifiedArchive(archive, integrity, destinationRoot) {
  const bytes = await readFile(archive);
  if (integrity) {
    const [algorithm, expected] = integrity.split('-', 2);
    assert.equal(createHash(algorithm).update(bytes).digest('base64'), expected, 'Public package archive integrity mismatch');
  }
  const digest = hash(bytes);
  const destination = join(destinationRoot, digest);
  if (await exists(destination)) assert.equal(await realpath(destination), destination, 'Package hash directory must not be a symlink');
  if (!await exists(destination)) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    // Python validates every TarInfo before extraction; only ordinary package
    // files/directories are accepted. No links or traversal are materialized.
    execFileSync('python3', ['-c', `import pathlib,sys,tarfile
archive,destination=sys.argv[1:]
with tarfile.open(archive,'r:gz') as stream:
 members=stream.getmembers()
 for m in members:
  p=pathlib.PurePosixPath(m.name)
  if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!='package' or not (m.isfile() or m.isdir()): raise RuntimeError('Unsafe package archive member')
 stream.extractall(destination,members=members,filter='data')`, archive, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const packageDir = join(destination, 'package');
  assert.equal(await realpath(packageDir), packageDir, 'Unpacked package must be physically inside its hash directory');
  const manifest = await json(join(packageDir, 'package.json'));
  const expectedPayload = JSON.parse(execFileSync('python3', ['-c', `import hashlib,json,pathlib,sys,tarfile
rows=[]
with tarfile.open(sys.argv[1],'r:gz') as stream:
 for m in stream.getmembers():
  p=pathlib.PurePosixPath(m.name)
  if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!='package' or not (m.isfile() or m.isdir()): raise RuntimeError('Unsafe package archive member')
  if m.isfile():
   if any(x in ('node_modules','.git') for x in p.parts[1:]): raise RuntimeError('Unexpected bundled dependency layout')
   rows.append({'path':'/'.join(p.parts[1:]),'sha256':hashlib.file_digest(stream.extractfile(m),'sha256').hexdigest()})
print(json.dumps(sorted(rows,key=lambda r:r['path'])))`, archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const payload = await tree(packageDir, true);
  const sort = rows => [...rows].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual(sort(payload), sort(expectedPayload), 'Extracted package differs from the immutable archive');
  return { archive, archiveSha256: digest, packageDir, manifest, payload };
}

async function main() {
  assert.equal(process.platform, 'linux', 'This deployment helper runs on the target Linux account only.');
  assert.ok(option('--state') && option('--market-artifacts'), 'Provide --state and --market-artifacts.');
  const state = await realpath(resolve(option('--state')));
  const migration = await json(join(state, 'UPGRADE-STATE.json'));
  assert.equal(await realpath(migration.target), state);
  assert.equal(migration.providerActivated, false); assert.equal(migration.servicesStarted, false);
  assert.ok(migration.status.startsWith('prepared'), 'State preparation must have completed first.');
  const old = await realpath(migration.source);
  assert.notEqual(old, state); assert.equal(dirname(old), dirname(state));
  const extensions = join(state, 'extensions');
  assert.equal(await realpath(extensions), extensions, 'New extension root must be physically owned by the new deployment.');
  const bundle = await readFusionMemoryBundle(root);
  const marketArtifacts = await realpath(resolve(option('--market-artifacts')));
  const chatgptMeta = await json(join(marketArtifacts, 'cortico-provider-chatgpt-0.1.6.json'));
  assert.equal(chatgptMeta.name, 'cortico-provider-chatgpt'); assert.equal(chatgptMeta.version, '0.1.6');
  assert.equal(chatgptMeta.dependencies['cortico-provider-coo'], '0.3.0');
  const pins = [{ name: chatgptMeta.name, version: chatgptMeta.version, integrity: chatgptMeta.dist.integrity,
    archive: join(marketArtifacts, 'cortico-provider-chatgpt-0.1.6.tgz') },
    ...(await json(join(marketArtifacts, 'dependency-integrities.json'))).map(pin => ({ ...pin,
      archive: join(marketArtifacts, 'dependency-archives', pin.name.replace(/^@/, '').replace('/', '-') + '-' + pin.version + '.tgz') }))];
  const plan = { kind: 'tina-upgrade-extension-install-v1', state, source: old,
    api: 'Cortico ExtensionManager.install', packageManager: 'original corepack pnpm',
    additions: [{ name: chatgptMeta.name, version: chatgptMeta.version }],
    upgrades: [{ name: bundle.lock.package, version: bundle.lock.version, archiveSha256: bundle.lock.archiveSha256 }],
    cooDependency: '0.3.0', ignoreScripts: true, saveExact: true, rebuildRequiresReview: true,
    providerCredentialsCopied: false, providerActivated: false, servicesStarted: false };
  if (!process.argv.includes('--execute')) { console.log(JSON.stringify({ execute: false, plan }, null, 2)); return; }

  const packageRoot = join(state, 'extensions-packages');
  if (await exists(packageRoot)) assert.equal(await realpath(packageRoot), packageRoot);
  else await mkdir(packageRoot, { mode: 0o700 });
  const beforeOld = hash(JSON.stringify(await tree(join(old, 'extensions'))));
  const beforeProviders = hash(JSON.stringify(await tree(join(state, 'providers'))));
  const before = await packageInventory(extensions);
  const npmrcPath = join(extensions, '.npmrc');
  const registryBytes = await exists(npmrcPath) ? await readFile(npmrcPath) : null;
  const archives = new Map();
  for (const pin of pins) {
    const verified = await verifiedArchive(pin.archive, pin.integrity, packageRoot);
    assert.equal(verified.manifest.name, pin.name); assert.equal(verified.manifest.version, pin.version);
    archives.set(pin.name + '@' + pin.version, { ...verified, integrity: pin.integrity });
  }
  const memory = await verifiedArchive(bundle.archive, null, packageRoot);
  assert.equal(memory.archiveSha256, bundle.lock.archiveSha256);
  const stage = join(state, '.extensions-staging-' + randomUUID());
  await mkdir(stage, { mode: 0o700 });
  execFileSync('cp', ['-a', '--reflink=auto', '--', extensions + '/.', stage], { stdio: ['ignore', 'pipe', 'pipe'] });
  const receipt = { ...plan, status: 'installing-staging', stage, commands: [], existingPackages: Object.keys(before).sort() };
  const receiptPath = join(state, 'UPGRADE-EXTENSIONS.json');
  if (await exists(receiptPath)) assert.equal(await realpath(receiptPath), receiptPath, 'Receipt must be owned by the new state');
  const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  await save();
  let manager, published = false;
  try {
    for (const name of await readdir(stage)) if (name !== 'node_modules')
      assert.equal((await lstat(join(stage, name))).isSymbolicLink(), false, 'Staging control files must not link to old state');
    receipt.internalization = await internalizeLegacyExtensionCode({ sourceExtensions: join(old, 'extensions'),
      stage, state, skip: [bundle.lock.package, 'cortico-provider-chatgpt'] });
    await save();
    // Absolute links to the copied extension root are not safe for a staging
    // install; normal pnpm internal links are relative. Refuse rather than
    // accidentally write through a link into the previous tree.
    for (const row of await tree(stage)) if (row.link) {
      if (isAbsolute(row.link)) assert.ok(!inside(extensions, resolve(row.link))
        && !inside(join(old, 'extensions'), resolve(row.link)), 'Absolute internal extension link requires explicit relocation');
      assert.ok(inside(state, await realpath(join(stage, row.path))), 'Existing package link escapes the new state');
    }
    const { ExtensionManager, runPnpm } = await import('../upstream/cortico/src/extensions.ts');
    manager = new ExtensionManager(join(root, 'upstream/cortico'), {
      dir: stage, records: [], worlds: [], providers: [], worldOwners: {}, webUiAssets: [],
    }, { run: async (args, cwd) => {
      assert.equal(await realpath(cwd), stage);
      if (args[0] === 'rebuild') throw Object.assign(new Error('Original installer requested a build; review before continuing.'), { code: 'EXTENSION_BUILD_REVIEW_REQUIRED' });
      assert.equal(args[0], 'add', 'Only reviewed original installer add operations are permitted.');
      const exact = [...args, '--ignore-scripts', '--save-exact'];
      const command = { executable: 'corepack pnpm', args: exact, cwd };
      receipt.commands.push(command); await save();
      const result = await runPnpm(exact, cwd);
      command.exitCode = result.code;
      command.diagnosticCodes = [...new Set(result.output.match(/\b(?:ERR_[A-Z0-9_]+|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/g) ?? [])];
      await save();
      return result;
    } });
    await manager.install({ path: memory.packageDir }, 'zh');
    await manager.install({ name: 'cortico-provider-chatgpt', version: '0.1.6' }, 'zh');
    await manager.close(); manager = null;
    const after = await packageInventory(stage);
    for (const [name, original] of Object.entries(before)) if (![bundle.lock.package, 'cortico-provider-chatgpt'].includes(name)) {
      const relocated = receipt.internalization.mappings.find(row => row.name === name);
      assert.deepEqual(after[name], { ...original, spec: relocated.newSpec }, 'Existing extension payload/version changed: ' + name);
    }
    assert.deepEqual(await exists(join(stage, '.npmrc')) ? await readFile(join(stage, '.npmrc')) : null, registryBytes, 'Registry configuration changed');
    const actualMemory = await realpath(join(stage, 'node_modules', ...bundle.lock.package.split('/')));
    assert.equal(actualMemory, memory.packageDir, 'SelfMem must resolve to its stable new-state package directory.');
    assert.deepEqual(await tree(actualMemory, true), memory.payload);
    const lock = yaml.load(await readFile(join(stage, 'pnpm-lock.yaml'), 'utf8'));
    const queue = [await realpath(join(stage, 'node_modules/cortico-provider-chatgpt'))], visited = new Set(), closure = [];
    while (queue.length) {
      const directory = queue.shift(); if (visited.has(directory)) continue; visited.add(directory);
      const pkg = await json(join(directory, 'package.json'));
      const pin = archives.get(pkg.name + '@' + pkg.version);
      assert.ok(pin, 'Unreviewed Provider dependency version: ' + pkg.name + '@' + pkg.version);
      assert.deepEqual(await tree(directory, true), pin.payload, 'Installed Provider payload differs from official archive: ' + pkg.name);
      const records = Object.entries(lock.packages ?? {}).filter(([name]) => name === pkg.name + '@' + pkg.version || name.startsWith(pkg.name + '@' + pkg.version + '('));
      assert.ok(records.length > 0 && records.every(([, value]) => value.resolution?.integrity === pin.integrity), 'Provider lock integrity differs: ' + pkg.name);
      closure.push({ name: pkg.name, version: pkg.version, archiveSha256: pin.archiveSha256, integrity: pin.integrity });
      for (const name of Object.keys(pkg.dependencies ?? {})) queue.push(await packageAt(directory, name));
    }
    assert.ok(closure.some(row => row.name === 'cortico-provider-coo' && row.version === '0.3.0'));
    // No staged metadata or absolute link may become dangling after rename.
    for (const file of ['package.json', 'pnpm-lock.yaml', 'node_modules/.modules.yaml'])
      assert.ok(!(await readFile(join(stage, file), 'utf8')).includes(stage), 'Package manager retained a staging path');
    for (const row of await tree(stage)) if (row.link) {
      assert.ok(!row.link.includes(stage), 'Absolute staging symlink would become dangling');
      assert.ok(inside(state, await realpath(join(stage, row.path))), 'Resolved package link escapes the new state');
      if (!isAbsolute(row.link)) {
        const resolved = resolve(dirname(join(stage, row.path)), row.link);
        assert.ok(inside(state, resolved), 'Relative package link escapes the new state');
      }
    }
    assert.equal(hash(JSON.stringify(await tree(join(old, 'extensions')))), beforeOld, 'Original extension tree changed');
    assert.equal(hash(JSON.stringify(await tree(join(state, 'providers')))), beforeProviders, 'Existing Provider state changed');
    await verifyInternalizedExtensionCode(receipt.internalization);
    receipt.closure = closure; receipt.lockSha256 = hash(await readFile(join(stage, 'pnpm-lock.yaml')));
    receipt.previousDirectory = join(state, '.extensions-before-upgrade-' + randomUUID());
    await rename(extensions, receipt.previousDirectory);
    try { await rename(stage, extensions); published = true; }
    catch (error) { await rename(receipt.previousDirectory, extensions); throw error; }
    assert.equal(await realpath(join(extensions, 'node_modules', ...bundle.lock.package.split('/'))), memory.packageDir);
    assert.deepEqual(await packageInventory(extensions), after, 'Installed extension readback differs after rename');
    receipt.status = 'installed-not-loaded'; receipt.completedAt = new Date().toISOString();
    receipt.originalExtensionsUnchanged = true; receipt.existingProviderStateUnchanged = true;
    await save();
    console.log(JSON.stringify({ status: receipt.status, receiptPath, providerActivated: false, servicesStarted: false,
      selfMemVersion: bundle.lock.version, provider: 'cortico-provider-chatgpt@0.1.6', coo: '0.3.0' }));
  } catch (error) {
    if (published) {
      receipt.failedDirectory = join(state, '.extensions-failed-' + randomUUID());
      await rename(extensions, receipt.failedDirectory);
      await rename(receipt.previousDirectory, extensions);
      receipt.restoredPreviousExtensions = true;
    }
    receipt.status = 'failed-no-service-activation'; receipt.failure = { name: error.name, code: error.code ?? 'EXTENSION_INSTALL_FAILED' };
    await save(); throw Object.assign(new Error('Extension preparation failed; inspect the private receipt and staging tree.'), { code: receipt.failure.code });
  } finally { await manager?.close(); }
}

try { await main(); } catch (error) { console.error(JSON.stringify({ passed: false, code: error.code ?? 'EXTENSION_PREFLIGHT_FAILED' })); process.exitCode = 1; }
