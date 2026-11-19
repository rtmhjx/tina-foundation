import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { supervise } from '../upstream/cortico/bin/cortico.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The native Cortico supervisor only relaunches an explicitly requested restart. */
export async function launchFusion({
  stateDir, dshRoot, port, env = process.env, log, warn,
} = {}) {
  return supervise('Tina', [], false, {
    entry: join(root, 'src', 'fusion-worker.mjs'),
    execArgv: ['--expose-internals', '--import', pathToFileURL(join(root, 'upstream', 'cortico', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href],
    cwd: root,
    env: {
      ...env,
      CORTICO_START_PAUSED: env.CORTICO_START_PAUSED ?? '0',
      ...(stateDir === undefined ? {} : { CORTICO_FUSION_STATE: resolve(stateDir) }),
      ...(dshRoot === undefined ? {} : { CORTICO_FUSION_DSH_ROOT: resolve(dshRoot) }),
      ...(port === undefined ? {} : { CORTICO_FUSION_PORT: String(port) }),
    },
    ...(log ? { log } : {}),
    ...(warn ? { warn } : {}),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await launchFusion(); }
  catch { console.error('Fusion launcher failed.'); process.exitCode = 1; }
}
