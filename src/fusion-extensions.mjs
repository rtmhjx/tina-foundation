import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, lstat, mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';

export const name = 'tina-fusion-extensions';
export const inject = ['loader', 'tools'];
const runFile = promisify(execFile);
const states = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'];
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(value);
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
};
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function atomicJson(file, value) {
  return atomicContent(file, JSON.stringify(value, null, 2) + '\n');
}
async function atomicContent(file, content) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}
async function packageRoot(entry, name) {
  let dir = dirname(entry);
  for (;;) {
    try { if ((await json(join(dir, 'package.json'))).name === name) return realpath(dir); } catch {}
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot locate native peer package ' + name);
    dir = parent;
  }
}

/** Native Loader extension management. Candidate/history files are artifacts;
 * the Include tree is the sole registry and owner of plugin lifecycle. */
export async function mountFusionExtensions(ctx, options) {
  const workspaceDir = await realpath(options.workspaceDir);
  const stateDir = resolve(options.stateDir ?? join(workspaceDir, '.tina-extensions'));
  if (!inside(workspaceDir, stateDir)) throw new Error('Extension state must be inside the owned workspace.');
  const policy = options.policy ?? 'workspace';
  if (!['workspace', 'ask', 'deny'].includes(policy)) throw new Error('Invalid extension installation policy.');
  const npmCli = options.npmCli ?? process.env.npm_execpath
    ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const allowedRoots = await Promise.all((options.allowedRoots ?? [workspaceDir]).map(path => realpath(path)));
  const candidatesDir = join(stateDir, 'candidates');
  const configPath = join(stateDir, 'cordis.json');
  const historyPath = join(stateDir, 'history.json');
  await mkdir(candidatesDir, { recursive: true });
  if (!inside(workspaceDir, await realpath(candidatesDir))) throw new Error('Extension state resolves outside the owned workspace.');
  try { await access(configPath); } catch { await atomicJson(configPath, []); }
  try { await access(historyPath); } catch { await atomicJson(historyPath, {}); }
  // This resolves through the actual DSH profile's native module fallbacks.
  const hostRequire = createRequire(new URL('package.json', ctx.baseUrl));
  const nativeCordis = await packageRoot(hostRequire.resolve('@deepseek-ai/cordis'), '@deepseek-ai/cordis');
  const nativeModule = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href);
  if (!(ctx instanceof nativeModule.Context)) throw new Error('Extension host must share the native Cordis identity.');
  let queue = Promise.resolve();
  let closed = false;
  const mountId = await ctx.loader.create({
    id: options.id ?? 'tina-self-extensions', name: 'cordis:include', config: { path: pathToFileURL(configPath).href },
  });
  ctx.effect(() => async () => {
    closed = true;
    await queue;
    try { await ctx.loader.remove(mountId); } catch (error) {
      if (!/cannot resolve entry/.test(String(error))) throw error;
    }
  });
  const tree = ctx.loader.resolve(mountId).subtree;
  if (!tree) throw new Error('Native extension Include did not mount.');
  const serialize = task => {
    if (closed) return Promise.reject(new Error('Extension management is stopped.'));
    const pending = queue.then(task, task);
    queue = pending.then(() => {}, () => {});
    return pending;
  };
  const nativeOptions = id => {
    try { return structuredClone(tree.resolve(id).options); } catch { return undefined; }
  };
  const dependencies = fiber => {
    if (!fiber) return null;
    const required = Object.keys(fiber.inject).sort();
    const services = required.map(name => {
      const label = fiber.ctx[nativeModule.Context.isolate][name];
      const implementation = label && fiber.ctx.reflect.store[label];
      const providerState = implementation ? states[implementation.fiber.state] ?? 'UNKNOWN' : null;
      const accepted = Boolean(fiber.store && Object.hasOwn(fiber.store, name));
      const missing = !implementation || providerState !== 'ACTIVE';
      return { name, provider: implementation?.fiber.name ?? null, providerState,
        availability: missing ? 'missing' : accepted || !implementation.check ? 'available' : 'provider-check-not-observed' };
    });
    return { required, optional: null,
      optionalMetadata: 'Cordis exposes no optional-inject declaration; runtime ctx.get() probes are not enumerable.',
      missing: services.filter(service => service.availability === 'missing').map(service => service.name),
      unresolved: services.filter(service => service.availability === 'provider-check-not-observed').map(service => service.name),
      services };
  };
  const inspect = () => [...tree.entries()].map(entry => ({
    id: entry.options.id, name: entry.options.name, disabled: entry.options.disabled === true,
    state: entry.fiber ? states[entry.fiber.state] ?? 'UNKNOWN' : entry.options.disabled ? 'DISABLED' : 'INACTIVE',
    pluginName: entry.fiber?.name ?? null, dependencies: dependencies(entry.fiber),
  }));
  const sdk = async () => {
    const cordis = await json(join(nativeCordis, 'package.json'));
    const toolsRoot = await packageRoot(hostRequire.resolve('@deepseek-ai/dsh-tools'), '@deepseek-ai/dsh-tools');
    const tools = await json(join(toolsRoot, 'package.json'));
    const exampleDir = join(workspaceDir, 'plugins', 'native-sdk-example');
    const manifest = { name: 'native-sdk-example', version: '1.0.0', type: 'module', main: './index.mjs',
      files: ['index.mjs'], peerDependencies: { '@deepseek-ai/cordis': '^' + cordis.version } };
    const module = [
      "export const name = 'native-sdk-example';",
      "export const inject = ['tools'];",
      'export function apply(ctx) {',
      '  ctx.tools.register({',
      "    name: 'sdk_echo', description: 'Return the supplied text.',",
      "    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },",
      "    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },",
      "      render: (_args, value) => [{ type: 'text', text: value.text }] },",
      '    async execute({ text }) { return { text }; },',
      '  });',
      '}',
      '',
    ].join('\n');
    return { sdkVersion: 1,
      native: { cordis: { package: cordis.name, version: cordis.version, types: join(nativeCordis, cordis.types) },
        tools: { package: tools.name, version: tools.version, types: join(toolsRoot, tools.types) } },
      workspaceDir, stageRoots: [...allowedRoots],
      extensionHistory: {
        read: { action: 'history', id: 'your-plugin-id' },
        restore: { action: 'rollback', id: 'your-plugin-id', revision: 1 },
        revisionScope: 'Per plugin id. Revision 0 is its state before the first successful mutation; each successful mutation appends one revision. Failed mutations do not append.',
        defaultRollback: 'Without revision, restore the state before the latest mutation (a two-way undo). For an earlier version after multiple repairs, query history and select its revision.',
      },
      example: { directory: exampleDir, files: { 'package.json': JSON.stringify(manifest, null, 2) + '\n', 'index.mjs': module },
        workflow: [{ action: 'stage', path: exampleDir }, { action: 'install', id: 'sdk-example', path: exampleDir }, { action: 'inspect' }],
        toolCall: { name: 'sdk_echo', arguments: { text: 'example text' } } },
      rules: [
        'Write an independent npm package, then stage its absolute directory or tarball path under a configured stage root.',
        'The native ToolRuntime service is named tools. Declare inject:["tools"] and call ctx.tools.register().',
        'Tools declare parameters, output.schema, output.render(args,value), and async execute(args,exec). Execute returns the canonical JSON value matching output.schema.',
        'Native @deepseek-ai packages must resolve to the host peers; declare needed native packages as peerDependencies, rather than bundling another runtime identity. Other npm dependencies remain supported.',
        'Registrations made through the plugin context are owned by its Fiber and removed when that Fiber unloads. Own additional timers, listeners and processes with ctx.effect disposers.',
        'PENDING means required services are unavailable and the apply callback has not run; it is a successful waiting installation, not FAILED. Use inspect.dependencies to see missing names. Adding or removing a provider uses the native reactive lifecycle.',
        'Use action history with the plugin id to inspect persistent successful revisions and package identities. rollback with revision restores exactly that historical configuration through the native Loader. Without revision, rollback only undoes the most recent mutation; repeated default rollback may toggle. Actually call the restored tool before claiming a successful rollback.',
        'This Cordis version has no optional-inject metadata. Use ctx.get(name) for optional access; inspect cannot enumerate undeclared runtime probes. An object-form inject value is intercept configuration, not an optional flag.',
        'This is a minimal module example. Native function, class and object plugins and the rest of the host APIs remain available; read their actual type declarations before using additional interfaces.',
      ],
    };
  };
  const stableStates = () => inspect().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  async function authorize(action, input) {
    input.signal?.throwIfAborted();
    if (policy === 'deny') throw new Error('Extension mutation is disabled by the configured policy.');
    if (policy === 'ask') {
      if (!input.agent) throw new Error('This extension policy requires a native Agent approval.');
      const outcome = await ctx.get('approval')?.request({
        agent: input.agent, callId: input.callId, toolName: 'tina_extensions',
        reason: action + ' owned extension ' + (input.id ?? input.path ?? input.candidateId ?? ''),
        signal: input.signal,
      });
      if (outcome !== 'allowed-once') throw new Error('Extension mutation was not approved.');
    }
  }
  async function npm(cwd, args, signal) {
    try {
      return await runFile(process.execPath, [npmCli, ...args, '--ignore-scripts', '--no-audit', '--no-fund',
        '--cache', join(stateDir, 'npm-cache'), '--userconfig', join(stateDir, 'npmrc'),
        '--globalconfig', join(stateDir, 'global-npmrc'), ...options.offline === false ? [] : ['--offline']],
      { cwd, windowsHide: true, signal, timeout: options.packageTimeoutMs ?? 120_000, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      signal?.throwIfAborted();
      // npm may include environment/config diagnostics; do not copy them into a tool result.
      throw Object.assign(new Error('Extension package preparation failed.'), { code: 'EXTENSION_PACKAGE_FAILED', cause: error.code });
    }
  }
  await writeFile(join(stateDir, 'npmrc'), '');
  await writeFile(join(stateDir, 'global-npmrc'), '');
  async function candidate(input) {
    if (input.candidateId) {
      if (!/^[a-f0-9-]{36}$/i.test(input.candidateId)) throw new Error('Invalid extension candidate identity.');
      return json(join(candidatesDir, input.candidateId, 'receipt.json'));
    }
    if (typeof input.path !== 'string' || !isAbsolute(input.path)) throw new Error('Provide an absolute owned package path.');
    const source = await realpath(input.path);
    if (!allowedRoots.some(root => inside(root, source))) throw new Error('Package is outside the configured extension source roots.');
    const id = randomUUID();
    const dir = join(candidatesDir, id);
    await mkdir(dir);
    let tarball = source;
    if ((await lstat(source)).isDirectory()) {
      const { stdout } = await npm(dir, ['pack', '--json', source], input.signal);
      const packed = JSON.parse(stdout);
      if (packed.length !== 1 || !packed[0].filename || packed[0].filename.includes('/') || packed[0].filename.includes('\\')) {
        throw new Error('npm did not produce a single package archive.');
      }
      tarball = join(dir, packed[0].filename);
    } else if (!source.endsWith('.tgz') && !source.endsWith('.tar.gz')) throw new Error('Expected a package directory or npm tarball.');
    const digest = createHash('sha256').update(await readFile(tarball)).digest('hex');
    await atomicJson(join(dir, 'package.json'), { name: 'tina-extension-candidate-' + id, private: true, type: 'module' });
    const { stdout } = await npm(dir, ['install', '--json', '--legacy-peer-deps', '--package-lock=false', '--save', tarball], input.signal);
    JSON.parse(stdout);
    const project = await json(join(dir, 'package.json'));
    const names = Object.keys(project.dependencies ?? {});
    if (names.length !== 1) throw new Error('Candidate must contain exactly one root package.');
    const packageName = names[0];
    const installed = await json(join(dir, 'node_modules', packageName, 'package.json'));
    if (typeof installed.name !== 'string' || !installed.name || typeof installed.version !== 'string' || !installed.version) {
      throw new Error('A native extension package must declare a name and version.');
    }
    // The native DeepSeek package inventory resolves an entry's owning
    // manifest. Attribute the ESM entry to the real installed package.
    await atomicJson(join(dir, 'package.json'), { ...project, name: installed.name, version: installed.version });
    const peers = new Set(['@deepseek-ai/cordis', ...Object.keys(installed.peerDependencies ?? {})
      .filter(name => name.startsWith('@deepseek-ai/'))]);
    for (const peer of peers) {
      const nativeRoot = peer === '@deepseek-ai/cordis' ? nativeCordis
        : await packageRoot(hostRequire.resolve(peer), peer);
      const link = join(dir, 'node_modules', peer);
      await mkdir(dirname(link), { recursive: true });
      try {
        if (await realpath(link) !== nativeRoot) throw new Error('Native host packages must be peer dependencies: ' + peer);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await symlink(nativeRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
    const entry = join(dir, 'entry.mjs');
    // A normal ESM entry preserves the package's default class or module plugin.
    // No upstream source or build output is rewritten.
    await writeFile(entry, 'import * as plugin from ' + JSON.stringify(packageName) + ';\nexport default plugin.default ?? plugin;\n');
    const receipt = { candidateId: id, packageName, version: installed.version, sha256: digest,
      entry: pathToFileURL(entry).href, path: source };
    await atomicJson(join(dir, 'receipt.json'), receipt);
    return receipt;
  }
  const historyStates = (records, current) => [
    { revision: 0, action: 'initial', time: null, options: records.length ? records[0].previous : current ?? null },
    ...records.map((record, index) => ({ revision: index + 1, action: record.action, time: record.time,
      options: Object.hasOwn(record, 'current') ? record.current
        : index + 1 < records.length ? records[index + 1].previous : current ?? null })),
  ];
  async function historyFor(input) {
    if (!validId(input?.id)) throw new Error('Invalid native plugin identity.');
    const records = (await json(historyPath))[input.id] ?? [];
    const snapshots = historyStates(records, nativeOptions(input.id));
    const revisions = await Promise.all(snapshots.map(async ({ options: saved, ...row }) => {
      let packageIdentity = null;
      if (saved?.name?.startsWith('file:')) {
        const entry = fileURLToPath(saved.name);
        const candidateId = basename(dirname(entry));
        if (inside(candidatesDir, entry) && /^[a-f0-9-]{36}$/i.test(candidateId)) {
          const receipt = await json(join(candidatesDir, candidateId, 'receipt.json'));
          packageIdentity = { candidateId, packageName: receipt.packageName, version: receipt.version, sha256: receipt.sha256 };
        }
      }
      return { ...row, installed: saved !== null, name: saved?.name ?? null,
        disabled: saved?.disabled === true, package: packageIdentity };
    }));
    return { id: input.id, currentRevision: records.length, revisions };
  }
  async function remember(id, before, action) {
    const history = await json(historyPath);
    if (!Object.hasOwn(history, id)) history[id] = [];
    history[id].push({ action, previous: before ?? null, current: nativeOptions(id) ?? null, time: new Date().toISOString() });
    await atomicJson(historyPath, history);
    return history[id].length;
  }
  async function mutate(action, input) {
    if (!validId(input.id)) throw new Error('Invalid native plugin identity.');
    await authorize(action, input);
    // A dependent may fail after the updated entry itself reached ACTIVE.
    // Stabilize before taking the snapshot, and include global dependency
    // settlement, persistence and history in the mutation's success boundary.
    await ctx.loader.await();
    await tree.flushWrite();
    const before = nativeOptions(input.id);
    const beforeData = structuredClone(tree.root.data);
    const beforeStates = stableStates();
    const beforeConfig = await readFile(configPath);
    const beforeHistory = await readFile(historyPath);
    let touched = false;
    try {
      if (action === 'install') {
        const prepared = await candidate(input);
        input.signal?.throwIfAborted();
        const next = { id: input.id, name: prepared.entry, config: input.config ?? {}, disabled: false };
        touched = true;
        if (before) await ctx.loader.update(mountId + ':' + input.id, next);
        else await ctx.loader.create(next, mountId);
      } else if (action === 'disable') {
        if (!before) throw new Error('Extension is not installed.');
        touched = true;
        await ctx.loader.update(mountId + ':' + input.id, { disabled: input.disabled !== false });
      } else if (action === 'remove') {
        if (!before) throw new Error('Extension is not installed.');
        touched = true;
        await tree.remove(input.id);
      } else if (action === 'rollback') {
        const history = await json(historyPath);
        const records = history[input.id] ?? [];
        if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision > records.length)) {
          throw new Error('Unknown successful extension revision. Query action history with this plugin id.');
        }
        const previous = input.revision === undefined ? records.at(-1)?.previous
          : historyStates(records, before)[input.revision].options;
        if (previous === undefined) throw new Error('No earlier successful extension state exists.');
        touched = true;
        if (previous === null) { if (before) await tree.remove(input.id); }
        else if (before) await ctx.loader.update(mountId + ':' + input.id, previous);
        else await ctx.loader.create(previous, mountId);
      }
      await ctx.loader.await();
      input.signal?.throwIfAborted();
      await tree.flushWrite();
      const revision = await remember(input.id, before, action);
      return { action, id: input.id, revision, entry: inspect().find(entry => entry.id === input.id) ?? null };
    } catch (original) {
      if (!touched) throw original;
      const failures = [];
      const recover = async job => { try { await job(); } catch (error) { failures.push(error); } };
      // Loader 1.0.3's own callback-only rollback can lose module-level
      // inject metadata. Dispose the candidate/current target and re-import
      // the complete saved module through the public Include application API.
      await recover(async () => { if (nativeOptions(input.id)) await tree.remove(input.id); });
      await recover(() => tree.apply({ data: structuredClone(beforeData), content: beforeConfig.toString('utf8') }));
      // A consumer which failed while its newly introduced dependency was
      // available can remain FAILED when that dependency is removed again.
      // Re-enter that saved module through native disable/enable so a former
      // PENDING consumer becomes a fresh, legitimate PENDING fiber.
      for (const entry of [...tree.entries()].filter(entry => states[entry.fiber?.state] === 'FAILED')) {
        await recover(async () => {
          const saved = structuredClone(entry.options);
          const id = entry.id;
          await ctx.loader.update(id, { disabled: true });
          await ctx.loader.update(id, { ...saved, disabled: Object.hasOwn(saved, 'disabled') ? saved.disabled : null });
        });
      }
      await recover(() => ctx.loader.await());
      await recover(async () => { tree.write(); await tree.flushWrite(); });
      await recover(async () => {
        await atomicContent(configPath, beforeConfig);
        // Align Include's source-byte change detector with the restored file.
        // Its effective root/config was restored through the native API above.
        tree.content = beforeConfig.toString('utf8');
      });
      await recover(() => atomicContent(historyPath, beforeHistory));
      await recover(async () => {
        if (!isDeepStrictEqual(tree.root.data, beforeData) || !isDeepStrictEqual(stableStates(), beforeStates)) {
          throw new Error('Native extension rollback did not restore the previous options and stable lifecycle states.');
        }
        if (!(await readFile(configPath)).equals(beforeConfig) || !(await readFile(historyPath)).equals(beforeHistory)) {
          throw new Error('Native extension rollback did not restore persistent Include/history bytes.');
        }
      });
      if (failures.length) {
        throw new AggregateError([original, ...failures], 'Native extension mutation failed and rollback was incomplete.', { cause: original });
      }
      throw Object.assign(new Error('Extension mutation was rejected; the previous native plugin configuration and lifecycle were restored. '
        + (original instanceof Error ? original.message : String(original)), { cause: original }), {
        code: 'EXTENSION_MUTATION_REJECTED', recovered: true,
      });
    }
  }
  const service = Object.freeze({
    inspect,
    sdk,
    history: input => serialize(() => historyFor(input)),
    stage: input => serialize(async () => { await authorize('stage', input); return candidate(input); }),
    install: input => serialize(() => mutate('install', input)),
    disable: input => serialize(() => mutate('disable', input)),
    remove: input => serialize(() => mutate('remove', input)),
    rollback: input => serialize(() => mutate('rollback', input)),
    configPath,
  });
  ctx.provide('fusionExtensions', service);
  const removeTool = (options.toolContext ?? ctx).tools.register({
    name: 'tina_extensions',
    description: 'Use action sdk before writing a plugin to read this host\'s actual versioned SDK contract, complete native module example and absolute stage paths. '
      + 'Inspect, query successful history, stage, install, disable, remove or roll back your own native Cordis plugins. '
      + 'Write and debug an independent npm package in the workspace with native file/process tools first. '
      + 'Installation uses the real Loader, dependency injection, effect cleanup and last-good rollback. '
      + 'Use action history with id, then rollback with revision to select an earlier known-good state after multiple updates; default rollback undoes only the latest mutation.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['sdk', 'inspect', 'history', 'stage', 'install', 'disable', 'remove', 'rollback'] },
      id: { type: 'string' }, path: { type: 'string' }, candidateId: { type: 'string' },
      disabled: { type: 'boolean' }, config: { type: 'object', additionalProperties: true },
      revision: { type: 'integer', minimum: 0, description: 'For rollback only: the per-plugin successful state revision from action history. Omit for one-step undo.' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      const input = { ...args, agent: exec.agent, callId: exec.callId, signal: exec.signal };
      const result = args.action === 'inspect' ? service.inspect() : args.action === 'sdk' ? await service.sdk() : await service[args.action](input);
      return { text: JSON.stringify(result) };
    },
  });
  if (options.toolContext) ctx.effect(() => removeTool);
  return service;
}

export async function apply(ctx, options) { await mountFusionExtensions(ctx, options); }
