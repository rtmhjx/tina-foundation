import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolve from the canonical framework dependency anchor. In a host npm package
// this reaches its bundled root dependency; in a standalone checkout it reaches
// the framework's pinned compiler without adding a second dependency install.
const { transformSync } = createRequire(new URL('../upstream/cortico/package.json', import.meta.url))('esbuild');

const framework = fileURLToPath(new URL('../upstream/cortico/', import.meta.url));

// Cortico's public SDK ships TypeScript. Compile only this package's framework
// and the attached deployment's extensions, including when npm places them in
// node_modules. Native host imports keep their original URLs and class identity.
function acquireCompiler(stateDir) {
  const roots = [framework];
  if (typeof stateDir === 'string') roots.push(join(resolve(stateDir), 'extensions') + sep);
  const hook = registerHooks({
    load(url, context, next) {
      if (!url.startsWith('file:')) return next(url, context);
      const path = fileURLToPath(url);
      if (!/\.tsx?$/.test(path) || path.endsWith('.d.ts') || !roots.some(root => path.startsWith(root))) return next(url, context);
      const source = transformSync(readFileSync(path, 'utf8'), {
        loader: path.endsWith('.tsx') ? 'tsx' : 'ts', format: 'esm', target: 'node24',
        sourcefile: path, sourcemap: 'inline', tsconfigRaw: '{}',
      }).code;
      return { format: 'module', source, shortCircuit: true };
    },
  });
  let active = true;
  return () => { if (active) { active = false; hook.deregister(); } };
}

const releaseBootstrap = acquireCompiler();
let api;
try { api = await import('./host-plugin.mjs'); }
finally { releaseBootstrap(); }

export const name = api.name;
export const inject = api.inject;
export const inspectHostCapabilities = api.inspectHostCapabilities;
export const inspectHostContextCapabilities = api.inspectHostContextCapabilities;

export async function mountHostPlugin(ctx, options = {}) {
  const release = acquireCompiler(options.stateDir);
  try {
    return await api.mountHostPlugin(ctx, { ...options, [api.HOST_COMPILER_RELEASE]: release });
  } catch (error) { release(); throw error; }
}

export async function apply(ctx, config) {
  const mounted = await mountHostPlugin(ctx, config);
  ctx.provide('corticoHostPlugin', mounted);
}
