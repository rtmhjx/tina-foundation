import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertBackendPatches, backendProfileVersion, loadBackendProfile } from './dsh-backend-profile.mjs';

const sessionModule = fileURLToPath(new URL('./dsh-native-session.mjs', import.meta.url));
const bootName = 'tina-dsh-embedded';
let processOwner;

async function distribution(dshRoot, expectedVersion) {
  if (typeof dshRoot !== 'string' || !isAbsolute(dshRoot)) throw new Error('dshRoot must be absolute.');
  const root = await realpath(dshRoot);
  for (const dir of [join(root, 'apps', 'cli'), root]) {
    const installAnchor = join(dir, 'package.json');
    let manifest;
    try { manifest = JSON.parse(await readFile(installAnchor, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (manifest.name !== '@deepseek-ai/dsh') continue;
    if (expectedVersion && manifest.version !== expectedVersion) throw new Error(`Expected DSH ${expectedVersion}.`);
    const resolver = createRequire(installAnchor);
    return { installAnchor, version: manifest.version,
      importPackage: (name) => import(pathToFileURL(resolver.resolve(name))) };
  }
  throw new Error('No native @deepseek-ai/dsh package was found at dshRoot.');
}

async function stateDirectories(deploymentDir) {
  if (typeof deploymentDir !== 'string' || !isAbsolute(deploymentDir)) throw new Error('deploymentDir must be absolute.');
  await mkdir(deploymentDir, { recursive: true });
  const root = join(await realpath(deploymentDir), 'dsh-embedded');
  const marker = join(root, '.tina-dsh-embedded-v1');
  try {
    await mkdir(root);
    await writeFile(marker, 'tina-dsh-embedded-v1\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (await realpath(root) !== root || !(await lstat(marker)).isFile()
    || await readFile(marker, 'utf8') !== 'tina-dsh-embedded-v1\n') {
    throw new Error('Tina embedded DSH requires its own state directory.');
  }
  const homeDir = join(root, 'home');
  const workspaceDir = join(root, 'workspace');
  for (const path of [homeDir, workspaceDir]) {
    await mkdir(path, { recursive: true });
    if (await realpath(path) !== path) throw new Error('Tina embedded DSH refuses redirected state.');
  }
  return { homeDir, workspaceDir };
}

function modelFixtureEnvironment(localProvider) {
  if (localProvider === undefined) return {};
  const url = new URL(localProvider);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.search || url.hash) {
    throw new Error('localProvider must be a credential-free HTTP endpoint on 127.0.0.1.');
  }
  return { DEEPSEEK_BASE_URL: url.href, DEEPSEEK_API_KEY: 'tina-local-model-fixture' };
}

function startProcessScope(owner, homeDir, workspaceDir) {
  const oldCwd = process.cwd();
  const environment = {
    DSH_HOME: homeDir,
    DSH_AGENTS_HOME: join(homeDir, 'agents'),
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_TOOLS_MODE: 'native',
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  process.chdir(workspaceDir);
  Object.assign(process.env, environment);
  return {
    environment,
    restore() {
      try {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        process.chdir(oldCwd);
      } finally {
        if (processOwner === owner) processOwner = undefined;
      }
    },
  };
}

/** Boot native DSH in one dedicated backend process. */
export async function openEmbeddedDsh({ deploymentDir, dshRoot, expectedVersion, localProvider,
  surface = 'web', tinaMode = true, editablePersona = false, signal } = {}) {
  signal?.throwIfAborted();
  if (surface !== 'headless' && surface !== 'web') throw new Error('Invalid embedded DSH surface.');
  const headless = surface === 'headless';
  if (processOwner) throw new Error('This backend already owns an embedded DSH profile.');
  const owner = {};
  processOwner = owner;

  let scope;
  let ctx;
  let closing;
  const stop = () => {
    closing ??= Promise.resolve().then(async () => {
      signal?.removeEventListener('abort', onAbort);
      try { await ctx?.fiber.dispose(); }
      finally {
        if (scope) scope.restore();
        else if (processOwner === owner) processOwner = undefined;
      }
    });
    return closing;
  };
  function onAbort() { void stop().catch(() => {}); }

  try {
    const fixtureEnvironment = modelFixtureEnvironment(localProvider);
    const { homeDir, workspaceDir } = await stateDirectories(deploymentDir);
    const { installAnchor, version, importPackage } = await distribution(dshRoot, expectedVersion);
    if (headless && version !== backendProfileVersion) {
      throw new Error(`Tina backend profile requires DSH ${backendProfileVersion}.`);
    }
    const [appBoot, cmdline, launch] = await Promise.all([
      importPackage('@deepseek-ai/dsh-app-boot'),
      importPackage('@deepseek-ai/dsh-cmdline'),
      importPackage('@deepseek-ai/dsh-launch-environment'),
    ]);
    signal?.throwIfAborted();
    scope = startProcessScope(owner, homeDir, workspaceDir);
    // The explicit snapshot is the DSH credentials/endpoint source. Boot does
    // not read either the invoking project's .env or another runtime's HOME.
    const snapshot = launch.createLaunchEnvironmentSnapshot([{
      source: 'process', values: { ...scope.environment, ...fixtureEnvironment },
    }]);
    const backend = headless && await loadBackendProfile(appBoot, bootName, installAnchor, homeDir);
    const profile = backend ? backend.profile : appBoot.loadProfile(bootName, 'web', installAnchor, homeDir);
    await appBoot.healProfilesModuleFallback({ installAnchor, profile, home: homeDir });
    const rootConfig = join(profile.dir, 'tina-embedded-root.yml');
    await writeFile(rootConfig, '[]\n');
    const bundlePatches = backend ? backend.bundlePatches : profile.layers.flatMap((layer) => layer.patches);
    const homePatch = join(homeDir, appBoot.PROFILE_PATCH_FILENAME);
    const overrides = [
      { id: 'session-telemetry-otel', disabled: true },
      ...headless ? [
        { id: 'session-controller', config: { nativeOpen: false } },
        { id: 'settings-controller', config: { nativeOpen: false } },
      ] : [
        { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] } },
        { id: 'webserver', config: { host: '127.0.0.1', port: 0,
          compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } },
      ],
      { insert: [{ id: 'tina-native-session', name: pathToFileURL(sessionModule).href,
        config: { workspaceDir, tinaMode: tinaMode === true, editablePersona: editablePersona === true, embedded: true } }] },
    ];
    const compose = () => {
      const patches = [
        ...bundlePatches,
        ...appBoot.loadOptionalPatches(bootName, profile.patchPath) ?? [],
        ...appBoot.loadOptionalPatches(bootName, homePatch) ?? [],
        ...overrides,
      ];
      if (headless) assertBackendPatches(appBoot, patches);
      return structuredClone(patches);
    };

    signal?.throwIfAborted();
    ctx = await appBoot.boot(bootName, rootConfig, compose(), (host) => {
      ctx = host;
      host.provide(launch.DSH_LAUNCH_ENVIRONMENT_KEY, snapshot);
      cmdline.provideCmdline(host, {
        args: headless ? [] : ['--host', '127.0.0.1', '--port', '0', '--no-open'],
        exit: onAbort,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      signal?.throwIfAborted();
    });
    signal?.throwIfAborted();
    if (profile.patchReload === 'live') {
      if (!ctx.get('hmr')) await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } });
      for (const filename of [profile.patchPath, homePatch]) {
        await appBoot.watchUserPatches(ctx, { binName: bootName, filename, compose });
      }
    }
    signal?.throwIfAborted();
    if (!ctx.get('connection') || !ctx.get('tinaDshSession')) throw new Error('Native embedded DSH did not become ready.');
    const runtime = {
      ctx, pid: process.pid, homeDir, workspaceDir, profile: profile.name, version, importPackage, stop,
      sendText: (input) => ctx.tinaDshSession.sendText(input),
    };
    const server = ctx.get('webServer');
    if (headless) {
      if (!ctx.get('settingsController') || !ctx.get('credentialsController')) {
        throw new Error('Native embedded DSH backend did not become ready.');
      }
      return Object.freeze(runtime);
    }
    if (!server || server.host !== '127.0.0.1' || !Number.isInteger(server.port) || server.port <= 0) {
      throw new Error('Native embedded DSH Web did not become ready.');
    }
    const url = `http://127.0.0.1:${server.port}`;
    return Object.freeze({
      ...runtime, url,
      browserUrl: () => ctx.connection.authenticatedUrl(url),
    });
  } catch (error) {
    await stop();
    throw error;
  }
}
