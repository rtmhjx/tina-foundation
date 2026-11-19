import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const defaultSource = 'F:\\AI\\C\\Coopanion-0.2.13-mobile';
const stageManifest = 'tina-coopanion-stage.json';
const sourceVersion = '0.2.13';
const runtimeFiles = [
  'Coopanion.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll',
  'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'LICENSE.electron.txt',
  'LICENSES.chromium.html', 'locales', 'resources.pak', 'snapshot_blob.bin',
  'v8_context_snapshot.bin', 'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll',
];
const appFiles = ['app', 'build', 'core', 'docs', 'mingit', 'package.json'];
const uiFiles = ['build/console/index.html', 'build/console/index.js', 'build/console/styles.css'];
const inheritedEnvironment = new Set([
  'APPDATA', 'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'PATHEXT',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'USERPROFILE', 'WINDIR',
]);

function isWithin(parent, child) {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

function requireSeparate(left, right) {
  if (isWithin(left, right) || isWithin(right, left)) {
    throw new Error('Coopanion source, staged program and Tina state must use separate directories.');
  }
}

async function copyProgramEntry(from, to) {
  await cp(from, to, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async path => {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('A portable program entry unexpectedly links outside its copy.');
      return true;
    },
  });
}

async function dependencyEntries(sourceApp) {
  const modules = join(sourceApp, 'node_modules');
  const entries = await readdir(modules, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      return (await readdir(join(modules, entry.name))).map(name => join('node_modules', entry.name, name));
    }
    return [join('node_modules', entry.name)];
  }))).flat();
}

async function patchFile(path, replacements) {
  let source = await readFile(path, 'utf8');
  for (const [original, replacement] of replacements) {
    const index = source.indexOf(original);
    if (index < 0 || source.indexOf(original, index + original.length) >= 0) {
      throw new Error(`The packaged Coopanion ${basename(path)} differs from the supported ${sourceVersion} release.`);
    }
    source = source.replace(original, () => replacement);
  }
  await writeFile(path, source);
}

