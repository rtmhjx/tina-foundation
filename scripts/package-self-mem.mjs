/** Publishable memory payload from the same canonical source used by the host. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fusionNpmCli } from './setup-fusion-memory.mjs';

const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyCanonicalSelfMem(productRoot = root) {
  const source = join(productRoot, 'vendor/host-self-mem/package');
  const manifestBytes = await readFile(join(source, 'BUILD-MANIFEST.json'));
  const manifest = JSON.parse(manifestBytes);
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== '@tina/self-mem' || pkg.name !== manifest.name || pkg.version !== manifest.version
      || !Array.isArray(manifest.files) || pkg.cortico?.kind !== 'bot' || pkg.cortico.api !== 7) {
    throw new Error('Canonical memory package and source manifest do not agree.');
  }
  const paths = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path || /[\\:\0]/.test(file.path)
        || file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '.' || part === '..')
        || paths.has(file.path)) throw new Error('Unsafe or duplicate memory source path.');
    paths.add(file.path);
    const bytes = await readFile(join(source, file.path));
    if (hash(bytes) !== file.sha256 || bytes.length !== file.bytes) {
      throw new Error('Canonical memory source changed since its reviewed manifest: ' + file.path);
    }
  }
  if (!paths.has('package.json')) throw new Error('Memory identity is absent from its source manifest.');
  return { source, pkg, manifest, manifestBytes, canonicalManifestSha256: hash(manifestBytes) };
}

export async function packageSelfMem(productRoot = root) {
  const before = await verifyCanonicalSelfMem(productRoot);
  await mkdir(join(productRoot, '.build'), { recursive: true });
  const staging = await mkdtemp(join(productRoot, '.build/self-mem-package-'));
  const packed = JSON.parse(execFileSync(process.execPath, [fusionNpmCli(), 'pack', before.source,
    '--ignore-scripts', '--json', '--pack-destination', staging], { encoding: 'utf8', windowsHide: true }))[0];
  const archive = packed.filename;
  if (!/^[A-Za-z0-9._-]+\.tgz$/.test(archive)) throw new Error('Unsafe memory archive name.');
  const stagedArchive = join(staging, archive);
  for (const entry of packed.files) {
    // Check npm's actual payload, including files beyond the provenance entries.
    const path = entry.path;
    if (/^[\\/]|[\0:]|(?:^|\/)\.\.(?:\/|$)/.test(path)) throw new Error('Unsafe packed memory path.');
    const content = execFileSync('tar', ['-xOf', stagedArchive, 'package/' + path], { windowsHide: true });
    if (!content.equals(await readFile(join(before.source, path)))) throw new Error('Memory archive differs from canonical source: ' + path);
  }
  const after = await verifyCanonicalSelfMem(productRoot);
  if (after.canonicalManifestSha256 !== before.canonicalManifestSha256) throw new Error('Memory source changed during packaging.');
  const archiveBytes = await readFile(stagedArchive);
  const lock = {
    format: 1, package: before.pkg.name, version: before.pkg.version, archive, archiveSha256: hash(archiveBytes),
    contract: { kind: before.pkg.cortico.kind, api: before.pkg.cortico.api },
    sourceManifest: 'self-mem-build-manifest.json', canonicalSource: 'vendor/host-self-mem/package',
    canonicalManifestSha256: before.canonicalManifestSha256,
    provenance: 'Host and standalone memory payloads use the same reviewed canonical package; no independent source copy.',
  };
  await copyFile(stagedArchive, join(productRoot, 'vendor', archive));
  await writeFile(join(productRoot, 'vendor/self-mem-build-manifest.json'), before.manifestBytes);
  await writeFile(join(productRoot, 'vendor/self-mem-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  return { ...lock, verifiedPayloadFiles: packed.files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await packageSelfMem()));
}
