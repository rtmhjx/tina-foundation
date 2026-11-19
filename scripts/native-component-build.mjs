/** Shared native source build/install/provenance path for both distributions. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { nativeComponents } from './native-components.mjs';
export { nativeComponents } from './native-components.mjs';
const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => readFile(path, 'utf8').then(JSON.parse);

async function inventory(directory, prefix = '') {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) rows.push(...await inventory(join(directory, entry.name), path + '/'));
    else if (entry.isFile()) {
      const bytes = await readFile(join(directory, entry.name));
      rows.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    } else throw new Error('Unexpected source/package link: ' + path);
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export async function recordNativeBuild(runtime, components) {
  runtime = await realpath(resolve(runtime));
  const manifestPath = join(runtime, 'runtime-manifest.json');
  const runtimeManifest = await json(manifestPath);
  for (const component of components) {
    const stem = nativeComponents[component];
    if (!stem) throw new Error('Unknown native component.');
    const source = join(root, 'upstream', stem);
    const build = await json(join(source, 'BUILD.json'));
    const candidates = runtimeManifest.packages.filter(node => node.name === build.package);
    if (candidates.length !== 1) throw new Error('Expected one native runtime package: ' + build.package);
    const node = candidates[0];
    const packageRoot = await realpath(join(runtime, node.output));
    if (!packageRoot.startsWith(runtime + sep)) throw new Error('Native package escapes selected runtime.');
    for (const file of build.payloadFiles) {
      if (hash(await readFile(join(packageRoot, file.path))) !== file.sha256) throw new Error('Installed native payload differs from its build: ' + file.path);
    }
    const sourceFiles = (await inventory(join(source, 'src'))).map(file => ({ ...file, path: 'src/' + file.path }));
    const archiveFiles = ['src'];
    for (const path of ['package.json', 'tsconfig.json', 'LICENSE', 'README.md', 'BASELINE.json', 'SOURCE-MANIFEST.json', 'OVERLAY-MANIFEST.json', 'BUILD-NOTES.md', 'build.mjs']) {
      try {
        const bytes = await readFile(join(source, path));
        sourceFiles.push({ path, bytes: bytes.length, sha256: hash(bytes) });
        archiveFiles.push(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    sourceFiles.sort((a, b) => a.path.localeCompare(b.path));
    const sourceTreeSha256 = hash(JSON.stringify(sourceFiles.map(({ path, sha256 }) => ({ path, sha256 }))));
    const archive = stem + '-0.1.5-rc.2-fusion-source.tgz';
    execFileSync('tar', ['-czf', join(root, 'vendor', archive), '-C', source, ...archiveFiles], { windowsHide: true });
    const provenance = {
      format: 1, package: build.package, version: build.version, kind: 'source-built-overlay',
      upstream: 'https://github.com/deepseek-ai/deepseek-harness', upstreamCommit: runtimeManifest.sourceCommit,
      source: 'upstream/' + stem, sourceTreeSha256, files: sourceFiles,
      baselineLock: 'upstream/' + stem + '/BASELINE.json', baselineLockSha256: hash(await readFile(join(source, 'BASELINE.json'))),
      archive, archiveSha256: hash(await readFile(join(root, 'vendor', archive))),
      build: { node: process.version, script: 'scripts/build-native-component.mjs',
        scriptSha256: hash(await readFile(join(root, 'scripts/build-native-component.mjs'))),
        outputSha256: build.overlaySha256 },
    };
    await writeFile(join(root, 'vendor', stem + '-source-lock.json'), JSON.stringify(provenance, null, 2) + '\n');
    node.files = await inventory(packageRoot);
    node.sourceOverlay = { kind: provenance.kind, source: provenance.source, sourceTreeSha256,
      sourceLock: 'vendor/' + stem + '-source-lock.json', upstreamCommit: provenance.upstreamCommit, build: provenance.build };
    runtimeManifest.sourceOverlays = [...(runtimeManifest.sourceOverlays ?? []).filter(row => row.package !== build.package),
      { package: build.package, output: node.output, ...node.sourceOverlay }];
  }
  runtimeManifest.kind = 'installed-built-package-closure-with-source-overlays';
  await writeFile(manifestPath, JSON.stringify(runtimeManifest, null, 2) + '\n');
}

export async function buildNativeComponents({ runtime = join(root, 'runtime/dsh-0.1.5-rc.2'), components = Object.keys(nativeComponents) } = {}) {
  runtime = await realpath(resolve(runtime));
  const run = (script, args) => execFileSync(process.execPath, [join(root, 'scripts', script), ...args],
    { cwd: root, stdio: 'inherit', windowsHide: true });
  for (const component of components) {
    if (!nativeComponents[component]) throw new Error('Unknown native component.');
    run('build-native-component.mjs', ['--component=' + component, '--build-runtime=' + runtime]);
  }
  if (components.length === Object.keys(nativeComponents).length) run('install-host-compat.mjs', ['--runtime=' + runtime, '--apply', '--upgrade']);
  else for (const component of components) run('install-host-session-controller.mjs', ['--runtime=' + runtime, '--component=' + component, '--apply', '--upgrade']);
  await recordNativeBuild(runtime, components);
}
