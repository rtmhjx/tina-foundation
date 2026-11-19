import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, glob, lstat, mkdir, readFile, readdir, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const excluded = /(^|[/\\])(?:node_modules|\.git|\.env(?:\..*)?|\.credentials(?:\..*)?|deployments|\.dsh)(?:[/\\]|$)/;
const json = path => readFile(path, 'utf8').then(JSON.parse);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const portable = path => path.split(sep).join('/');

function publishedEntries(manifest) {
  const entries = [];
  function visit(value) {
    if (typeof value === 'string' && !value.includes('*') && (value.startsWith('./') || !value.includes(':'))) entries.push(value.replace(/^\.\//, ''));
    else if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item);
  }
  for (const value of [manifest.main, manifest.module, manifest.types, manifest.bin, manifest.exports]) visit(value);
  return entries;
}

async function packageFor(anchor, name) {
  const resolver = createRequire(join(anchor, 'package.json'));
  for (const base of resolver.resolve.paths(name) ?? []) {
    const path = join(base, name);
    try {
      if ((await stat(join(path, 'package.json'))).isFile()) return realpath(path);
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  return undefined;
}

async function copyPayload(source, target, manifest) {
  await mkdir(target, { recursive: true });
  const patterns = manifest.files ?? ['**/*'];
  const paths = new Set(['package.json']);
  for (const pattern of [...patterns, ...publishedEntries(manifest), 'LICENSE*', 'LICENCE*', 'COPYING*', 'NOTICE*', 'README*', 'license*', 'licence*', 'copying*', 'notice*', 'readme*']) {
    if (isAbsolute(pattern) || pattern.split(/[/\\]/).includes('..')) throw new Error('Unsafe published file declaration.');
    for await (const path of glob(pattern, { cwd: source, exclude: ['node_modules/**', '.git/**'] })) {
      if (!excluded.test(path)) paths.add(path);
    }
  }
  const sorted = [...paths].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const copied = [];
  for (const path of sorted) {
    if (copied.some(parent => path.startsWith(parent + sep))) continue;
    const from = join(source, path);
    const to = join(target, path);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, {
      recursive: true, dereference: true,
      filter: file => !excluded.test(relative(source, file)),
    });
    copied.push(path);
  }
}

async function inventory(root, directory = root, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'runtime-links.json' || entry.name === 'runtime-manifest.json') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(root, path, output);
    else if (entry.isFile()) output.push({ path: portable(relative(root, path)), sha256: hash(await readFile(path)) });
  }
  return output;
}

export async function relocateDshRuntime(target) {
  const root = resolve(target);
  const { links } = await json(join(root, 'runtime-links.json'));
  for (const link of links) {
    const at = resolve(root, link.at);
    const to = resolve(root, link.to);
    if (!at.startsWith(root + sep) || !to.startsWith(root + sep)) throw new Error('Runtime link escapes its package.');
    await mkdir(dirname(at), { recursive: true });
    let existing;
    try { existing = await lstat(at); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      const current = await realpath(at).catch(() => undefined);
      if (current === to) continue;
      if (!existing.isSymbolicLink()) throw new Error('Runtime link is occupied by a regular file or directory.');
      await unlink(at);
    }
    try { await symlink(relative(dirname(at), to), at, 'dir'); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      await symlink(to, at, 'junction');
    }
  }
}

/** Keep native optional plugins addressable from the deployed CLI anchor. */
export async function exposeNativeDshPackages(target) {
  const root = resolve(target);
  const manifestPath = join(root, 'runtime-manifest.json');
  const linksPath = join(root, 'runtime-links.json');
  const manifest = await json(manifestPath);
  const { links } = await json(linksPath);
  const cli = await json(join(root, 'package.json'));
  const taken = new Set(links.map(link => link.at));
  const grouped = new Map();
  for (const node of manifest.packages) {
    if (!node.name.startsWith('@deepseek-ai/') || !node.output) continue;
    const entries = grouped.get(node.name) ?? [];
    entries.push(node);
    grouped.set(node.name, entries);
  }
  const aliases = manifest.nativeRootAliases ?? [];
  let added = 0;
  for (const [name, nodes] of grouped) {
    const at = portable(join('node_modules', name));
    if (nodes.length !== 1 || taken.has(at)) continue;
    const node = nodes[0];
    links.push({ at, to: node.output });
    taken.add(at);
    aliases.push({ name, version: node.version, at, to: node.output });
    (cli.dependencies ??= {})[name] ??= node.version;
    added++;
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(cli, null, 2) + '\n');
  const entry = manifest.packages.find(node => !node.output)?.files.find(file => file.path === 'package.json');
  if (entry) entry.sha256 = hash(await readFile(join(root, 'package.json')));
  manifest.nativeRootAliases = aliases;
  await writeFile(linksPath, JSON.stringify({ links }, null, 2) + '\n');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return added;
}

