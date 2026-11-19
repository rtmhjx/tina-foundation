import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, path) => { const r = relative(parent, path); return r === '' || !r.startsWith('..') && !isAbsolute(r); };
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const safeName = name => /^(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/i.test(name);
const normalizedPayload = (root, rows) => rows.map(row => row.link ? { path: row.path, link: relative(root, row.resolved) } : row);

async function payload(root) {
  const rows = [];
  async function walk(path, label = '') {
    for (const name of (await readdir(path)).sort()) {
      if (name === '.git' || name === 'node_modules' && !label) continue;
      // Package code and account state must never become one migration blob.
      assert.ok(!/^\.env(?:$|\.)/.test(name) && !['.npmrc', '.credentials.yaml'].includes(name),
        'Private-looking file in legacy package needs separate review');
      const file = join(path, name), at = label ? label + '/' + name : name, info = await lstat(file);
      if (info.isSymbolicLink()) rows.push({ path: at, link: await readlink(file), resolved: await realpath(file) });
      else if (info.isDirectory()) await walk(file, at);
      else { assert.ok(info.isFile()); rows.push({ path: at, sha256: hash(await readFile(file)), mode: info.mode & 0o777 }); }
    }
  }
  await walk(root); return rows;
}

async function resolvePackage(requester, name) {
  assert.ok(safeName(name), 'Invalid existing package dependency name');
  const require = createRequire(join(requester, 'package.json'));
  // Names such as buffer/events also have installed npm polyfills; ask for a
  // package subpath so Node does not short-circuit module paths as a builtin.
  for (const base of require.resolve.paths(name + '/package.json') ?? []) {
    const path = join(base, ...name.split('/'));
    if (await exists(join(path, 'package.json'))) return realpath(path);
  }
  return null;
}

async function visiblePackages(root) {
  const directory = join(root, 'node_modules');
  if (!await exists(directory)) return [];
  const names = [];
  for (const name of (await readdir(directory)).sort()) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const child of (await readdir(join(directory, name))).sort()) names.push(name + '/' + child);
    } else names.push(name);
  }
  return names.filter(safeName);
}

/** Copy only installed package code and its real module graph into the new state.
 * No package manager can reach original local packages through these links.
 * Existing absolute imports inside source bytes are intentionally not rewritten.
 */
