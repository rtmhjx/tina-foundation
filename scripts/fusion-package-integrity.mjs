import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nativeComponents, nativePackageName } from './native-components.mjs';

const MANIFEST = 'PACKAGE_MANIFEST.json';
const ORIGINAL = 'PACKAGE_MANIFEST.original.json';
const RUNTIME = 'runtime/dsh-0.1.5-rc.2';
const RUNTIME_MANIFEST = RUNTIME + '/runtime-manifest.json';
const OVERLAYS = [
  ...Object.entries(nativeComponents).map(([component, stem]) => ({ name: nativePackageName(component), stem, hostOnly: false })),
  { name: '@deepseek-ai/dsh-client-file-upload', stem: 'dsh-file-upload', hostOnly: true },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function payloadPath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\:\0]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error('Unsafe package payload path: ' + path);
  }
  return path;
}

function parseManifest(bytes, label) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Invalid package manifest: ' + label);
  }
  const seen = new Set();
  for (const file of manifest.files) {
    payloadPath(file.path);
    const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (seen.has(key) || [MANIFEST.toLowerCase(), ORIGINAL.toLowerCase()].includes(key.toLowerCase())
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Invalid or duplicate package file entry: ' + file.path);
    }
    seen.add(key);
  }
  return manifest;
}

async function payloadBytes(root, path) {
  const target = await realpath(join(root, payloadPath(path)));
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) {
    throw new Error('Package payload resolves outside its root: ' + path);
  }
  return readFile(target);
}

