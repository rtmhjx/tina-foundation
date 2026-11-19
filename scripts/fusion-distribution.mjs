/** Both release forms consume this canonical source boundary. */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeComponents } from './native-components.mjs';

export const nativeSourceDirectories = Object.freeze([
  ...Object.values(nativeComponents), 'dsh-file-upload',
]);

export async function currentSourceFiles(root) {
  // Source modules are a deliberate top-level allowlist. Historical prototypes,
  // fixtures, deployments and dependency trees cannot enter through recursion.
  return (await readdir(join(root, 'src'), { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
    .map(entry => 'src/' + entry.name).sort();
}

export async function copyCurrentSources(root, destination) {
  const files = await currentSourceFiles(root);
  const allowed = new Set(files);
  const manifest = [];
  await mkdir(join(destination, 'src'), { recursive: true });
  for (const file of files) {
    const bytes = await readFile(join(root, file));
    const text = bytes.toString('utf8');
    // Covers literal imports, re-exports and the dynamic native-session URL.
    for (const [, path] of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bnew\s+URL\(\s*)['"]\.\/([^'"\n]+\.mjs)['"]/g)) {
      if (!allowed.has('src/' + path)) throw new Error('Current source depends on excluded module: ' + file + ' -> ' + path);
    }
    await copyFile(join(root, file), join(destination, file));
    manifest.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const sourceTreeSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const receipt = { format: 1, sourceTreeSha256, entryPoints: {
    standalone: 'src/fusion-app.mjs', launcher: 'src/fusion-launcher.mjs', host: 'src/host-entry.mjs',
  }, dynamicModules: ['src/dsh-native-session.mjs'], legacyIncluded: false, files: manifest };
  await writeFile(join(destination, 'FUSION-SOURCE.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