export async function internalizeLegacyExtensionCode({ sourceExtensions, stage, state, skip = [] }) {
  const original = await json(join(sourceExtensions, 'package.json'));
  const nodes = new Map(), direct = [], missing = [];
  async function visit(root) {
    root = await realpath(root);
    if (nodes.has(root)) return nodes.get(root);
    const manifest = await json(join(root, 'package.json'));
    assert.ok(safeName(manifest.name) && typeof manifest.version === 'string');
    const node = { source: root, name: manifest.name, version: manifest.version, manifest, payload: await payload(root), edges: [] };
    nodes.set(root, node);
    const visible = await visiblePackages(root);
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}), ...visible]);
    for (const name of [...names].sort()) {
      const resolved = await resolvePackage(root, name);
      if (!resolved) { missing.push({ source: root, specifier: name,
        kind: isBuiltin(name) ? 'builtin' : Object.hasOwn(manifest.optionalDependencies ?? {}, name) ? 'optional'
          : Object.hasOwn(manifest.dependencies ?? {}, name) ? 'dependency'
            : Object.hasOwn(manifest.peerDependencies ?? {}, name) ? 'peer' : 'visible' }); continue; }
      const child = await visit(resolved);
      node.edges.push({ specifier: name, source: child.source });
    }
    // Non-module symlinks are only allowed inside this exact package payload.
    // Arbitrary external source/assets need an explicit separate preservation plan.
    for (const row of node.payload) if (row.link) assert.ok(inside(root, row.resolved)
      && !relative(root, row.resolved).split(/[\\/]/).includes('node_modules'), 'Legacy payload link escapes its package');
    return node;
  }
  for (const [name, spec] of Object.entries(original.dependencies ?? {}).sort()) {
    if (skip.includes(name)) continue;
    const node = await visit(join(sourceExtensions, 'node_modules', ...name.split('/')));
    direct.push({ name, originalSpec: spec, source: node.source });
  }
  const graph = [...nodes.values()].sort((a, b) => a.source.localeCompare(b.source, 'en'))
    .map(node => ({ source: node.source, name: node.name, version: node.version, payload: node.payload, edges: node.edges }));
  const graphSha256 = hash(JSON.stringify({ graph, direct, missing }));
  const directory = join(state, 'extensions-packages', 'legacy-' + graphSha256);
  assert.equal(await exists(directory), false, 'A legacy graph destination already exists; inspect before retrying');
  await mkdir(directory, { mode: 0o700 });
  const destinations = new Map(graph.map(node => [node.source, join(directory, 'packages', hash(node.source).slice(0, 24))]));
  for (const node of graph) {
    const target = destinations.get(node.source); await mkdir(target, { recursive: true, mode: 0o700 });
    for (const row of node.payload) {
      const path = join(target, row.path); await mkdir(dirname(path), { recursive: true });
      if (row.link) {
        const mapped = join(target, relative(node.source, row.resolved));
        await symlink(relative(dirname(path), mapped), path);
      } else {
        await copyFile(join(node.source, row.path), path); await chmod(path, row.mode);
      }
    }
  }
  for (const node of graph) {
    const target = destinations.get(node.source);
    for (const edge of node.edges) {
      const link = join(target, 'node_modules', ...edge.specifier.split('/'));
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), destinations.get(edge.source)), link);
      const child = nodes.get(edge.source);
      const bins = typeof child.manifest.bin === 'string' ? { [child.name.split('/').at(-1)]: child.manifest.bin } : child.manifest.bin ?? {};
      for (const [name, file] of Object.entries(bins)) {
        assert.ok(safeName(name) && !name.includes('/') && typeof file === 'string');
        const executable = resolve(destinations.get(edge.source), file);
        assert.ok(inside(destinations.get(edge.source), executable), 'Package bin escapes its payload');
        const binLink = join(target, 'node_modules/.bin', name);
        await mkdir(dirname(binLink), { recursive: true });
        if (!await exists(binLink)) await symlink(relative(dirname(binLink), executable), binLink);
      }
    }
  }
  const clean = rows => rows.map(row => row.link ? { path: row.path, target: row.resolved } : row);
  for (const node of graph) {
    const target = destinations.get(node.source), copied = await payload(target);
    const remapped = copied.map(row => row.link ? { ...row, resolved: join(node.source, relative(target, row.resolved)) } : row);
    assert.deepEqual(clean(remapped), clean(node.payload), 'Internalized code bytes/modes differ');
    assert.deepEqual(await payload(node.source), node.payload, 'Source code changed during internalization');
    for (const edge of node.edges) assert.equal(await resolvePackage(target, edge.specifier), destinations.get(edge.source), 'Module resolution changed');
  }
  const stagePackage = await json(join(stage, 'package.json'));
  assert.equal(await realpath(stage), stage);
  assert.equal(await realpath(join(stage, 'package.json')), join(stage, 'package.json'), 'Staging package manifest must be physical');
  // Park the copied module entry as a whole. It can itself be a symlink to an
  // old extension tree; editing children before detaching it would write old state.
  const parkedModulesDirectory = join(state, '.extension-modules-before-internalization-' + randomUUID());
  await rename(join(stage, 'node_modules'), parkedModulesDirectory);
  await mkdir(join(stage, 'node_modules'));
  const mappings = [];
  for (const row of direct) {
    const target = destinations.get(row.source), nextSpec = 'link:' + target;
    stagePackage.dependencies[row.name] = nextSpec;
    const link = join(stage, 'node_modules', ...row.name.split('/'));
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), target), link);
    mappings.push({ ...row, target, newSpec: nextSpec });
  }
  await writeFile(join(stage, 'package.json'), JSON.stringify(stagePackage, null, 2) + '\n');
  // Every retained direct dependency is now a byte-checked owned link. The old
  // npm package graph is no longer the active graph; retaining its stale registry
  // entries can trigger supply-chain resolution of packages no longer used.
  let parkedLock;
  if (await exists(join(stage, 'pnpm-lock.yaml'))) {
    parkedLock = { path: join(state, '.extension-lock-before-internalization-' + randomUUID() + '.yaml'),
      sha256: hash(await readFile(join(stage, 'pnpm-lock.yaml'))) };
    await rename(join(stage, 'pnpm-lock.yaml'), parkedLock.path);
  }
  const receipt = { kind: 'tina-internalized-extension-code-v1', graphSha256, directory, parkedModulesDirectory, parkedLock, mappings,
    missing: missing.map(row => ({ ...row, target: destinations.get(row.source) })),
    packages: graph.map(node => ({ source: node.source, target: destinations.get(node.source), name: node.name, version: node.version,
      payloadSha256: hash(JSON.stringify(node.payload)), commonPayloadSha256: hash(JSON.stringify(normalizedPayload(node.source, node.payload))),
      files: node.payload.length, dependencies: node.edges.map(edge => ({
        specifier: edge.specifier, source: edge.source, target: destinations.get(edge.source) })) })),
    sourceBytesPreserved: true, resolutionChecked: true, absoluteSourceImportsRewritten: false,
    remainingBoundary: 'Preserve original code roots referenced by absolute imports, including inactive legacy Bot memory-addon imports. This is private deployment material.' };
  await writeFile(join(directory, 'INTERNALIZATION.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  return receipt;
}

export async function verifyInternalizedExtensionCode(receipt) {
  for (const row of receipt.packages) {
    assert.equal(hash(JSON.stringify(await payload(row.source))), row.payloadSha256, 'Legacy source changed after copying');
    assert.equal(hash(JSON.stringify(normalizedPayload(row.target, await payload(row.target)))), row.commonPayloadSha256,
      'Internalized package changed during installation');
    for (const edge of row.dependencies) {
      assert.equal(await resolvePackage(row.source, edge.specifier), edge.source, 'Original package resolution changed');
      assert.equal(await resolvePackage(row.target, edge.specifier), edge.target, 'Internalized package resolution changed');
    }
  }
  for (const row of receipt.missing) {
    assert.equal(await resolvePackage(row.source, row.specifier), null, 'Previously missing dependency appeared in original code');
    assert.equal(await resolvePackage(row.target, row.specifier), null, 'Internalization silently supplied a different dependency');
  }
  return true;
}
