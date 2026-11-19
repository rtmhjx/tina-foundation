import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openRuntime } from './runtime.mjs';
import * as dshPlugin from './dsh-plugin.mjs';
import { inspectCoopanionStage, launchCoopanion, stageCoopanion } from './coopanion-runtime.mjs';
import { createCorticoMarket } from './cortico-market.mjs';
import { openChatRuntime } from './chat-runtime.mjs';
import { applyCoopanionDshChat } from '../../integration/coopanion/dsh-chat.mjs';
import { applyEmbeddedStage } from '../../integration/coopanion/embedded-stage.mjs';
import { applyTinaEngineStage } from '../../integration/coopanion/tina-engine-stage.mjs';
import { applyEmbeddedWorldStage } from '../../integration/coopanion/world-stage.mjs';

async function stageTinaProduct(stage) {
  await applyEmbeddedStage(stage);
  await applyTinaEngineStage(stage);
  await applyEmbeddedWorldStage(stage);
}

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const defaultDshRoot = process.env.CORTICO_FUSION_DSH_ROOT ?? '';
const testedDshVersion = '0.1.5-rc.2';
const defaultCoopanionSource = process.env.COOPANION_SOURCE ?? '';
const stagedName = 'coopanion-0.2.13-tina-dsh.1';

const desktopPlugin = {
  name: 'tina-coopanion',
  inject: ['dshRuntime'],
  async apply(ctx, options) {
    const starting = startDesktop(ctx.dshRuntime, options);
    ctx.effect(() => async () => {
      const app = await starting.catch(() => undefined);
      await app?.close();
    });
    ctx.provide('tinaDesktop', await starting);
  },
};

async function ensureStage(stateDir, coopanionSource, name, patches) {
  const distributionDir = join(stateDir, 'runtime', name);
  await mkdir(dirname(distributionDir), { recursive: true });
  const existing = await inspectCoopanionStage(distributionDir).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!existing) {
    await stageCoopanion({
      sourceDir: coopanionSource,
      distributionDir,
      patches,
    });
  }
  return distributionDir;
}

async function startDesktop(dsh, { stateDir, coopanionSource, headless }) {
  const distributionDir = await ensureStage(stateDir, coopanionSource, stagedName, applyCoopanionDshChat);

  const chat = await openChatRuntime({ stateDir: join(stateDir, 'chat'), sendText: request => dsh.sendText(request) });
  try {
    const desktop = await launchCoopanion({
      distributionDir,
      stateDir: join(stateDir, 'coopanion'),
      dshEndpoint: chat.url,
      dshToken: chat.token,
      dshBrowserUrl: String(dsh.browserUrl()),
      headless,
      readyTimeoutMs: 120_000,
    });
    return {
      ...desktop,
      market: createCorticoMarket(desktop.origin),
      async close() {
        try {
          await desktop.close();
        } finally {
          await chat.close();
        }
      },
    };
  } catch (error) {
    await chat.close();
    throw error;
  }
}

export async function openTinaApp({
  stateDir,
  dshRoot = defaultDshRoot,
  coopanionSource = defaultCoopanionSource,
  headless = false,
  localProvider,
  singleBackend = true,
} = {}) {
  stateDir = resolve(stateDir ?? join(root, singleBackend ? '.tina-app-product' : '.tina-app'));
  await mkdir(stateDir, { recursive: true });
  if (singleBackend) {
    const distributionDir = await ensureStage(stateDir, coopanionSource, 'coopanion-0.2.13-tina-product.6', stageTinaProduct);
    const desktop = await launchCoopanion({
      distributionDir, stateDir: join(stateDir, 'embedded-coopanion'), headless,
      embeddedDsh: { dshRoot, deploymentDir: join(stateDir, 'embedded-dsh'), localProvider },
      readyTimeoutMs: 240_000,
    });
    return {
      dsh: { workspaceDir: desktop.dshWorkspaceDir, pid: desktop.dshPid },
      desktop: { ...desktop, market: createCorticoMarket(desktop.origin) },
      stateDir, close: () => desktop.close(),
    };
  }
  const ctx = await openRuntime(join(root, 'cordis.yml'));
  try {
    await ctx.plugin(dshPlugin, {
      dshRoot, expectedVersion: testedDshVersion, deploymentDir: join(stateDir, 'dsh'),
      localProvider, startupTimeoutMs: 180_000,
    });
    await ctx.plugin(desktopPlugin, { stateDir, coopanionSource, headless });
    const { dshRuntime: dsh, tinaDesktop: desktop } = ctx;
    if (!dsh || !desktop) throw new Error('The Tina app did not reach ready.');
    return { ctx, dsh, desktop, stateDir, close: () => ctx.fiber.dispose() };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--single-backend' || flag === '--legacy-backend') {
      options.singleBackend = flag === '--single-backend';
      continue;
    }
    if (flag === '--headless' || flag === '--inspect') {
      options[flag.slice(2)] = true;
      continue;
    }
    const key = { '--state': 'stateDir', '--dsh-root': 'dshRoot', '--coopanion-source': 'coopanionSource' }[flag];
    const value = args[index + 1];
    if (!key || !value || value.startsWith('--')) throw new Error('Invalid Tina option: ' + flag);
    options[key] = value;
    index++;
  }
  if (options.inspect) options.headless = true;
  return options;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    function stop() {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.stdin.off('end', stop);
      child.off('exit', stop);
      process.stdin.pause();
      resolve();
    }
    if (child.exitCode !== null || child.signalCode !== null) return stop();
    child.once('exit', stop);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
    process.stdin.resume();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const app = await openTinaApp(options);
  try {
    console.log(JSON.stringify({
      event: 'ready',
      dsh: app.dsh.url,
      coopanion: app.desktop.origin,
      market: String(app.desktop.market.url),
      stateDir: app.stateDir,
      ...(app.desktop.backendPid ? { backendPid: app.desktop.backendPid, dshPid: app.dsh.pid } : {}),
    }));
    if (!options.inspect) {
      app.desktop.openChat();
      await waitForExit(app.desktop.child);
    }
  } finally {
    await app.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
