import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Include from '@deepseek-ai/cordis-plugin-include';
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader';

const fiberStates = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'];

/** Open a native Loader tree. The caller owns the root fiber and its disposal. */
export async function openRuntime(configPath) {
  const configUrl = pathToFileURL(resolve(configPath));
  const ctx = new Context();
  ctx.baseUrl = new URL('.', configUrl).href;

  try {
    await ctx.plugin(Loader);
    if (!ctx.loader.internal) {
      throw new Error('Run Node with --expose-internals so Loader can resolve packages from the configuration directory.');
    }
    ctx.loader.builtins.include = Include;
    ctx.loader.builtins.group = Group;
    await ctx.loader.create({
      id: 'include',
      name: 'cordis:include',
      config: { path: configUrl.href },
    });
    await ctx.loader.await();
    return ctx;
  } catch (error) {
    try {
      await ctx.fiber.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Runtime startup and cleanup both failed.');
    }
    throw error;
  }
}

/** List runtime state without exposing plugin configuration values. */
export function inspectRuntime(ctx) {
  return [...ctx.loader.entries()].map(({ options, fiber }) => ({
    id: options.id,
    name: options.name,
    state: fiber ? fiberStates[fiber.state] ?? 'UNKNOWN' : options.disabled ? 'DISABLED' : 'INACTIVE',
    disabled: Boolean(options.disabled),
  }));
}
