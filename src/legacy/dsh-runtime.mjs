import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const childModule = fileURLToPath(new URL('./dsh-native-child.mjs', import.meta.url));
const sessionModule = fileURLToPath(new URL('../dsh-native-session.mjs', import.meta.url));
const inheritedEnvironment = new Set([
  'APPDATA', 'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR',
]);

async function nativeDistribution(dshRoot, expectedVersion) {
  if (typeof dshRoot !== 'string' || !isAbsolute(dshRoot)) throw new Error('dshRoot must be an absolute path.');
  const root = await realpath(dshRoot);
  for (const directory of [join(root, 'apps', 'cli'), root]) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (manifest.name !== '@deepseek-ai/dsh') continue;
    if (expectedVersion && manifest.version !== expectedVersion) {
      throw new Error(`DSH package version must be ${expectedVersion}.`);
    }
    const entry = join(directory, 'lib', 'bin.js');
    if (!(await lstat(entry)).isFile()) throw new Error('The selected DSH distribution has no built CLI.');
    return { entry, version: manifest.version };
  }
  throw new Error('No native @deepseek-ai/dsh package was found at dshRoot.');
}

async function directoryWithin(parent, name) {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  if (!((await lstat(path)).isDirectory()) || await realpath(path) !== path) {
    throw new Error(`Tina DSH cannot use a redirected ${name} directory.`);
  }
  return path;
}

async function isolatedDirs(deploymentDir) {
  if (typeof deploymentDir !== 'string' || !isAbsolute(deploymentDir)) {
    throw new Error('deploymentDir must be an absolute path.');
  }
  await mkdir(deploymentDir, { recursive: true });
  const deployment = await realpath(deploymentDir);
  const root = join(deployment, 'dsh-native');
  const marker = join(root, '.tina-dsh-native-v1');
  try {
    await mkdir(root);
    await writeFile(marker, 'tina-dsh-native-v1\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root
    || !(await lstat(marker)).isFile() || await readFile(marker, 'utf8') !== 'tina-dsh-native-v1\n') {
    throw new Error('Tina DSH refuses a directory not initialized for this integration.');
  }
  const [homeDir, workspaceDir] = await Promise.all([
    directoryWithin(root, 'home'),
    directoryWithin(root, 'workspace'),
  ]);
  return { root, homeDir, workspaceDir };
}

function createEnvironment(homeDir, localProvider) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => inheritedEnvironment.has(name.toUpperCase())));
  Object.assign(env, {
    DSH_HOME: homeDir,
    DSH_AGENTS_HOME: join(homeDir, 'agents'),
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_TELEMETRY_DISABLED: '1',
  });
  if (localProvider !== undefined) {
    const endpoint = new URL(localProvider);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('localProvider must be a credential-free HTTP endpoint on 127.0.0.1.');
    }
    env.DEEPSEEK_BASE_URL = endpoint.href;
    env.DEEPSEEK_API_KEY = 'tina-local-model-fixture';
  }
  return env;
}

function milliseconds(value, name, limit) {
  if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new Error(`Invalid ${name}.`);
  return value;
}

function nativeError(code) {
  return Object.assign(new Error(`Native DSH operation failed (${code}).`), { code });
}

function validIdentity(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(value);
}