async function adaptProgram(appDir) {
  const desktopPet = join(appDir, 'node_modules', 'cortico-world-desktop-pet', 'src');
  const tasks = await Promise.allSettled([
    patchFile(join(appDir, 'app', 'main.cjs'), [
      ["const APP_ID = 'ai.pal.coopanion';", "const APP_ID = 'local.tina.cordis';"],
      ["core.on('ready', ({ language: next }) => {", `core.on('ready', ({ language: next, port, keyMissing }) => {
  process.send?.({ type: 'companion:ready', port, dataDir: core.dataDir, keyMissing, language: next });`],
      ["core.on('open', (path) => openSettings(path));", `core.on('open', (path) => openSettings(path));
process.on('message', (message) => {
  if (message?.type === 'companion:shutdown') app.quit();
  if (message?.type === 'tina:open-chat') openSettings('#/chat');
});
process.on('disconnect', () => app.quit());`],
      ['    { label: t.trayRestart, click: () => void core.restart() },', `    ...dshBrowserItem(),
    { label: t.trayRestart, click: () => void core.restart() },`],
      ['function buildTray() {', `function dshBrowserItem() {
  const raw = process.env.TINA_COO_DSH_BROWSER_URL;
  if (!raw) return [];
  let url;
  try { url = new URL(raw); } catch { return []; }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) return [];
  return [{ label: 'DSH 模型和工具', click: () => void shell.openExternal(url.href).catch(() => {}) }];
}

function buildTray() {`],
      ['answer({ cancel: !(isLocal(details.url) || details.url === RELEASE_CHECK || marketImage) });',
        'answer({ cancel: !(isLocal(details.url) || marketImage) });'],
    ]),
    patchFile(join(appDir, 'core', 'telemetry.ts'), [
      ['  send(): Promise<void> {', '  send(): Promise<void> {\n    if (process.env.TINA_COO_PRIVATE_RUN === \'1\') return Promise.resolve();'],
    ]),
    patchFile(join(desktopPet, 'definition.ts'), [
      ['      const world = new DesktopPetWorld({\n        cfg: ctx.cfg,', `      const cfg = process.env.TINA_COO_HEADLESS === '1' ? {
        ...ctx.cfg,
        window: { ...ctx.cfg.window, enabled: false },
        asr: { ...ctx.cfg.asr, enabled: false },
        typeKey: { ...ctx.cfg.typeKey, enabled: false },
        cua: { ...ctx.cfg.cua, enabled: false },
      } : ctx.cfg;
      const world = new DesktopPetWorld({
        cfg,`],
    ]),
  ]);
  const failure = tasks.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function fingerprints(appDir) {
  return Object.fromEntries(await Promise.all(uiFiles.map(async file => [
    file, createHash('sha256').update(await readFile(join(appDir, file))).digest('hex'),
  ])));
}

/** Copy packaged program files only. The caller may add adapters before the copy is committed. */
export async function stageCoopanion({ sourceDir = process.env.TINA_COO_SOURCE_DIR || defaultSource, distributionDir, patches }) {
  const source = await realpath(resolve(sourceDir));
  const distribution = await canonicalPath(resolve(distributionDir));
  requireSeparate(source, distribution);
  try {
    await lstat(distribution);
    throw new Error('The Coopanion staging directory already exists.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sourceApp = join(source, 'resources', 'app');
  const { version, coopanion } = JSON.parse(await readFile(join(sourceApp, 'package.json'), 'utf8'));
  if (version !== sourceVersion || coopanion?.channel !== 'portable') {
    throw new Error(`Tina requires the packaged Windows Coopanion ${sourceVersion} portable release.`);
  }
  const parent = dirname(distribution);
  await mkdir(parent, { recursive: true });
  const dependencies = await dependencyEntries(sourceApp);
  const scratch = await mkdtemp(join(parent, '.tina-coo-stage-'));
  try {
    const appDir = join(scratch, 'resources', 'app');
    await mkdir(appDir, { recursive: true });
    const copied = await Promise.allSettled([
      ...runtimeFiles.map(file => copyProgramEntry(join(source, file), join(scratch, file))),
      ...[...appFiles, ...dependencies].map(file => copyProgramEntry(join(sourceApp, file), join(appDir, file))),
    ]);
    const failure = copied.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    await adaptProgram(appDir);
    await patches?.({ appDir, distributionDir: scratch });
    const assets = await fingerprints(sourceApp);
    const stagedAssets = await fingerprints(appDir);
    if (uiFiles.some(file => assets[file] !== stagedAssets[file])) {
      throw new Error('A staged Coopanion renderer file differs from the source release.');
    }
    await writeFile(join(scratch, stageManifest), JSON.stringify({ sourceDir: source, version, assets }, null, 2) + '\n');
    await rename(scratch, distribution);
  } catch (error) {
    const target = await realpath(scratch);
    if (dirname(target) === await realpath(parent) && basename(target).startsWith('.tina-coo-stage-')) {
      await rm(target, { recursive: true, force: true });
    }
    throw error;
  }
  return inspectCoopanionStage(distribution);
}

export async function inspectCoopanionStage(distributionDir) {
  const distribution = await realpath(resolve(distributionDir));
  const manifest = JSON.parse(await readFile(join(distribution, stageManifest), 'utf8'));
  if (manifest.version !== sourceVersion) throw new Error('This staged Coopanion version is incompatible.');
  const appDir = join(distribution, 'resources', 'app');
  const assets = await fingerprints(appDir);
  if (uiFiles.some(file => assets[file] !== manifest.assets?.[file])) {
    throw new Error('The staged Coopanion renderer was modified.');
  }
  return { distributionDir: distribution, appDir, version: manifest.version, sourceDir: manifest.sourceDir };
}

function localUrl(value) {
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('The Coopanion integration requires a local 127.0.0.1 HTTP endpoint.');
  }
  return url.href;
}

async function embeddedEnvironment(stage, options) {
  if (!options) return {};
  if (typeof options.dshRoot !== 'string' || typeof options.deploymentDir !== 'string'
    || !isAbsolute(options.dshRoot) || !isAbsolute(options.deploymentDir)) {
    throw new Error('Embedded DSH requires absolute source and state directories.');
  }
  const source = await realpath(options.dshRoot);
  const state = await canonicalPath(options.deploymentDir);
  requireSeparate(source, state);
  requireSeparate(stage.sourceDir, state);
  requireSeparate(stage.distributionDir, state);
  return {
    TINA_EMBEDDED_DSH_ROOT: source,
    TINA_EMBEDDED_DSH_STATE: state,
    TINA_EMBEDDED_LOCAL_PROVIDER: localUrl(options.localProvider),
  };
}

function waitForReady(child, timeout, diagnostic) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = (reason) => { cleanup(); reject(reason); };
    const onError = error => fail(error);
    const onExit = code => fail(new Error(`Coopanion exited before readiness (${code}).${diagnostic()}`));
    const onMessage = message => {
      if (message?.type !== 'companion:ready') return;
      if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535 || typeof message.dataDir !== 'string') {
        fail(new Error('Coopanion supplied an invalid readiness receipt.'));
        return;
      }
      cleanup();
      resolve(message);
    };
    const timer = setTimeout(() => fail(new Error(`Coopanion did not become ready.${diagnostic()}`)), timeout);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function processExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve(true);
  return new Promise(resolve => {
    const stop = (exited) => { clearTimeout(timer); child.off('exit', done); resolve(exited); };
    const done = () => stop(true);
    const timer = setTimeout(() => stop(false), timeout);
    child.once('exit', done);
  });
}

