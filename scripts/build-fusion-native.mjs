import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildNativeComponents } from './native-component-build.mjs';

await buildNativeComponents({ runtime: process.argv[2] });
execFileSync(process.execPath, [join(import.meta.dirname, 'build-dsh-file-upload.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
