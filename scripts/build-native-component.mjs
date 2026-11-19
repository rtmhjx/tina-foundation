import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rm, lstat, symlink, realpath, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeComponents } from './native-components.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedComponent = process.argv.find(value => value.startsWith('--component='))?.slice(12) ?? 'controller';
const component = nativeComponents[requestedComponent];
if (!component) throw new Error('Unknown compatibility component.');
const source = join(root, 'upstream', component);
const tools = createRequire(join(root, 'upstream/cortico/package.json'));
const esbuild = tools('esbuild');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baseline = JSON.parse(await readFile(join(source, 'BASELINE.json'), 'utf8'));
const family = ['dsh-agent-loop', 'dsh-tools'].includes(component);
const distributedJs = baseline.buildMode === 'distributed-js';
const generated = join(source, 'lib');
if (!generated.startsWith(join(root, 'upstream') + '/') && !generated.startsWith(join(root, 'upstream') + '\\')) throw new Error('Unsafe build directory.');
await rm(generated, { recursive: true, force: true });
await mkdir(generated, { recursive: true });
if (family) {
  const buildRuntime = resolve(process.argv.find(arg => arg.startsWith('--build-runtime='))?.slice(16) ?? join(root, 'runtime/dsh-0.1.5-rc.2'));
  const dependencyRoot = await realpath(join(buildRuntime, 'node_modules/@deepseek-ai', component, 'node_modules'));
  const dependencyLink = join(source, 'node_modules');
  try {
    if (!(await lstat(dependencyLink)).isSymbolicLink()) throw new Error('Unexpected build dependency anchor.');
    if (await realpath(dependencyLink) !== dependencyRoot) { await rm(dependencyLink); await symlink(dependencyRoot, dependencyLink, process.platform === 'win32' ? 'junction' : 'dir'); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(dependencyRoot, dependencyLink, process.platform === 'win32' ? 'junction' : 'dir');
  }
  // Full-program TypeScript emit inlines published cross-module const enums.
  execFileSync(process.execPath, [tools.resolve('typescript/bin/tsc'), '-p', join(source, 'tsconfig.json')],
    { cwd: source, stdio: 'inherit', windowsHide: true });
}
if (distributedJs) {
  const provenance = JSON.parse(await readFile(join(source, 'SOURCE-MANIFEST.json'), 'utf8'));
  await mkdir(join(generated, 'types'), { recursive: true });
  for (const item of provenance.files) {
    if (!/^src\/[A-Za-z0-9_-]+\.(?:js|d\.ts)$/.test(item.source)) throw new Error('Unsafe distributed source path.');
    const bytes = await readFile(join(source, item.source));
    if (hash(bytes) !== item.sha256) throw new Error('Distributed source differs from its manifest: ' + item.source);
    await copyFile(join(source, item.source), join(generated, 'types', item.source.slice(4)));
  }
}
await esbuild.build({ absWorkingDir: distributedJs ? root : source, entryPoints: family ? ['lib/types/index.js', 'lib/types/invariant.js'] : [distributedJs ? join(source, 'src/index.js') : 'src/index.ts'],
  ...(family ? { outdir: 'lib', splitting: true, entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]' } : { outfile: join(source, 'lib/index.js') }),
  bundle: true, packages: 'external', format: 'esm', platform: 'node', target: distributedJs ? 'node22' : 'node24', sourcemap: !distributedJs });
async function inventory(path, prefix = '') {
  const rows = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (item.isDirectory()) rows.push(...await inventory(join(path, item.name), prefix + item.name + '/'));
    else if (item.isFile()) rows.push({ path: prefix + item.name, sha256: hash(await readFile(join(path, item.name))) });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
const manifest = { format: 1, package: baseline.package, version: baseline.version,
  ...(component === 'dsh-session' ? { externalEventVersion: 1 }
    : component === 'dsh-session-controller' ? { hostRoutingVersion: 1 }
    : { sourceCapability: baseline.sourceCapability ?? (requestedComponent === 'agent-loop' ? 'registerRequestHead' : 'hasContentFinalizer') }),
  ...(component === 'dsh-agent-loop' ? { requestDeliveryVersion: 1, requestPlanningVersion: 1 } : {}),
  ...(component === 'dsh-token-meter' ? { requestHeadAccountingVersion: 1 } : {}),
  baselineSha256: baseline.runtimeBaselineSha256, compatibleInputSha256: baseline.compatibleInputSha256 ?? [],
  overlaySha256: hash(await readFile(join(source, 'lib/index.js'))),
  entryFamily: baseline.entryFamily ?? {},
  payloadFiles: (await inventory(join(source, 'lib'))).filter(row => distributedJs || !row.path.startsWith('types/')).map(row => ({ ...row, path: 'lib/' + row.path })),
  sourceFiles: await inventory(join(source, 'src')) };
await writeFile(join(source, 'BUILD.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ built: manifest.package, hostRoutingVersion: manifest.hostRoutingVersion, externalEventVersion: manifest.externalEventVersion, sha256: manifest.overlaySha256 }));