/** Run the real copied UI, or its identical Core and World servers in headless mode. */
export async function launchCoopanion({ distributionDir, stateDir, dshEndpoint, dshToken, dshBrowserUrl, embeddedDsh, headless = false, readyTimeoutMs = 90_000 }) {
  const stage = await inspectCoopanionStage(distributionDir);
  const state = await canonicalPath(resolve(stateDir));
  requireSeparate(stage.distributionDir, state);
  requireSeparate(stage.sourceDir, state);
  const endpoint = localUrl(dshEndpoint);
  const browserUrl = localUrl(dshBrowserUrl);
  if (embeddedDsh && (endpoint || dshToken || browserUrl)) {
    throw new Error('Coopanion cannot use an embedded DSH and a separate DSH relay in the same launch.');
  }
  const embeddedEnv = await embeddedEnvironment(stage, embeddedDsh);
  const executable = join(stage.distributionDir, 'Coopanion.exe');
  const app = stage.appDir;
  const temp = join(state, 'tmp');
  await mkdir(temp, { recursive: true });
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([name]) => inheritedEnvironment.has(name.toUpperCase())));
  const env = {
    ...ambient,
    CORTICO_COMPANION_DATA: state,
    CORTICO_COMPANION_ROOT: join(app, 'build', 'cortico'),
    CORTICO_HOME: join(state, 'home'),
    CORTICO_EXTENSIONS_DIR: join(state, 'extensions'),
    CORTICO_NODE_EXE: executable,
    CORTICO_PNPM_CJS: join(app, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    CORTICO_SUPERVISED: '1',
    CORTICO_START_PAUSED: '0',
    COOPANION_VERSION: stage.version,
    COOPANION_CHANNEL: 'portable',
    TINA_COO_PRIVATE_RUN: '1',
    TINA_COO_HEADLESS: headless ? '1' : '0',
    TINA_COO_DSH_ENDPOINT: endpoint,
    TINA_COO_DSH_TOKEN: dshToken ?? '',
    TINA_COO_DSH_BROWSER_URL: browserUrl,
    ...embeddedEnv,
    pnpm_config_node_linker: 'hoisted',
    pnpm_config_store_dir: join(state, 'pnpm', 'store'),
    pnpm_config_cache_dir: join(state, 'pnpm', 'cache'),
    pnpm_config_state_dir: join(state, 'pnpm', 'state'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PATH: [join(app, 'app', 'shims'), join(app, 'mingit', 'cmd'), process.env.PATH].filter(Boolean).join(delimiter),
  };
  const args = headless ? [
    ...(embeddedDsh ? ['--expose-internals'] : []), '--expose-gc', '--import', 'tsx', join(app, 'core', 'boot.ts'),
  ] : [];
  if (headless) env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(executable, args, { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: headless });
  let diagnostic = '';
  const capture = chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-3000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', () => {});

  let closing;
  const close = () => closing ??= (async () => {
    if (child.connected) child.send({ type: 'companion:shutdown' }, () => {});
    if (await processExit(child, 16_000)) return;
    child.kill();
    if (!await processExit(child, 5000)) throw new Error('The staged Coopanion process did not exit.');
  })();

  try {
    const ready = await waitForReady(child, readyTimeoutMs, () => {
      for (const secret of [dshToken, browserUrl].filter(Boolean)) diagnostic = diagnostic.replaceAll(secret, '[redacted]');
      if (embeddedDsh) diagnostic = diagnostic.replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]');
      return diagnostic.trim() ? ` ${diagnostic.trim()}` : '';
    });
    const dataDir = await realpath(ready.dataDir);
    if (!isWithin(state, dataDir)) throw new Error('Coopanion started outside the isolated Tina state directory.');
    let embeddedReceipt;
    if (embeddedDsh) {
      const { backendPid, dshPid, dshWorkspaceDir } = ready;
      if (!Number.isSafeInteger(backendPid) || backendPid < 1 || dshPid !== backendPid || (headless && backendPid !== child.pid)
        || typeof dshWorkspaceDir !== 'string') {
        throw new Error('Coopanion did not supply the embedded DSH readiness receipt.');
      }
      const dshWorkspace = await realpath(dshWorkspaceDir);
      if (!isWithin(embeddedEnv.TINA_EMBEDDED_DSH_STATE, dshWorkspace)) {
        throw new Error('Embedded DSH reported a workspace outside its isolated state directory.');
      }
      embeddedReceipt = { backendPid, dshPid, dshWorkspaceDir: dshWorkspace };
    }
    return {
      child, dataDir, origin: `http://127.0.0.1:${ready.port}`, close,
      keyMissing: ready.keyMissing,
      ...embeddedReceipt,
      openChat() { if (!headless && child.connected) child.send({ type: 'tina:open-chat' }, () => {}); },
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
