import { resolve, relative, join, isAbsolute } from 'node:path';
import { openEmbeddedDsh } from '../src/dsh-embedded.mjs';

const root = resolve(import.meta.dirname, '..');
const stateDir = resolve(process.argv[2]);
const owned = relative(join(root, '.tina-fusion-dev'), stateDir);
if (!owned || isAbsolute(owned) || owned.startsWith('..') || !owned.startsWith('official-')) {
  throw new Error('Only isolated official test states are accepted.');
}
const native = await openEmbeddedDsh({
  dshRoot: join(root, 'runtime/dsh-0.1.5-rc.2'), deploymentDir: join(stateDir, 'native'), surface: 'headless',
});
try {
  await native.ctx.credentialsController.unset('DEEPSEEK_API_KEY');
  const state = await native.ctx.credentialsController.describe(['DEEPSEEK_API_KEY']);
  console.log(JSON.stringify({ credentialConfigured: state.DEEPSEEK_API_KEY.configured }));
} finally { await native.stop(); }
