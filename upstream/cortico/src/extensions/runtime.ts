/**
 * 将扩展的 cortico/<路径> 导入映射到框架 src/<路径>。
 * 使用同步 module.registerHooks 与 tsx 的解析链协作；映射后继续调用下一个解析器，
 * 使最终 URL 与框架内部导入一致，保留共享模块实例。扩展须使用 type=module。
 * 上一版契约的包 import 改过名的模块时,路径先经 previous-contract.ts 换成新名。
 * childExecArgv 保留父进程加载器并通过 --import 注册本模块，供引擎子进程使用。
 */
import { registerHooks } from 'node:module';
import { FRAMEWORK_SPECIFIER } from './manifest.ts';
import { previousContractModulePath } from './previous-contract.ts';

const PREFIX = `${FRAMEWORK_SPECIFIER}/`;
/** `src/` 的 URL:本文件在 `src/extensions/`。 */
const SRC_URL = new URL('../', import.meta.url);
const FLAG = Symbol.for('cortico.extensions.resolver.leases.v1');
type ResolverState = {
  owners: Map<symbol, readonly string[] | null>;
  hooks: ReturnType<typeof registerHooks>;
};
const g = globalThis as unknown as Record<symbol, unknown>;
const resolverStates = () => (g[FLAG] ??= new Map<string, ResolverState>()) as Map<string, ResolverState>;
let permanent: (() => void) | undefined;

/** A host owns its resolver just as it owns tools and World listeners. */
export function acquireFrameworkResolver({ roots }: { roots?: readonly string[] } = {}): () => void {
  const states = resolverStates();
  let state = states.get(SRC_URL.href);
  if (!state) {
    const owners = new Map<symbol, readonly string[] | null>();
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        const allowed = [...owners.values()].some(paths => paths === null
          || Boolean(context.parentURL && paths.some(path => context.parentURL!.startsWith(path))));
        if (allowed && specifier.startsWith(PREFIX)) {
          const path = specifier.slice(PREFIX.length);
          return next(new URL(previousContractModulePath(path, context.parentURL) ?? path, SRC_URL).href, context);
        }
        return next(specifier, context);
      },
    });
    state = { owners, hooks };
    states.set(SRC_URL.href, state);
  }
  const token = Symbol('Cortico resolver owner');
  state.owners.set(token, roots ? [SRC_URL.href, ...roots.map(path => path.endsWith('/') ? path : path + '/')] : null);
  const owned = state;
  return () => {
    if (!owned.owners.delete(token) || owned.owners.size) return;
    owned.hooks.deregister();
    if (states.get(SRC_URL.href) === owned) states.delete(SRC_URL.href);
    if (!states.size && g[FLAG] === states) delete g[FLAG];
  };
}

/** 重复注册无效。 */
export function registerFrameworkResolver(): void {
  // loadExtensions calls this legacy entry point. An acquired host lease already
  // supplies the resolver and must never be converted into a permanent hook.
  if (resolverStates().get(SRC_URL.href)?.owners.size || permanent) return;
  permanent = acquireFrameworkResolver();
}

/** 本文件的 URL:`--import` 它就等于调了一次 {@link registerFrameworkResolver}。 */
export const RESOLVER_URL = import.meta.url;

/** 保留父进程加载器参数；未配置时补充 --import tsx，最后导入本模块注册解析钩子。 */
export function childExecArgv(): string[] {
  const inherited = process.execArgv.some((a) => /[\\/]tsx[\\/]|(^|\s)tsx$/.test(a))
    ? [...process.execArgv]
    : ['--import', 'tsx'];
  return [...inherited, '--import', RESOLVER_URL];
}

// Engine children explicitly preload this URL. Ordinary imports have no effect.
if (process.execArgv.includes(RESOLVER_URL)) registerFrameworkResolver();