/** Start one official DSH Web profile in an isolated directory and own its teardown. */
export async function startDshRuntime({
  deploymentDir,
  dshRoot,
  expectedVersion,
  localProvider,
  tinaMode = true,
  signal,
  startupTimeoutMs = 90_000,
} = {}) {
  signal?.throwIfAborted();
  milliseconds(startupTimeoutMs, 'DSH startup timeout', 300_000);
  const { entry, version } = await nativeDistribution(dshRoot, expectedVersion);
  const { root, homeDir, workspaceDir } = await isolatedDirs(deploymentDir);
  const env = createEnvironment(homeDir, localProvider);
  const overlay = join(root, `startup-${randomUUID()}.yml`);
  await writeFile(overlay, JSON.stringify([{ insert: [{
    id: 'tina-native-session', name: sessionModule, config: { workspaceDir, tinaMode: tinaMode === true },
  }] }]), { flag: 'wx', mode: 0o600 });

  let child;
  try {
    child = fork(childModule, [entry, '--profile', 'web', '--patch', overlay,
      '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: workspaceDir, env, execArgv: ['--expose-internals'], silent: true, windowsHide: true,
    });
  } catch (error) {
    await unlink(overlay);
    throw error;
  }

  const pending = new Map();
  const exited = new Promise((done) => {
    child.once('error', () => done({ code: null, signal: null }));
    child.once('exit', (code, exitSignal) => done({ code, signal: exitSignal }));
  });
  let launchUrl;
  let sessionReady = false;
  let resolveReady;
  const ready = new Promise((done) => { resolveReady = done; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stderr.resume();
  lines.on('line', (line) => {
    if (launchUrl) return;
    const found = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)(?:\s|$)/.exec(line);
    if (!found) return;
    launchUrl = new URL(found[1]);
    if (sessionReady) resolveReady();
  });
  child.on('message', (message) => {
    if (message?.type === 'tina-dsh:session-ready') {
      sessionReady = true;
      if (launchUrl) resolveReady();
      return;
    }
    const operation = pending.get(message?.id);
    if (!operation) return;
    if (message.type === 'tina-dsh:delta') {
      try { operation.onDelta?.(message.text); } catch { /* Progress observer cannot change native execution. */ }
    } else if (message.type === 'tina-dsh:result') {
      operation.finish(message.code ? nativeError(message.code) : undefined,
        { sessionId: operation.sessionId, requestId: operation.requestId, turn: message.turn, text: message.text });
    }
  });

  let stopping;
  function stop() {
    stopping ??= (async () => {
      if (child.connected) child.send({ type: 'tina-dsh:stop' }, () => {});
      if (!await Promise.race([exited.then(() => true), delay(7_000, false, { ref: false })])) child.kill('SIGKILL');
      await exited;
    })();
    return stopping;
  }
  const stopOnAbort = () => { void stop(); };
  signal?.addEventListener('abort', stopOnAbort, { once: true });
  if (signal?.aborted) stopOnAbort();
  const closed = exited.then(async (outcome) => {
    lines.close();
    signal?.removeEventListener('abort', stopOnAbort);
    for (const operation of pending.values()) operation.finish(nativeError('DSH_OUTCOME_UNKNOWN'));
    await unlink(overlay);
    return outcome;
  });
  closed.catch(() => {});

  const startup = new AbortController();
  try {
    await Promise.race([
      ready,
      exited.then(({ code }) => { throw new Error(`Native DSH exited before readiness (code ${code ?? 'unknown'}).`); }),
      delay(startupTimeoutMs, undefined, { signal: startup.signal }).then(() => { throw new Error('Native DSH startup timed out.'); }),
    ]);
    signal?.throwIfAborted();
  } catch (error) {
    await stop();
    await closed;
    throw error;
  } finally {
    startup.abort();
  }

  return Object.freeze({
    url: launchUrl.origin, profile: 'web', homeDir, workspaceDir, version, exited: closed,
    browserUrl: () => launchUrl.href,
    async stop() { await stop(); await closed; },
    // A caller abort detaches its wait. Only the native turn can settle the operation.
    sendText({ sessionId, requestId = randomUUID(), text, signal: callerSignal, onDelta, timeoutMs = 120_000 }) {
      if (!validIdentity(sessionId) || !validIdentity(requestId)) throw new Error('Invalid DSH session or request identity.');
      if (typeof text !== 'string' || !text.trim() || text.length > 65_536) throw new Error('Invalid DSH prompt text.');
      milliseconds(timeoutMs, 'DSH request timeout', 600_000);
      callerSignal?.throwIfAborted();
      if (stopping || !child.connected) throw nativeError('DSH_STOPPED');
      const id = randomUUID();
      return new Promise((done, reject) => {
        const abort = () => finish(callerSignal.reason ?? nativeError('DSH_WAIT_ABORTED'));
        const timer = setTimeout(() => finish(nativeError('DSH_OUTCOME_UNKNOWN')), timeoutMs + 1_000);
        function finish(error, result) {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', abort);
          if (error) reject(error);
          else done(result);
        }
        pending.set(id, { sessionId, requestId, onDelta, finish });
        callerSignal?.addEventListener('abort', abort, { once: true });
        child.send({ type: 'tina-dsh:prompt', id, sessionId, requestId, text,
          stream: typeof onDelta === 'function', timeoutMs }, (error) => {
          if (error) finish(nativeError('DSH_OUTCOME_UNKNOWN'));
        });
      });
    },
  });
}
