import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, realpath, writeFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { attachFusionHost } from './fusion-app.mjs';
import { createHostChatWorld } from './host-chat-world.mjs';
import { mountHostRouting } from './host-routing.mjs';
import { CORE_DEFAULTS } from '../upstream/cortico/src/core/config.ts';
import { missingContextCapabilities, normalizeContextPolicy } from './fusion-context-policy.mjs';

export const name = 'cortico-host-plugin';
export const inject = ['agentLoop', 'agents', 'sessions', 'sessionController', 'tools', 'llm', 'loader', 'settings', 'systemPrompt',
  'agentDefaultModel', 'approval', 'credentialsController', 'sessionProjections', 'attachments'];
export const HOST_COMPILER_RELEASE = Symbol('host-compiler-release');
const hosts = new WeakMap();
const fault = (code, text) => Object.assign(new Error(text), { code });

/** Metadata-only probe. Incompatible hosts are never patched by loading this plugin. */
export function inspectHostCapabilities(ctx, { sessionId } = {}) {
  const missing = inject.filter(service => !ctx.get(service));
  const controller = ctx.get('sessionController');
  if (controller?.hostRoutingVersion !== 1) missing.push('sessionController.hostRoutingVersion=1');
  for (const method of ['registerPromptRoute', 'registerHistoryPresentation'])
    if (typeof controller?.[method] !== 'function') missing.push('sessionController.' + method);
  if (typeof ctx.get('agentLoop')?.registerRequestHead !== 'function') missing.push('agentLoop.registerRequestHead');
  if (ctx.get('agentLoop')?.requestDeliveryVersion !== 1) missing.push('agentLoop.requestDeliveryVersion=1');
  if (ctx.get('agentLoop')?.requestPlanningVersion !== 1) missing.push('agentLoop.requestPlanningVersion=1');
  if (typeof ctx.get('tools')?.hasContentFinalizer !== 'function') missing.push('tools.hasContentFinalizer');
  const agent = sessionId && ctx.get('agents')?.get(sessionId);
  const session = sessionId && ctx.get('sessions')?.get(sessionId);
  if (!agent || !session) missing.push('loaded target Agent and session');
  if (agent && typeof agent.runMaintenance !== 'function') missing.push('agent.runMaintenance');
  if (session && typeof session.appendExternal !== 'function') missing.push('session.appendExternal');
  if (session && session.externalEventVersion !== 1) missing.push('session.externalEventVersion=1');
  return { compatible: !missing.length, missing, sessionId, loaded: Boolean(agent && session),
    hostRoutingVersion: controller?.hostRoutingVersion ?? null,
    requestDeliveryVersion: ctx.get('agentLoop')?.requestDeliveryVersion ?? null,
    requestPlanningVersion: ctx.get('agentLoop')?.requestPlanningVersion ?? null,
    contextScopeVerified: false, createsRuntime: false, createsAgentLoop: false };
}

/** Resolve the actual provider realm; direct root lookups do not see isolated native services. */
export async function inspectHostContextCapabilities(ctx, { sessionId } = {}) {
  const agent = ctx.get('agents')?.get(sessionId);
  const missing = [];
  let scopedEngine;
  if (!agent) missing.push('loaded target Agent and session');
  else {
    const require = createRequire(new URL('package.json', ctx.baseUrl));
    const module = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-compaction-basic')).href);
    if (typeof module.resolveFusionCompactionEngine !== 'function') missing.push('compaction.resolveFusionCompactionEngine');
    else {
      try { scopedEngine = await module.resolveFusionCompactionEngine(agent, ctx); }
      catch (error) { missing.push('unique scoped compaction engine (' + (error.code ?? 'resolution failed') + ')'); }
    }
    if (scopedEngine) missing.push(...missingContextCapabilities(ctx, agent, scopedEngine));
  }
  return { compatible: !missing.length, missing, sessionId, coordinatedContext: true, contextScopeVerified: !missing.length };
}