/** Add npm's automatically included entrypoints when refining an existing closure. */
export async function repairDshRuntimeEntries(target) {
  const root = resolve(target);
  const path = join(root, 'runtime-manifest.json');
  const manifest = await json(path);
  let added = 0;
  for (const node of manifest.packages) {
    const output = resolve(root, node.output);
    if (output !== root && !output.startsWith(root + sep)) throw new Error('Package output escapes runtime.');
    const sourceManifest = await json(join(node.source, 'package.json'));
    const licenses = (await readdir(node.source)).filter(name => /^(?:licen[cs]e|copying|notice|readme)/i.test(name));
    for (const file of [...new Set([...publishedEntries(sourceManifest), ...licenses])]) {
      if (isAbsolute(file) || file.split(/[/\\]/).includes('..') || excluded.test(file)) continue;
      const from = join(node.source, file);
      const to = join(output, file);
      if (await stat(to).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) continue;
      if (!await stat(from).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) continue;
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, { recursive: true, dereference: true });
      node.files = await inventory(output);
      added++;
    }
  }
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  return added;
}

export async function stageDshRuntime({ sourceRoot, destination }) {
  const source = await realpath(resolve(sourceRoot));
  const target = resolve(destination);
  if (target === source || source.startsWith(target + sep) || target.startsWith(source + sep)) {
    throw new Error('Runtime staging must be separate from the source checkout.');
  }
  try { await lstat(target); throw new Error('Use a new empty runtime destination.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cli = await realpath(join(source, 'apps', 'cli'));
  const cliManifest = await json(join(cli, 'package.json'));
  if (cliManifest.name !== '@deepseek-ai/dsh') throw new Error('Expected the native DSH CLI package.');
  await mkdir(target, { recursive: true });
  await cp(join(source, 'LICENSE'), join(target, 'LICENSE'));
  const nodes = new Map();
  const links = [];
  const unresolved = [];
  async function add(directory, output, includeDevelopment = false) {
    const canonical = await realpath(directory);
    const known = nodes.get(canonical);
    if (known) return known;
    const manifest = await json(join(canonical, 'package.json'));
    const id = manifest.name.replaceAll('/', '+') + '@' + manifest.version + '-' + hash(canonical).slice(0, 10);
    const node = { id, name: manifest.name, version: manifest.version, source: canonical, output: output ?? join(target, 'node_modules', '.packages', id), files: [] };
    nodes.set(canonical, node);
    await copyPayload(canonical, node.output, manifest);
    for (const tree of manifest.dsh?.configTrees ?? []) {
      const from = resolve(canonical, tree.path);
      if (!from.startsWith(source + sep)) throw new Error('Config tree escapes the source checkout.');
      const to = join(node.output, tree.mount);
      await cp(from, to, { recursive: true, dereference: true, filter: file => !excluded.test(relative(from, file)) });
      tree.path = './' + portable(tree.mount);
    }
    await writeFile(join(node.output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const dependencies = { ...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.dependencies, ...includeDevelopment && manifest.devDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      const dependency = await packageFor(canonical, name);
      if (!dependency) {
        const optional = Boolean(manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional);
        if (!optional && manifest.dependencies?.[name]) throw new Error('Required installed dependency is missing: ' + manifest.name + ' → ' + name);
        unresolved.push({ owner: manifest.name, name, optional });
        continue;
      }
      const child = await add(dependency);
      const at = join(node.output, 'node_modules', name);
      links.push({ at: portable(relative(target, at)), to: portable(relative(target, child.output)) });
    }
    node.files = await inventory(node.output);
    return node;
  }
  await add(cli, target, true);
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirtyPaths = execFileSync('git', ['-C', source, 'status', '--porcelain=v1', '--untracked-files=normal'], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
  await writeFile(join(target, 'runtime-links.json'), JSON.stringify({ links }, null, 2) + '\n');
  await writeFile(join(target, 'runtime-manifest.json'), JSON.stringify({
    format: 1, kind: 'installed-built-package-closure', upstream: 'https://github.com/deepseek-ai/deepseek-harness',
    sourceCommit: commit, sourceDirtyPaths: dirtyPaths, platform: process.platform, arch: process.arch,
    node: process.version, cliVersion: cliManifest.version, unresolved,
    packages: [...nodes.values()].map(node => ({ ...node, output: portable(relative(target, node.output)) })),
  }, null, 2) + '\n');
  const nativeAliases = await exposeNativeDshPackages(target);
  await relocateDshRuntime(target);
  return { destination: target, packages: nodes.size, links: links.length + nativeAliases, nativeAliases, unresolved: unresolved.length, version: cliManifest.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--relocate') {
    await relocateDshRuntime(process.argv[3]);
    console.log('Internal DSH runtime links are ready.');
  } else if (process.argv[2] === '--repair-entries') {
    console.log(JSON.stringify({ added: await repairDshRuntimeEntries(process.argv[3]) }));
  } else if (process.argv[2] === '--expose-native') {
    const added = await exposeNativeDshPackages(process.argv[3]);
    await relocateDshRuntime(process.argv[3]);
    console.log(JSON.stringify({ added }));
  } else {
    const sourceRoot = process.argv[2] ?? process.env.DSH_SOURCE_ROOT;
    if (!sourceRoot) throw new Error('Pass the DSH source root as argv[2] or set DSH_SOURCE_ROOT.');
    console.log(JSON.stringify(await stageDshRuntime({
      sourceRoot,
      destination: process.argv[3] ?? join(projectRoot, 'runtime', 'dsh-0.1.5-rc.2'),
    })));
  }
}
