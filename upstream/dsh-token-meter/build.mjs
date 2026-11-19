import { build } from 'esbuild';
import { readdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = dirname(fileURLToPath(import.meta.url));
for (const name of await readdir(join(base, 'src'))) {
  if (name.endsWith('.js') || name.endsWith('.d.ts')) await copyFile(join(base, 'src', name), join(base, 'lib', 'types', name));
}
await build({ entryPoints: [join(base, 'src', 'index.js')], outfile: join(base, 'lib', 'index.js'), bundle: true,
  platform: 'node', format: 'esm', packages: 'external', target: 'node22', sourcemap: false });
