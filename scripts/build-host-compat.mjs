import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeComponents } from './native-components.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const buildOptions = process.argv.slice(2);
if (buildOptions.some(value => !value.startsWith('--build-runtime='))) {
  throw new Error('Supported build option: --build-runtime=<reviewed native dependency directory>.');
}
for (const component of Object.keys(nativeComponents)) {
  execFileSync(process.execPath, [join(scripts, 'build-native-component.mjs'), '--component=' + component, ...buildOptions],
    { stdio: 'inherit' });
}
