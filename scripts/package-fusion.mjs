import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relocateDshRuntime } from './stage-dsh-runtime.mjs';
import { releaseReadme } from './fusion-release-readme.mjs';
import { readFusionMemoryBundle } from './setup-fusion-memory.mjs';
import { copyCurrentSources, nativeSourceDirectories } from './fusion-distribution.mjs';
import { verifyCanonicalSelfMem } from './package-self-mem.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {lock:memoryLock} = await readFusionMemoryBundle(root);
const canonicalMemory = await verifyCanonicalSelfMem(root);
if (memoryLock.canonicalManifestSha256 !== canonicalMemory.canonicalManifestSha256 || memoryLock.version !== canonicalMemory.pkg.version) {
  throw new Error('Standalone memory archive is stale; run scripts/package-self-mem.mjs from the reviewed canonical source.');
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = path => path.split(sep).join('/');
const json = path => readFile(path, 'utf8').then(JSON.parse);
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const destination = resolve(process.argv[2] ?? join(root, 'artifacts', 'tina-cortico-fusion-' + timestamp));
if (destination === root || root.startsWith(destination + sep)) throw new Error('Package target must not contain the working project.');
if (destination.startsWith(root + sep) && !destination.startsWith(join(root, 'artifacts') + sep)) {
  throw new Error('In-project packages must be written under artifacts.');
}
try { await lstat(destination); throw new Error('Package target must be a new directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(destination, { recursive: true });

async function copyFile(path) {
  if (isAbsolute(path) || path.split(/[/\\]/).includes('..')) throw new Error('Unsafe package path.');
  await mkdir(dirname(join(destination, path)), { recursive: true });
  await cp(join(root, path), join(destination, path), { recursive: true, dereference: true });
}
async function copyPublicTree(path) {
  const source = join(root, path);
  await mkdir(join(destination, path), { recursive: true });
  await cp(source, join(destination, path), {
    recursive: true, dereference: true,
    filter: file => {
      const part = posix(relative(source, file));
      return !/(^|\/)(?:node_modules|\.git|deployments|\.credentials(?:\..*)?|\.env(?:$|\.(?!example$)))(\/|$)/.test(part);
    },
  });
}

for (const path of ['package.json', 'package-lock.json', 'cordis.yml', 'ARCHITECTURE.md']) await copyFile(path);
const canonicalSource = await copyCurrentSources(root, destination);
await copyPublicTree('docs');
await copyPublicTree('ops');
// Keep only referenced vendor archives and their provenance, not every historic
// package version that happens to exist in the development checkout.
const rootPackage = await json(join(root, 'package.json'));
const vendorFiles = new Set(Object.values(rootPackage.dependencies ?? {}).filter(value => value.startsWith('file:vendor/')).map(value => value.slice(5)));
for (const item of await readdir(join(root, 'vendor'), { withFileTypes: true })) {
  if (!item.isFile() || !/\.(?:json|patch)$/.test(item.name)) continue;
  const path = 'vendor/' + item.name;
  vendorFiles.add(path);
  if (!item.name.endsWith('.json')) continue;
  const metadata = await json(join(root, path));
  for (const [key, value] of Object.entries(metadata)) {
    if (!/archive$/i.test(key) || typeof value !== 'string') continue;
    if (!/^[A-Za-z0-9._-]+\.tgz$/.test(value)) throw new Error('Unsafe vendor archive reference.');
    vendorFiles.add('vendor/' + value);
  }
}
for (const path of [...vendorFiles].sort()) await copyFile(path);
await copyPublicTree('vendor/host-self-mem');
await mkdir(join(destination, 'docs'), { recursive: true });
await cp(join(root, 'README.md'), join(destination, 'docs', 'PROJECT_README.md'));
for (const path of ['scripts/stage-dsh-runtime.mjs', 'scripts/verify-dsh-runtime.mjs', 'scripts/install-fusion.mjs', 'scripts/fusion-package-integrity.mjs',
  'scripts/setup-fusion-memory.mjs', 'scripts/package-self-mem.mjs', 'scripts/fusion-distribution.mjs', 'scripts/clone-native-runtime.mjs',
  'scripts/build-native-component.mjs', 'scripts/native-component-build.mjs', 'scripts/native-components.mjs', 'scripts/build-host-compat.mjs', 'scripts/build-host-session-controller.mjs',
  'scripts/install-host-compat.mjs', 'scripts/install-host-session-controller.mjs',
  'scripts/relocate-native-session.mjs', 'scripts/verify-usage-snapshot.mjs', 'scripts/verify-context-legacy.mjs',
  'scripts/install-fusion-linux-platform.mjs', 'scripts/server-upgrade-backup.py', 'scripts/prepare-upgrade-state.py',
  'scripts/verify-deployment-source.mjs', 'scripts/accept-server-upgrade.mjs',
  'scripts/install-upgrade-extensions.mjs', 'scripts/lib/upgrade-extension-code.mjs',
  'scripts/server-upgrade-route.py', 'scripts/server-world-acceptance-hold.py', 'scripts/lib/native-file-read-evidence.mjs',
  'artifacts/provider-market/cortico-provider-chatgpt-0.1.6.json', 'artifacts/provider-market/cortico-provider-chatgpt-0.1.6.tgz',
  'artifacts/provider-market/dependency-integrities.json', 'artifacts/provider-market/dependency-archives',
  'scripts/verify-fusion-package.mjs', 'scripts/clear-fusion-test-credential.mjs', 'scripts/package-fusion.mjs', 'scripts/fusion-release-readme.mjs',
  'scripts/build-fusion-native.mjs', 'scripts/build-dsh-agent-loop.mjs', 'scripts/build-dsh-file-upload.mjs',
  'scripts/build-dsh-tools.mjs', 'scripts/build-dsh-core-overlay.mjs',
  'integration/fusion-live.mjs', 'integration/fusion-autonomy-live.mjs', 'integration/fusion-autonomy-reopen-check.mjs',
  'integration/audit-autonomy-run.mjs', 'integration/audit-autonomy-native.mjs',
  'integration/fusion-final-live.mjs', 'integration/fusion-session-head-live.mjs', 'integration/fusion-continuity-live.mjs',
  'integration/fusion-upstream-rehearsal.mjs', 'integration/fusion-market-package-check.mjs', 'integration/fusion-release-cli-check.mjs',
  'integration/inspect-fusion-run.mjs', 'integration/carbon-self-mem-acceptance.mjs',
  'integration/fusion-memory-request-check.mjs', 'integration/fusion-memory-setup-check.mjs']) await copyFile(path);
for (const path of ['integration/fusion-efficiency-benchmark.mjs', 'integration/fusion-efficiency-live.mjs',
  'integration/fixtures/fusion-efficiency-plugin.mjs', 'integration/fusion-autonomy-acceptance.mjs',
  'integration/fusion-autonomy-worker.mjs', 'integration/audit-autonomy-acceptance.mjs']) await copyFile(path);

const sourceLock = await json(join(root, 'vendor', 'cortico-source-lock.json'));
const sourceArchive = join(root, 'vendor', sourceLock.archive);
if (hash(await readFile(sourceArchive)) !== sourceLock.archiveSha256) throw new Error('Cortico source archive hash mismatch.');
// Ship the current shared framework, not the older archived baseline. The
// retained source lock records upstream provenance; PACKAGE_MANIFEST records the
// exact candidate bytes including reviewed integration changes.
await copyPublicTree('upstream/cortico');
for (const name of nativeSourceDirectories) await copyPublicTree('upstream/' + name);
await copyPublicTree('upstream/dsh-host-client');
await copyFile('upstream/HOST-CORTICO-CHANGES.patch');

const runtimeRelative = join('runtime', 'dsh-0.1.5-rc.2');
const runtimeSource = join(root, runtimeRelative);
const runtimeTarget = join(destination, runtimeRelative);
const runtime = await json(join(runtimeSource, 'runtime-manifest.json'));
await mkdir(runtimeTarget, { recursive: true });
const copies = runtime.packages.flatMap(node => node.files.map(file => ({
  path: join(node.output, file.path), sha256: file.sha256,
})));
for (let offset = 0; offset < copies.length; offset += 32) {
  await Promise.all(copies.slice(offset, offset + 32).map(async file => {
    const source = resolve(runtimeSource, file.path);
    const target = resolve(runtimeTarget, file.path);
    if (!source.startsWith(runtimeSource + sep) || !target.startsWith(runtimeTarget + sep)) throw new Error('Runtime file escapes payload.');
    const content = await readFile(source);
    if (hash(content) !== file.sha256) throw new Error('Runtime file hash mismatch: ' + file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }));
}
for (const name of ['runtime-manifest.json', 'runtime-links.json']) {
  await cp(join(runtimeSource, name), join(runtimeTarget, name));
}
await relocateDshRuntime(runtimeTarget);

const manifest = await json(join(destination, 'package.json'));
manifest.scripts = {
  prestart: 'node --expose-internals --import ./upstream/cortico/node_modules/tsx/dist/loader.mjs scripts/setup-fusion-memory.mjs',
  start: 'node src/fusion-launcher.mjs',
  prefusion: 'node --expose-internals --import ./upstream/cortico/node_modules/tsx/dist/loader.mjs scripts/setup-fusion-memory.mjs',
  fusion: 'node src/fusion-launcher.mjs',
  'setup:memory': 'node --expose-internals --import ./upstream/cortico/node_modules/tsx/dist/loader.mjs scripts/setup-fusion-memory.mjs',
  install: 'node scripts/install-fusion.mjs',
  'build:fusion': 'pnpm --dir upstream/cortico run build:web',
  'build:native': 'node scripts/build-fusion-native.mjs',
  'verify:package': 'node --expose-internals --import ./upstream/cortico/node_modules/tsx/dist/loader.mjs scripts/verify-fusion-package.mjs',
  'bench:efficiency': 'node --expose-internals --import ./upstream/cortico/node_modules/tsx/dist/loader.mjs integration/fusion-efficiency-benchmark.mjs',
};
// npm lifecycle installation must not recursively invoke the bootstrap.
manifest.scripts['setup:fusion'] = manifest.scripts.install;
delete manifest.scripts.install;
await writeFile(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(destination, '.gitignore'), 'node_modules/\nupstream/**/node_modules/\n.tina-fusion-dev/\n.install-cache/\nruntime/\n');
await writeFile(join(destination, 'README.md'), releaseReadme);

const files = [];
const payloadPaths = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) payloadPaths.push(path);
  }
}
await collect(destination);
for (let offset = 0; offset < payloadPaths.length; offset += 32) {
  files.push(...await Promise.all(payloadPaths.slice(offset, offset + 32).map(async path => {
    const content = await readFile(path);
    const name = posix(relative(destination, path));
    if (/^(?:src|scripts|integration|docs)\//.test(name)
      && /\.(?:mjs|cjs|js|ts|json|md|yaml|yml|txt|env)$/.test(name)
      && /sk-[a-z0-9]{24,}/i.test(content.toString('utf8'))) {
      throw new Error('Secret-shaped text found in a package file: ' + name);
    }
    return { path: name, bytes: content.length, sha256: hash(content) };
  })));
}
files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(join(destination, 'PACKAGE_MANIFEST.json'), JSON.stringify({
  format: 1, product: manifest.name, version: manifest.version, canonicalSourceTreeSha256: canonicalSource.sourceTreeSha256, createdAt: new Date().toISOString(),
  platform: process.platform, arch: process.arch, node: process.version,
  cortico: { revision: sourceLock.revision, version: sourceLock.version, contracts: sourceLock.contracts, sourceTreeSha256: sourceLock.sourceTreeSha256 },
  dsh: { version: runtime.cliVersion, sourceCommit: runtime.sourceCommit, packages: runtime.packages.length, sourceOverlays: runtime.sourceOverlays ?? [] },
  memoryBot: { package:memoryLock.package, version:memoryLock.version, archiveSha256:memoryLock.archiveSha256 },
  files,
}, null, 2) + '\n');
console.log(JSON.stringify({ destination, files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) }));
