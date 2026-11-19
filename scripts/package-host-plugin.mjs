import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, copyFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyCurrentSources } from './fusion-distribution.mjs';
import { nativeComponents } from './native-components.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = rootPackage.version;
const frameworkPackage = JSON.parse(await readFile(join(root, 'upstream/cortico/package.json'), 'utf8'));
const memoryPackage = JSON.parse(await readFile(join(root, 'self-mem/package.json'), 'utf8'));
const name = '@tina/dsh-plugin-cortico';
const stage = join(root, '.build', 'host-plugin-' + Date.now());
const artifacts = join(root, 'artifacts');
const digest = data => createHash('sha256').update(data).digest('hex');
await mkdir(stage, { recursive: true });
await mkdir(artifacts, { recursive: true });

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const item of await readdir(from, { withFileTypes: true })) {
    if (['node_modules', '.git', '.gitignore', '.env'].includes(item.name) || item.name.endsWith('.test.ts') || item.name.endsWith('.test.mjs')) continue;
    if (item.isDirectory()) await copyTree(join(from, item.name), join(to, item.name));
    else if (item.isFile()) await copyFile(join(from, item.name), join(to, item.name));
    else throw new Error('Release source must not contain links: ' + join(from, item.name));
  }
}
async function copyFileIf(from, to) {
  if (!existsSync(from)) return false;
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  return true;
}

const canonicalSource = await copyCurrentSources(root, stage);
for (const dir of ['src', 'assets', 'templates', 'bots', 'bin'])
  await copyTree(join(root, 'upstream/cortico', dir), join(stage, 'upstream/cortico', dir));
for (const file of ['package.json', 'LICENSE', 'PHILOSOPHY.md', 'README.md', 'README_zh.md'])
  await copyFile(join(root, 'upstream/cortico', file), join(stage, 'upstream/cortico', file));
await copyTree(join(root, 'self-mem'), join(stage, 'vendor/host-self-mem/package'));
for (const dir of [...Object.values(nativeComponents), 'dsh-host-client'])
  await copyTree(join(root, 'upstream', dir), join(stage, 'upstream', dir));
await mkdir(join(stage, 'scripts'), { recursive: true });
for (const file of ['install-host-compat.mjs', 'install-host-session-controller.mjs', 'build-host-compat.mjs', 'build-host-session-controller.mjs', 'build-native-component.mjs', 'native-components.mjs', 'relocate-native-session.mjs'])
  await copyFile(join(root, 'scripts', file), join(stage, 'scripts', file));