async function defaultBot({ stateDir, sessionId, displayName, chat }) {
  const [{ createTinaSelfMemBot }, { TinaSelfMem }] = await Promise.all([
    import('../vendor/host-self-mem/package/src/cortico-bot.mjs'),
    import('../vendor/host-self-mem/package/src/core.mjs'),
  ]);
  const preset = join(stateDir, 'host-memory-preset.md');
  try { await writeFile(preset, '# 当前角色的长期记忆\n\n身份和关系沿用宿主会话已有设定；这里尚无新确认的经历。\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const memory = new TinaSelfMem({ dataDir: join(stateDir, 'self-mem'), presetPath: preset, defaultBotId: sessionId });
  const base = createTinaSelfMemBot({ mem: memory, getCoreDefaults: () => CORE_DEFAULTS });
  const definition = { ...base, id: 'host-persona', memoryName: 'Host session memory', declares: ['host-chat'],
    worlds: [chat.definition], defaults: () => {
      const cfg = base.defaults();
      return { ...cfg, displayName, paths: { ...cfg.paths, memory: 'workspace', data: 'data' },
        worlds: { ...cfg.worlds, console: { enabled: false }, 'host-chat': { enabled: true } },
        selfMem: { ...cfg.selfMem, agentId: sessionId, seedFile: '', memoryIngress: { enabled: false }, memoryGuidance: { mode: 'minimal' } } };
    } };
  return { definition, close: () => memory.close() };
}

/** Attach one plugin-owned lifecycle to an already loaded native conversation. */
export async function mountHostPlugin(ctx, options = {}) {
  const { sessionId, stateDir: requestedState, botDefinition, displayName = 'Current role', autonomousWork = false } = options;
  const contextPolicy = normalizeContextPolicy(Object.hasOwn(options, 'contextPolicy')
    ? options.contextPolicy : options.fusionOptions?.contextPolicy);
  if (typeof sessionId !== 'string' || !sessionId || typeof requestedState !== 'string' || !isAbsolute(requestedState))
    throw fault('HOST_OPTIONS_REQUIRED', 'Pass an explicit existing sessionId and separate absolute stateDir.');
  // The default Self-Mem Persona uses coordinated context. A custom legacy
  // Persona keeps its existing protocol; NativeLoop checks an actual modern
  // participant after construction rather than assuming every Bot requires it.
  let capability = inspectHostCapabilities(ctx, { sessionId });
  if (!capability.compatible) throw fault('HOST_CAPABILITY_MISSING', 'Host capabilities are missing: ' + capability.missing.join(', '));
  if (!botDefinition) {
    const contextCapability = await inspectHostContextCapabilities(ctx, { sessionId });
    capability = { ...capability, ...contextCapability };
    if (!capability.compatible) throw fault('HOST_CAPABILITY_MISSING', 'Coordinated Persona capabilities are missing: ' + capability.missing.join(', '));
  }
  const agentRegistry = ctx.agents;
  const sessionRegistry = ctx.sessions;
  const agent = agentRegistry.get(sessionId);
  if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw fault('HOST_SESSION_BUSY', 'Wait for the current turn and queued inputs before attaching.');
  const scope = ctx.root;
  let leases = hosts.get(scope);
  if (!leases) hosts.set(scope, leases = new Map());
  if (leases.size) throw fault('HOST_SESSION_OWNED', 'This host already has an active Persona attachment; detach it before choosing another session.');
  const token = {};
  leases.set(sessionId, token);
  let mounted;
  let fiber;
  try {
    fiber = ctx.plugin({ name: 'cortico-host-session-' + sessionId, inject,
      async apply(owned) {
        let app, routing, memory;
        let released, disposing, appClosing, shutdown;
        const forced = Promise.withResolvers();
        let forceRequested = false;
        const releaseErrors = [];
        const closeApp = () => {
          if (!app) return Promise.resolve();
          if (!appClosing) {
            // Preserve the user's pause setting across reattachment. The hold
            // still blocks delivery while Core captures this persisted setting.
            shutdown?.bus.setPaused(shutdown.wasPaused);
            appClosing = app.close();
            void appClosing.catch(() => {});
          }
          return appClosing;
        };
        const requestForce = () => {
          forceRequested = true;
          forced.resolve();
          const current = shutdown;
          // A held owned request may have ended before force was requested.
          // Never use its old ownership flag to cancel a later foreign turn.
          if (current?.turn !== undefined && agentRegistry.get(sessionId) === current.agent
              && current.loop.activeNativeTurn === current.turn && current.loop.ownedNativeTurn) {
            try { current.loop.requestAbort('Cortico host attachment forced detach', { keepInbox: true }); }
            catch (error) { releaseErrors.push(error); }
          }
          // Do not queue force behind inputInflight/capacity waits. Closing the
          // app signals World owners and lets those outstanding operations exit.
          void closeApp();
        };
        const release = ({ force = false } = {}) => {
          if (!released) {
            const loop = app?.nativeLoop, bus = app?.bot.core.bus;
            if (loop && bus) {
              shutdown = { loop, bus, agent: agentRegistry.get(sessionId),
                turn: loop.ownedNativeTurn ? loop.activeNativeTurn : undefined,
                joined: loop.joinOwnedTurn(), wasPaused: bus.isPaused(),
                releaseHold: bus.holdDelivery('Host attachment detaching') };
              if (shutdown.turn !== undefined) {
                const events = shutdown.agent.session.snapshotEvents();
                const turnStart = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === shutdown.turn);
                const claimed = events.slice(turnStart + 1).some(event => event.type === 'step/start'
                  || event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn'
                    && event.data.removedCount > 0 && event.data.outcome === undefined);
                // step-boundary itself may await before Inbox.claim consumes
                // the first nextTurn wake. That one belongs to the active turn.
                if (!claimed) shutdown.firstUnclaimedWakeId = shutdown.agent.inbox.nextTurn[0]?.id;
              }
            }
            const inputClosed = routing?.prepareDispose(); // seals ingress synchronously
            bus?.setPaused(true);
            const graceful = (async () => {
              await inputClosed;
              if (shutdown?.turn !== undefined) {
                let removed = false;
                // The current turn may still be preparing its first request;
                // its nextStep input must remain until that turn has ended.
                for (const input of [...shutdown.agent.inbox.nextTurn]) {
                  if (input.id === shutdown.firstUnclaimedWakeId) continue;
                  if (input.source?.kind === 'plugin' && input.source.plugin?.startsWith('tina-cortico-world/')) {
                    removed = shutdown.agent.inbox.remove(input.id) || removed;
                  }
                }
                if (removed && !await sessionRegistry.flush(shutdown.agent.session)) {
                  throw fault('HOST_WAKE_RELEASE_NOT_PERSISTED', 'The host did not persist removal of queued plugin wakes.');
                }
                await shutdown.joined;
              }
              await loop?.releaseOwnedWorldWakes();
            })();
            void graceful.catch(() => {});
            released = (async () => {
              const collect = async work => { try { await work(); } catch (error) { if (!releaseErrors.includes(error)) releaseErrors.push(error); } };
              await collect(() => Promise.race([graceful, forced.promise]));
              await collect(closeApp);
              await collect(() => graceful);
              await collect(() => routing?.dispose());
              await collect(() => memory?.close());
              await collect(() => shutdown?.releaseHold());
              if (leases.get(sessionId) === token) leases.delete(sessionId);
              await collect(() => options[HOST_COMPILER_RELEASE]?.());
              if (releaseErrors.length === 1) throw releaseErrors[0];
              if (releaseErrors.length) throw new AggregateError(releaseErrors, 'Host attachment cleanup failed.');
            })();
            void released.catch(() => {});
          }
          if (force && !forceRequested) requestForce();
          return released;
        };
        owned.effect(() => () => release({ force: true }));
        try { await agent.runMaintenance(async () => {
          if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw fault('HOST_SESSION_BUSY', 'Wait for queued host inputs before attaching.');
          let chat;
          routing = await mountHostRouting(owned, { sessionId, onInput: payload => chat.world.receive(payload) });
          const workspace = agent.session?.header?.cwd ?? agent.cwd ?? agent.session?.cwd;
          if (typeof workspace !== 'string') throw fault('HOST_WORKSPACE_MISSING', 'The loaded session has no workspace directory.');
          const workspaceDir = await realpath(workspace);
          const stateDir = resolve(requestedState);
          const contains = (parent, child) => { const r = relative(parent, child); return !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };
          if (contains(stateDir, workspaceDir)) throw fault('HOST_STATE_UNSAFE', 'State must be separate from the workspace root and its ancestors.');
          let ancestor = stateDir;
          for (;;) {
            try {
              const actual = await realpath(ancestor);
              if (actual.toLowerCase() !== ancestor.toLowerCase()) throw fault('HOST_STATE_REDIRECT', 'Host state must not traverse redirected directories.');
              break;
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              const parent = dirname(ancestor);
              if (parent === ancestor) throw error;
              ancestor = parent;
            }
          }
          try {
            const entries = await readdir(stateDir);
            if (entries.length && !entries.includes('HOST_OWNER.json')) throw fault('HOST_STATE_UNOWNED', 'Choose an empty state directory or this plugin\'s existing owned state.');
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await mkdir(stateDir, { recursive: true, mode: 0o700 });
          const ownerFile = join(stateDir, 'HOST_OWNER.json');
          const identity = { format: 1, sessionId, workspaceDir };
          try { await writeFile(ownerFile, JSON.stringify(identity) + '\n', { flag: 'wx', mode: 0o600 }); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const prior = JSON.parse(await readFile(ownerFile, 'utf8'));
            if (prior.sessionId !== sessionId || prior.workspaceDir !== workspaceDir) throw fault('HOST_STATE_OWNED', 'State belongs to a different host session.');
          }
          chat = createHostChatWorld({ sessionId, sendSpeech: value => routing.sendSpeech(value), ctx: owned });
          const require = createRequire(new URL('package.json', ctx.baseUrl));
          const facade = { ctx: owned, workspaceDir, version: options.hostVersion ?? 'host',
            importPackage: packageName => import(pathToFileURL(require.resolve(packageName)).href) };
          let definition = botDefinition;
          if (!definition) {
            memory = await defaultBot({ stateDir, sessionId, displayName, chat });
            definition = memory.definition;
          } else definition = { ...definition, worlds: [...definition.worlds ?? [], chat.definition],
            declares: [...new Set([...definition.declares ?? [], 'host-chat'])] };
          app = await attachFusionHost({ ...options.fusionOptions,
            dsh: facade, sessionId, stateDir, borrowedHost: true,
            botDefinition: definition, autonomousWork, contextPolicy, webUi: false, displayName });
          await routing.activate();
          mounted = Object.freeze({ sessionId, stateDir, app, routing, chat: chat.world,
            get bot() { return app.bot; }, get nativeLoop() { return app.nativeLoop; },
            inspect: () => ({ ...capability, routing: routing.snapshot(), sessionId, stateDir }),
            dispose: ({ force = false } = {}) => {
              if (typeof force !== 'boolean') throw fault('HOST_DISPOSE_OPTIONS_INVALID', 'force must be a boolean.');
              const releasing = release({ force });
              return disposing ??= (async () => { try { await releasing; } finally { await fiber.dispose(); } })();
            } });
          owned.provide('corticoHostSession', mounted);
        });
        } catch (error) { await release({ force: true }); throw error; }
      } });
    await fiber;
    return mounted;
  } catch (error) {
    await fiber?.dispose();
    if (leases.get(sessionId) === token) leases.delete(sessionId);
    throw error;
  }
}

export async function apply(ctx, config) {
  const instance = await mountHostPlugin(ctx, config);
  ctx.provide('corticoHostPlugin', instance);
}
