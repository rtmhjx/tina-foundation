import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const source = await readFile(new URL('./src/client.cjs', import.meta.url), 'utf8');
const argument = name => process.argv.slice(2).find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const id = argument('id') ?? '@tina/cortico-host-client';
const output = argument('out') ?? new URL('./lib/client.js', import.meta.url);
await mkdir(output instanceof URL ? new URL('./', output) : dirname(output), { recursive: true });
// Same closure-factory ABI used by native DSH clientBundle; source is compiled as a new module.
await writeFile(output,
  'window.__ModuleLoader__.load({id:' + JSON.stringify(id) + ',factory:(require)=>{\n'
  + 'const module={exports:{}};const exports=module.exports;\n' + source + '\nreturn module.exports;\n}});\n');