if (existsSync(join(root, 'docs/host-plugin'))) await copyTree(join(root, 'docs/host-plugin'), join(stage, 'docs'));
await copyTree(join(root, 'ops'), join(stage, 'ops'));
for (const [directory, names] of Object.entries({
  test: ['host-plugin.acceptance.test.mjs', 'host-plugin-package.test.mjs'],
  integration: ['host-plugin-package-smoke.mjs', 'host-plugin-stock-preflight.mjs'],
})) {
  await mkdir(join(stage, directory), { recursive: true });
  for (const name of names) await copyFileIf(join(root, directory, name), join(stage, directory, name));
}
await copyFileIf(join(root, 'docs/HOST_PLUGIN.md'), join(stage, 'docs/HOST_PLUGIN.md'));
await copyFileIf(join(root, 'docs/NATIVE_SESSION_RELOCATION.md'), join(stage, 'docs/NATIVE_SESSION_RELOCATION.md'));
await copyFileIf(join(root, 'docs/host-plugin/README.md'), join(stage, 'README.md'));
if (!existsSync(join(stage, 'README.md'))) await copyFileIf(join(root, 'docs/HOST_PLUGIN.md'), join(stage, 'README.md'));
await copyFile(join(root, 'upstream/cortico/LICENSE'), join(stage, 'LICENSE'));
await copyFile(join(root, 'vendor/cortico-source-lock.json'), join(stage, 'upstream/CORTICO_SOURCE_LOCK.json'));
await copyFileIf(join(root, 'upstream/HOST-CORTICO-CHANGES.patch'), join(stage, 'upstream/HOST-CORTICO-CHANGES.patch'));
const pkg = {
  name, version, description: 'Cortico Persona, Memory and World on an existing native DSH RP session; no second runtime.',
  type: 'module', main: './src/host-entry.mjs',
  exports: { '.': './src/host-entry.mjs', './client': './lib/client.js', './package.json': './package.json' },
  engines: { node: '>=24.12 <25' }, license: 'AGPL-3.0-or-later',
  files: ['src', 'lib', 'upstream', 'vendor/host-self-mem', 'scripts', 'ops', 'docs', 'BUILD-MANIFEST.json', 'FUSION-SOURCE.json', 'THIRD-PARTY-NOTICES.md', 'README.md', 'LICENSE'],
  dsh: { client: { inject: ['@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-primitives'],
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], platform: 'web' } },
  peerDependencies: { '@deepseek-ai/cordis': '4.0.2' },
  peerDependenciesMeta: { '@deepseek-ai/cordis': { optional: true } },
  dependencies: { 'js-yaml': '4.2.0', ajv: '8.20.0', 'ajv-formats': '3.0.1',
    express: '4.22.2', ws: '8.21.1', fflate: '0.8.3', 'tar-stream': '3.2.1', esbuild: '0.28.2', tsx: '4.23.1' },
  scripts: { 'compat:plan': 'node scripts/install-host-compat.mjs' },
};
pkg.bundledDependencies = Object.keys(pkg.dependencies);
await writeFile(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
// Standard npm bundledDependencies make this a portable offline plugin. Resolve
// third-party dependencies from the local pinned installations. Host identity
// packages are deliberately never vendored into this closure.
const roots = [join(root, 'package.json'), join(root, 'upstream/cortico/package.json')];
const bundled = new Map();
const inventoryDeps = [];
async function locate(name, anchors) {
  for (const anchor of anchors) {
    const require = createRequire(anchor);
    let at;
    try { at = dirname(require.resolve(name + '/package.json')); }
    catch { try { at = dirname(require.resolve(name)); } catch { continue; } }
    for (;;) {
      try { if (JSON.parse(await readFile(join(at, 'package.json'), 'utf8')).name === name) return realpath(at); } catch {}
      const parent = dirname(at); if (parent === at) break; at = parent;
    }
  }
  return null;
}
async function bundle(name, anchors, parent = stage, optional = false) {
  if (name.startsWith('@deepseek-ai/')) throw new Error('Host identity dependency cannot be bundled: ' + name);
  const source = await locate(name, anchors);
  if (!source) { if (optional) return; throw new Error('Missing local dependency ' + name); }
  const meta = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const existing = bundled.get(name);
  if (existing?.version === meta.version) return;
  const dest = join(existing ? parent : stage, 'node_modules', name);
  const key = dest;
  if (bundled.has(key)) return;
  bundled.set(key, { version: meta.version });
  if (!existing) bundled.set(name, { version: meta.version, dest });
  await copyTree(source, dest);
  inventoryDeps.push({ name, version: meta.version, path: dest.slice(stage.length + 1).replaceAll('\\', '/') });
  const childAnchors = [join(source, 'package.json')];
  for (const child of Object.keys(meta.dependencies ?? {})) await bundle(child, childAnchors, dest);
  for (const child of Object.keys(meta.optionalDependencies ?? {})) await bundle(child, childAnchors, dest, true);
}
for (const name of pkg.bundledDependencies) await bundle(name, roots);
for (const [name, expected] of Object.entries(pkg.dependencies)) {
  const actual = JSON.parse(await readFile(join(stage, 'node_modules', name, 'package.json'), 'utf8')).version;
  if (actual !== expected) throw new Error(`Pinned dependency mismatch for ${name}: ${expected} != ${actual}`);
}
await run(process.execPath, [join(root, 'upstream/dsh-host-client/build.mjs'), '--id=' + name, '--out=' + join(stage, 'lib/client.js')], { windowsHide: true });
await writeFile(join(stage, 'THIRD-PARTY-NOTICES.md'), [
  '# Attribution and scope', '',
  'This is an independent, experimental integration. It is not an official DeepSeek, Cordis or Cortico release.', '',
  `- Cortico ${frameworkPackage.version}, Pal AI Lab, MIT. The included LICENSE and source lock retain upstream provenance.`,
  `- DeepSeek Harness 0.1.5-rc.2 ${Object.keys(nativeComponents).join('/')} source overlays, DeepSeek, MIT. BASELINE.json and BUILD.json retain source and runtime hashes.`,
  `- ${memoryPackage.name} ${memoryPackage.version} and included SharedGitMem libraries retain their source manifests.`,
  '- Host Cordis and DSH packages are resolved from the actual host. No DSH executable, second Cordis installation, credential, session or personal memory is included.',
  '- Standard npm bundledDependencies include pinned third-party runtime/compiler libraries and their original license files; see BUILD-MANIFEST.json.', '',
].join('\n'));
const files = [];
async function inventory(path, prefix = '') {
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (item.isDirectory()) await inventory(join(path, item.name), prefix + item.name + '/');
    else { const data = await readFile(join(path, item.name)); files.push({ path: prefix + item.name, bytes: data.length, sha256: digest(data) }); }
  }
}
await inventory(stage);
const manifest = { format: 1, name, version, created: new Date().toISOString(), sourceFusionVersion: rootPackage.version, canonicalSourceTreeSha256: canonicalSource.sourceTreeSha256,
  corticoVersion: frameworkPackage.version, hostVersion: '0.1.5-rc.2', cordisVersion: '4.0.2', selfMemVersion: memoryPackage.version,
  selfMemSource: 'self-mem/',
  hostRuntimeBundled: false, secondAgentLoop: false, privateDataIncluded: false,
  bundledDependencies: inventoryDeps, files: files.sort((a,b) => a.path.localeCompare(b.path)) };
await writeFile(join(stage, 'BUILD-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const result = await run(process.execPath, [npmCli, 'pack', stage, '--pack-destination', artifacts, '--json', '--ignore-scripts'], {
  cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
});
const packed = JSON.parse(result.stdout)[0];
const file = join(artifacts, packed.filename);
const receipt = { ...packed, packagePath: file, stage, sha256: digest(await readFile(file)), manifestFiles: files.length };
await writeFile(join(artifacts, 'PACKAGE.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ package: file, stage, bytes: packed.size, sha256: receipt.sha256, files: packed.entryCount }, null, 2));
