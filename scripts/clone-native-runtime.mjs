/** Copy a verified runtime closure without following its cyclic dependency links. */
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { relocateDshRuntime } from './stage-dsh-runtime.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => path === root || path.startsWith(root + sep);

export async function cloneNativeRuntime(sourcePath, targetPath) {
  const source = await realpath(resolve(sourcePath));
  const target = resolve(targetPath);
  if (inside(source, target) || inside(target, source)) throw new Error('Source and destination runtimes must be separate.');
  try { await lstat(target); throw new Error('Runtime destination already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = JSON.parse(await readFile(join(source, 'runtime-manifest.json'), 'utf8'));
  const entries = [];
  const differences = [];
  await mkdir(target, { recursive: true });
  for (const pkg of manifest.packages) {
    const from = resolve(source, pkg.output);
    const to = resolve(target, pkg.output);
    if (!inside(source, from) || !inside(target, to)) throw new Error('Runtime payload escapes its root.');
    let overlay;
    try { overlay = JSON.parse(await readFile(join(from, '.cortico-host-routing-v1/receipt.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const overlayFiles = new Map((overlay?.payloadFiles ?? []).map(file => [file.path, file.sha256]));
    if (overlay?.overlaySha256) overlayFiles.set('lib/index.js', overlay.overlaySha256);
    for (const entry of pkg.files) {
      const actual = digest(await readFile(join(from, entry.path)));
      if (actual !== entry.sha256) {
        if (overlayFiles.get(entry.path.replaceAll('\\', '/')) !== actual) throw new Error('Unreceipted runtime source hash mismatch: ' + join(pkg.output, entry.path));
        differences.push({ package: pkg.name, path: entry.path, recorded: entry.sha256, actual });
      }
    }
    await cp(from, to, { recursive: true, dereference: false, filter: file => {
      const relative = file.slice(from.length).replaceAll('\\', '/');
      return !relative.split('/').includes('node_modules');
    } });
    const files = [];
    async function inventory(directory, prefix = '') {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.name === 'node_modules' || item.name.startsWith('runtime-')) continue;
        if (item.isSymbolicLink()) throw new Error('Unexpected link in package payload: ' + item.name);
        if (item.isDirectory()) await inventory(join(directory, item.name), prefix + item.name + '/');
        else files.push({ path: prefix + item.name, sha256: digest(await readFile(join(directory, item.name))) });
      }
    }
    await inventory(to);
    pkg.files = files;
    entries.push(...files);
  }
  await copyFile(join(source, 'runtime-links.json'), join(target, 'runtime-links.json'));
  await writeFile(join(target, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(target, 'runtime-clone-receipt.json'), JSON.stringify({ source, differences, createdAt: new Date().toISOString() }, null, 2) + '\n');
  await relocateDshRuntime(target);
  const result = { source, target, files: entries.length, packages: manifest.packages.length, version: manifest.cliVersion };
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/clone-native-runtime.mjs <source> <new-destination>');
  console.log(JSON.stringify(await cloneNativeRuntime(process.argv[2], process.argv[3]), null, 2));
}