async function optionalBytes(root, path) {
  try { return await payloadBytes(root, path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function inventoryListed(root, files) {
  const output = [];
  for (let index = 0; index < files.length; index += 32) {
    output.push(...await Promise.all(files.slice(index, index + 32).map(async ({ path }) => {
      const content = await payloadBytes(root, path);
      return { path, bytes: content.length, sha256: hash(content) };
    })));
  }
  return output;
}

function sameFileList(current, original) {
  if (!isDeepStrictEqual(current.files.map(file => file.path).sort(), original.files.map(file => file.path).sort())) {
    throw new Error('Materialized package must retain the original payload file allowlist.');
  }
}

async function loadVerified(root, allowMissing) {
  root = await realpath(resolve(root));
  const bytes = await optionalBytes(root, MANIFEST);
  if (!bytes) {
    if (!allowMissing) throw new Error('PACKAGE_MANIFEST.json is required for package verification.');
    return { root, report: { mode: 'development-no-manifest', verifiedFiles: 0 } };
  }
  const manifest = parseManifest(bytes, MANIFEST);
  const actual = await inventoryListed(root, manifest.files);
  for (let index = 0; index < actual.length; index++) {
    const expected = manifest.files[index];
    if (actual[index].bytes !== expected.bytes || actual[index].sha256 !== expected.sha256) {
      throw new Error('Package payload integrity mismatch: ' + expected.path);
    }
  }
  const originalBytes = await optionalBytes(root, ORIGINAL);
  const provenance = manifest.materialization;
  let original;
  if (provenance) {
    if (provenance.originalManifest !== ORIGINAL || !originalBytes
      || hash(originalBytes) !== provenance.originalManifestSha256) {
      throw new Error('Original package manifest provenance is missing or mismatched.');
    }
    original = parseManifest(originalBytes, ORIGINAL);
    sameFileList(manifest, original);
  } else if (originalBytes) {
    if (!bytes.equals(originalBytes)) throw new Error('Unmaterialized package differs from its preserved original manifest.');
    original = parseManifest(originalBytes, ORIGINAL);
  }
  return {
    root, bytes, manifest, originalBytes, original,
    report: {
      mode: 'package-payload', verifiedFiles: actual.length, manifestSha256: hash(bytes),
      originalManifestSha256: originalBytes ? hash(originalBytes) : hash(bytes),
      materialized: Boolean(provenance),
    },
  };
}

/** Byte verification is local integrity/provenance, not an external publisher signature. */
export async function verifyPackagePayload(root, { allowMissing = false } = {}) {
  return (await loadVerified(root, allowMissing)).report;
}

async function buildPolicy(context) {
  const files = new Map(context.manifest.files.map(file => [file.path, file]));
  async function trackedJson(path) {
    const file = files.get(path);
    if (!file) throw new Error('Build metadata is outside the original payload allowlist: ' + path);
    const bytes = await payloadBytes(context.root, path);
    if (hash(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new Error('Build metadata changed before installation: ' + path);
    return JSON.parse(bytes.toString('utf8'));
  }
  const runtime = await trackedJson(RUNTIME_MANIFEST);
  const mutable = new Set([RUNTIME_MANIFEST]);
  for (const path of files.keys()) if (path.startsWith('upstream/cortico/dist/')) mutable.add(path);
  const overlays = [];
  for (const spec of OVERLAYS) {
    const lockPath = 'vendor/' + spec.stem + '-source-lock.json';
    const lock = await trackedJson(lockPath);
    const nodes = runtime.packages.filter(node => node.name === spec.name);
    if (nodes.length !== 1 || lock.package !== spec.name) throw new Error('Expected one native source overlay: ' + spec.name);
    const node = nodes[0];
    payloadPath(node.output);
    if (!node.output.startsWith('node_modules/.packages/')) throw new Error('Unexpected native overlay output: ' + node.output);
    const prefix = RUNTIME + '/' + node.output + '/';
    const archive = 'vendor/' + payloadPath(lock.archive);
    if (lock.archive.includes('/') || !files.has(archive)) throw new Error('Native source archive is outside the payload allowlist.');
    mutable.add(lockPath);
    mutable.add(archive);
    mutable.add(prefix + 'package.json');
    const generated = spec.hostOnly ? lock.generatedFiles : node.files.filter(file => file.path.startsWith('lib/'));
    if (!Array.isArray(generated)) throw new Error('Missing native generated file list: ' + spec.name);
    for (const file of generated) {
      const path = prefix + payloadPath(file.path);
      if (!file.path.startsWith('lib/') || !files.has(path)) throw new Error('Native build output is outside the payload allowlist: ' + path);
      mutable.add(path);
    }
    overlays.push({ ...spec, lockPath, lock, node, prefix, archive });
  }
  for (const path of mutable) if (!files.has(path)) throw new Error('Build output is outside the payload allowlist: ' + path);
  return { runtime, mutable, overlays };
}

function stableBuild(build) {
  if (!build) return build;
  const { startedAt, finishedAt, node, ...stable } = build;
  return stable;
}

function stableLock(lock) {
  const { archiveSha256, ...stable } = lock;
  if (stable.build) stable.build = stableBuild(stable.build);
  if (stable.generatedFiles) stable.generatedFiles = stable.generatedFiles.map(file => file.path).sort();
  return stable;
}

function stableRuntime(runtime) {
  const own = new Set(OVERLAYS.map(overlay => overlay.name));
  const result = structuredClone(runtime);
  const stableOverlay = overlay => ({ ...overlay, build: stableBuild(overlay.build) });
  result.packages = result.packages.map(node => own.has(node.name) ? {
    ...node,
    files: node.files.map(file => file.path).sort(),
    sourceOverlay: stableOverlay(node.sourceOverlay),
  } : node);
  result.sourceOverlays = (result.sourceOverlays ?? []).map(stableOverlay).sort((a, b) => a.package.localeCompare(b.package));
  return result;
}

/** Begin before relocation/install/build. Only the original payload paths can be materialized. */
export async function beginPackageMaterialization(root, { allowMissing = false } = {}) {
  const context = await loadVerified(root, allowMissing);
  if (!context.manifest) return context;
  context.policy = await buildPolicy(context);
  context.original ??= context.manifest;
  context.originalBytes ??= context.bytes;
  // Preserve the exact shipping manifest once, never regenerate it from a changed tree.
  try { await writeFile(join(context.root, ORIGINAL), context.originalBytes, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const preserved = await payloadBytes(context.root, ORIGINAL);
  if (!preserved.equals(context.originalBytes)) throw new Error('Original package manifest changed while preparing installation.');
  return context;
}

/** Finish only after every build succeeds. No state, cache, dependency, or new file is inventoried. */
export async function finishPackageMaterialization(context) {
  if (!context.manifest) return context.report;
  const { root, policy, original } = context;
  const unchangedManifest = await payloadBytes(root, MANIFEST);
  if (!unchangedManifest.equals(context.bytes)) throw new Error('Package manifest changed during installation.');
  const unchangedOriginal = await payloadBytes(root, ORIGINAL);
  if (!unchangedOriginal.equals(context.originalBytes)) throw new Error('Original package manifest changed during installation.');
  const files = await inventoryListed(root, original.files);
  const actual = new Map(files.map(file => [file.path, file]));
  const changedFiles = [];
  for (const expected of original.files) {
    const current = actual.get(expected.path);
    if (current.sha256 === expected.sha256 && current.bytes === expected.bytes) continue;
    if (!policy.mutable.has(expected.path)) throw new Error('Unexpected source or payload change during installation: ' + expected.path);
    changedFiles.push(expected.path);
  }
  const runtime = JSON.parse(await payloadBytes(root, RUNTIME_MANIFEST));
  if (!isDeepStrictEqual(stableRuntime(runtime), stableRuntime(policy.runtime))) {
    throw new Error('Native runtime identity or file allowlist changed during installation.');
  }
  for (const overlay of policy.overlays) {
    const lock = JSON.parse(await payloadBytes(root, overlay.lockPath));
    if (!isDeepStrictEqual(stableLock(lock), stableLock(overlay.lock))) {
      throw new Error('Native source provenance changed during installation: ' + overlay.name);
    }
    if (actual.get(overlay.archive).sha256 !== lock.archiveSha256) throw new Error('Rebuilt source archive hash mismatch: ' + overlay.name);
    for (const file of lock.generatedFiles ?? []) {
      const current = actual.get(overlay.prefix + payloadPath(file.path));
      if (current?.sha256 !== file.sha256 || current.bytes !== file.bytes) {
        throw new Error('Native source lock differs from materialized output: ' + overlay.name + '/' + file.path);
      }
    }
  }
  // The runtime's own inventory must describe those same verified physical payload files.
  for (const node of runtime.packages) for (const file of node.files) {
    const path = RUNTIME + '/' + (node.output ? payloadPath(node.output) + '/' : '') + payloadPath(file.path);
    if (actual.get(path)?.sha256 !== file.sha256) throw new Error('Runtime inventory differs from materialized payload: ' + path);
  }
  const manifest = {
    ...original,
    dsh: { ...original.dsh, sourceOverlays: runtime.sourceOverlays ?? [] },
    materialization: {
      originalManifest: ORIGINAL, originalManifestSha256: hash(context.originalBytes),
      materializedAt: new Date().toISOString(), node: process.version,
      policy: 'original-file-allowlist-and-native-build-outputs-v1', changedFiles,
    },
    files,
  };
  const temporary = join(root, MANIFEST + '.' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, join(root, MANIFEST));
  return { ...await verifyPackagePayload(root), changedFiles };
}
