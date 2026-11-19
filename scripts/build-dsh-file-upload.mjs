import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'upstream', 'dsh-file-upload');
const runtime = resolve(process.argv[2] ?? join(root, 'runtime', 'dsh-0.1.5-rc.2'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = path => path.split(sep).join('/');
const json = path => readFile(path, 'utf8').then(JSON.parse);
async function inventory(directory, prefix = '') {
  const rows = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = posix(join(prefix, entry.name));
    if (entry.isDirectory()) rows.push(...await inventory(directory, path));
    else if (entry.isFile()) {
      const bytes = await readFile(join(directory, path));
      rows.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    } else throw new Error('Unexpected link in source/build payload.');
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

const packageName = '@deepseek-ai/dsh-client-file-upload';
const anchorManifest = await json(join(root, 'runtime', 'dsh-0.1.5-rc.2', 'runtime-manifest.json'));
const anchor = anchorManifest.packages.find(node => node.name === packageName);
if (!anchor) throw new Error('The independent file-upload package is missing.');
const pkg = await json(join(source, 'package.json'));
const peerRoot = join(root, 'runtime', 'dsh-0.1.5-rc.2', anchor.output, 'node_modules');
const link = join(source, 'node_modules');
try {
  const status = await lstat(link);
  if (status.isSymbolicLink()) {
    if (await realpath(link) !== await realpath(peerRoot)) throw new Error('Unexpected source dependency link.');
    await rm(link);
  } else if (!status.isDirectory()) {
    throw new Error('Invalid source dependency directory.');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(link, { recursive: true });
for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {})])) {
  const candidates = anchorManifest.packages.filter(node => node.name === name);
  if (candidates.length !== 1) throw new Error('Expected one locked build dependency for ' + name);
  const target = join(root, 'runtime', 'dsh-0.1.5-rc.2', candidates[0].output);
  const dependencyLink = join(link, name);
  await mkdir(dirname(dependencyLink), { recursive: true });
  try {
    if (!(await lstat(dependencyLink)).isSymbolicLink() || await realpath(dependencyLink) !== await realpath(target)) {
      throw new Error('Build dependency does not resolve through the independent runtime: ' + name);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(target, dependencyLink, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

const tools = createRequire(join(root, 'upstream', 'cortico', 'package.json'));
const buildDir = resolve(source, 'lib');
if (!buildDir.startsWith(source + sep) || !source.startsWith(join(root, 'upstream') + sep)) {
  throw new Error('Unsafe generated build directory.');
}
const startedAt = new Date().toISOString();
await rm(buildDir, { recursive: true, force: true });
execFileSync(process.execPath, [tools.resolve('typescript/bin/tsc'), '-p', join(source, 'tsconfig.json')],
  { cwd: source, stdio: 'inherit' });
const esbuild = tools('esbuild');
await esbuild.build({ absWorkingDir: source, entryPoints: ['lib/types/index.js'], outdir: 'lib', bundle: true,
  packages: 'external', format: 'esm', platform: 'node', target: 'node24', sourcemap: true, logLevel: 'info' });

const srcFiles = (await inventory(join(source, 'src'))).map(file => ({ ...file, path: 'src/' + file.path }));
for (const path of ['package.json', 'tsconfig.json', 'LICENSE', 'README.md']) {
  const bytes = await readFile(join(source, path));
  srcFiles.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
srcFiles.sort((a, b) => a.path.localeCompare(b.path));
const sourceTreeSha256 = hash(JSON.stringify(srcFiles.map(({ path, sha256 }) => ({ path, sha256 }))));
const baselineLock = 'vendor/dsh-file-upload-baseline-lock.json';
const baseline = await json(join(root, baselineLock));
const generated = (await inventory(buildDir)).map(file => ({ ...file, path: 'lib/' + file.path }));
const generatedPaths = new Set(generated.map(file => file.path));
const runtimeManifest = await json(join(runtime, 'runtime-manifest.json'));
const nodes = runtimeManifest.packages.filter(node => node.name === packageName);
if (nodes.length !== 1) throw new Error('Expected one file-upload runtime package instance.');
const node = nodes[0];
const packageTarget = resolve(runtime, node.output);
if (!packageTarget.startsWith(runtime + sep)) throw new Error('Overlay package escapes runtime.');
const retained = baseline.runtimeFiles.filter(file => file.path !== 'package.json' && !generatedPaths.has(file.path));
for (const file of retained) {
  if (hash(await readFile(join(packageTarget, file.path))) !== file.sha256) {
    throw new Error('Untouched file-upload runtime payload differs from its locked baseline: ' + file.path);
  }
}

const archive = 'dsh-file-upload-0.1.5-rc.2-fusion-source.tgz';
await mkdir(join(root, 'vendor'), { recursive: true });
execFileSync('tar', ['-czf', join(root, 'vendor', archive), '-C', source, 'src', 'package.json', 'tsconfig.json', 'LICENSE', 'README.md']);
const provenance = {
  format: 1, package: pkg.name, version: pkg.version, kind: 'host-source-built-overlay',
  upstream: 'https://github.com/deepseek-ai/deepseek-harness', upstreamCommit: runtimeManifest.sourceCommit,
  source: 'upstream/dsh-file-upload', sourceTreeSha256, files: srcFiles,
  baselineLock, baselineLockSha256: hash(await readFile(join(root, baselineLock))),
  buildScope: 'Four host TypeScript files and the host bundle; browser and Typert-generated entrypoints remain locked baseline payloads.',
  generatedFiles: generated, retainedBaselineFiles: retained,
  archive, archiveSha256: hash(await readFile(join(root, 'vendor', archive))),
  build: { startedAt, finishedAt: new Date().toISOString(), node: process.version,
    typescript: tools('typescript/package.json').version, esbuild: esbuild.version,
    commands: [['node', 'typescript/bin/tsc', '-p', 'upstream/dsh-file-upload/tsconfig.json'],
      ['esbuild', 'lib/types/index.js', '--bundle', '--packages=external', '--platform=node', '--target=node24']],
    script: 'scripts/build-dsh-file-upload.mjs', scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))) },
};
await writeFile(join(root, 'vendor', 'dsh-file-upload-source-lock.json'), JSON.stringify(provenance, null, 2) + '\n');
await cp(buildDir, join(packageTarget, 'lib'), { recursive: true });
await writeFile(join(packageTarget, 'package.json'), JSON.stringify({ ...pkg,
  tinaFusionSourceOverlay: { kind: provenance.kind, sourceTreeSha256, upstreamCommit: provenance.upstreamCommit } }, null, 2) + '\n');
node.files = await inventory(packageTarget);
node.sourceOverlay = { kind: provenance.kind, source: provenance.source, sourceTreeSha256,
  sourceLock: 'vendor/dsh-file-upload-source-lock.json', upstreamCommit: provenance.upstreamCommit, build: provenance.build };
runtimeManifest.kind = 'installed-built-package-closure-with-source-overlays';
runtimeManifest.sourceOverlays = [
  ...(runtimeManifest.sourceOverlays ?? []).filter(overlay => overlay.package !== packageName),
  { package: packageName, output: node.output, ...node.sourceOverlay },
];
await writeFile(join(runtime, 'runtime-manifest.json'), JSON.stringify(runtimeManifest, null, 2) + '\n');
console.log(JSON.stringify({ runtime, packageTarget, sourceTreeSha256,
  generatedFiles: generated.length, retainedBaselineFiles: retained.length, archive }));
