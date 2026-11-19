var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __knownSymbol = (name, symbol) => (symbol = Symbol[name]) ? symbol : /* @__PURE__ */ Symbol.for("Symbol." + name);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __decoratorStart = (base) => [, , , __create(base?.[__knownSymbol("metadata")] ?? null)];
var __decoratorStrings = ["class", "method", "getter", "setter", "accessor", "field", "value", "get", "set"];
var __expectFn = (fn) => fn !== void 0 && typeof fn !== "function" ? __typeError("Function expected") : fn;
var __decoratorContext = (kind, name, done, metadata, fns) => ({ kind: __decoratorStrings[kind], name, metadata, addInitializer: (fn) => done._ ? __typeError("Already initialized") : fns.push(__expectFn(fn || null)) });
var __decoratorMetadata = (array, target) => __defNormalProp(target, __knownSymbol("metadata"), array[3]);
var __runInitializers = (array, flags, self, value) => {
  for (var i = 0, fns = array[flags >> 1], n = fns && fns.length; i < n; i++) flags & 1 ? fns[i].call(self) : value = fns[i].call(self, value);
  return value;
};
var __decorateElement = (array, flags, name, decorators, target, extra) => {
  var fn, it, done, ctx, access, k = flags & 7, s = !!(flags & 8), p = !!(flags & 16);
  var j = k > 3 ? array.length + 1 : k ? s ? 1 : 2 : 0, key = __decoratorStrings[k + 5];
  var initializers = k > 3 && (array[j - 1] = []), extraInitializers = array[j] || (array[j] = []);
  var desc = k && (!p && !s && (target = target.prototype), k < 5 && (k > 3 || !p) && __getOwnPropDesc(k < 4 ? target : { get [name]() {
    return __privateGet(this, extra);
  }, set [name](x) {
    return __privateSet(this, extra, x);
  } }, name));
  k ? p && k < 4 && __name(extra, (k > 2 ? "set " : k > 1 ? "get " : "") + name) : __name(target, name);
  for (var i = decorators.length - 1; i >= 0; i--) {
    ctx = __decoratorContext(k, name, done = {}, array[3], extraInitializers);
    if (k) {
      ctx.static = s, ctx.private = p, access = ctx.access = { has: p ? (x) => __privateIn(target, x) : (x) => name in x };
      if (k ^ 3) access.get = p ? (x) => (k ^ 1 ? __privateGet : __privateMethod)(x, target, k ^ 4 ? extra : desc.get) : (x) => x[name];
      if (k > 2) access.set = p ? (x, y) => __privateSet(x, target, y, k ^ 4 ? extra : desc.set) : (x, y) => x[name] = y;
    }
    it = (0, decorators[i])(k ? k < 4 ? p ? extra : desc[key] : k > 4 ? void 0 : { get: desc.get, set: desc.set } : target, ctx), done._ = 1;
    if (k ^ 4 || it === void 0) __expectFn(it) && (k > 4 ? initializers.unshift(it) : k ? p ? extra = it : desc[key] = it : target = it);
    else if (typeof it !== "object" || it === null) __typeError("Object expected");
    else __expectFn(fn = it.get) && (desc.get = fn), __expectFn(fn = it.set) && (desc.set = fn), __expectFn(fn = it.init) && initializers.unshift(fn);
  }
  return k || __decoratorMetadata(array, target), desc && __defProp(target, name, desc), p ? k ^ 4 ? extra : desc : target;
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateIn = (member, obj) => Object(obj) !== obj ? __typeError('Cannot use the "in" operator on this value') : member.has(obj);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);
var __using = (stack, value, async) => {
  if (value != null) {
    if (typeof value !== "object" && typeof value !== "function") __typeError("Object expected");
    var dispose, inner;
    if (async) dispose = value[__knownSymbol("asyncDispose")];
    if (dispose === void 0) {
      dispose = value[__knownSymbol("dispose")];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") __typeError("Object not disposable");
    if (inner) dispose = function() {
      try {
        inner.call(this);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    stack.push([async, dispose, value]);
  } else if (async) {
    stack.push([async]);
  }
  return value;
};
var __callDispose = (stack, error, hasError) => {
  var E = typeof SuppressedError === "function" ? SuppressedError : function(e, s, m, _) {
    return _ = Error(m), _.name = "SuppressedError", _.error = e, _.suppressed = s, _;
  };
  var fail = (e) => error = hasError ? new E(e, error, "An error was suppressed during disposal") : (hasError = true, e);
  var next = (it) => {
    while (it = stack.pop()) {
      try {
        var result = it[1] && it[1].call(it[2]);
        if (it[0]) return Promise.resolve(result).then(next, (e) => (fail(e), next()));
      } catch (e) {
        fail(e);
      }
    }
    if (hasError) throw error;
  };
  return next();
};

// src/index.ts
import { hostname } from "node:os";
import z3 from "@deepseek-ai/schemastery";
import { errorChain } from "@deepseek-ai/dsh-llm";
import { canOpenNativePath, nativeFileManager, openNativePath, revealNativePath } from "@deepseek-ai/dsh-native-command";
import { Remote as Remote3, RemoteError as RemoteError6, TypertRemoteService as TypertRemoteService3 } from "@deepseek-ai/dsh-typert-protocol";

// src/agent.ts
import { mkdir } from "node:fs/promises";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionQueryError } from "@deepseek-ai/dsh-session-query";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
var ApiSessionNotFound = class extends Error {
};
var ApiSessionSubagentOwnership = class extends Error {
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(sessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`);
    this.sessionId = sessionId;
  }
  sessionId;
};
var ApiSessionCwdConflict = class extends Error {
  constructor(sessionId, requestedCwd, existingCwd) {
    super(
      existingCwd === void 0 ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"` : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`
    );
    this.sessionId = sessionId;
    this.requestedCwd = requestedCwd;
    this.existingCwd = existingCwd;
  }
  sessionId;
  requestedCwd;
  existingCwd;
};
var ApiSessionPresetConflict = class extends Error {
  constructor(sessionId, requestedPreset, existingPreset) {
    super(
      existingPreset === void 0 ? `session "${sessionId}" records no agent preset and cannot be adopted under "${requestedPreset}"` : `session "${sessionId}" runs agent preset "${existingPreset}", not "${requestedPreset}"`
    );
    this.sessionId = sessionId;
    this.requestedPreset = requestedPreset;
    this.existingPreset = existingPreset;
  }
  sessionId;
  requestedPreset;
  existingPreset;
};
function hasApiSessionSubagentOwner(ctx, session, agent) {
  if (session.header.origin === "subagent") return true;
  const parentId = session.header.parentSession;
  if (parentId === void 0 || agent === void 0) return false;
  const parent = ctx.agents.get(parentId);
  return parent !== void 0 && ctx.agents.isOwnedBy(agent.id, parent);
}
function apiSessionSubagentOwnershipError(sessionId) {
  return new RemoteError(
    "session/agent-busy",
    `session "${sessionId}" is owned by subagent routing`,
    { reason: "use subagent delivery for this child session" }
  );
}
async function inspectApiSession(ctx, sessionId, signal) {
  try {
    var _stack = [];
    try {
      const observation = __using(_stack, await ctx.sessionQuery.observeSession(sessionId, {
        ...signal === void 0 ? {} : { signal },
        projectionMode: "none"
      }));
      if (observation.header.cwd === void 0) {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`);
      }
      return {
        meta: observation.header,
        inheritedEventCount: observation.inheritedEventCount,
        events: [...observation.events]
      };
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  } catch (error) {
    if (error instanceof SessionQueryError && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`);
    }
    throw error;
  }
}
var ApiSessionAgentController = class {
  /** @param ctx - Host context carrying Agent, model, persistence, and Typert services. */
  constructor(ctx) {
    this.ctx = ctx;
    ctx.typert.lookups.configure("agent", async (sessionId) => {
      const found = await this.resolveAgent(sessionId);
      if ("error" in found) throw found.error;
      return found.agent;
    });
    ctx.typert.lookups.configure("session", async (sessionId) => {
      const found = await this.resolveAgent(sessionId);
      if ("error" in found) throw found.error;
      return found.agent.session;
    });
    ctx.typert.contexts.configureHost("agent", async (sessionId) => {
      const found = await this.resolveAgent(sessionId);
      if ("error" in found) throw found.error;
      return found.agent.ctx;
    });
  }
  ctx;
  resumes = /* @__PURE__ */ new Map();
  creations = /* @__PURE__ */ new Map();
  selections = /* @__PURE__ */ new WeakMap();
  imageAdmissionChains = /* @__PURE__ */ new WeakMap();
  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId) {
    return this.resolve(sessionId);
  }
  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation) {
    return this.resolve(observation.header.id, observation);
  }
  async resolve(sessionId, observation) {
    const live = this.liveAgent(sessionId);
    if (live !== void 0) return live;
    const attached = this.ctx.sessions.get(sessionId);
    if (attached !== void 0 && hasApiSessionSubagentOwner(this.ctx, attached, void 0)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) };
    }
    let resume = this.resumes.get(sessionId);
    if (resume === void 0) {
      resume = this.resume(sessionId, observation).finally(() => {
        this.resumes.delete(sessionId);
      });
      this.resumes.set(sessionId, resume);
    }
    try {
      return { agent: await resume };
    } catch (error) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError("session/not-found", error.message, { sessionId }) };
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) };
      }
      const raced = this.liveAgent(sessionId);
      if (raced !== void 0) return raced;
      const racedSession = this.ctx.sessions.get(sessionId);
      if (racedSession !== void 0 && hasApiSessionSubagentOwner(this.ctx, racedSession, void 0)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) };
      }
      return {
        error: new RemoteError(
          "gateway/internal",
          `resume failed for session "${sessionId}": ${String(error)}`,
          {}
        )
      };
    }
  }
  /**
   * Resolve one requested identity, creating or resuming it once.
   * @param sessionId - requested Session identity.
   * @param cwd - directory the Session must own.
   * @param checkPersistedIdentity - whether to inspect a cold identity before creation.
   * @param presetId - optional Agent preset the Session must own.
   * @returns the matching live ordinary Agent.
   */
  async ensureSession(sessionId, cwd, checkPersistedIdentity, presetId) {
    let creation = this.creations.get(sessionId);
    if (creation === void 0) {
      creation = this.createOrAdopt(sessionId, cwd, checkPersistedIdentity, presetId).catch((error) => {
        const live = this.ctx.agents.get(sessionId);
        if (live !== void 0) {
          if (hasApiSessionSubagentOwner(this.ctx, live.session, live)) {
            throw new ApiSessionSubagentOwnership(sessionId);
          }
          return live;
        }
        const attached = this.ctx.sessions.get(sessionId);
        if (attached !== void 0 && hasApiSessionSubagentOwner(this.ctx, attached, void 0)) {
          throw new ApiSessionSubagentOwnership(sessionId);
        }
        throw error;
      }).finally(() => {
        this.creations.delete(sessionId);
      });
      this.creations.set(sessionId, creation);
    }
    const agent = await creation;
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw new ApiSessionSubagentOwnership(sessionId);
    }
    if (presetId !== void 0) {
      this.assertPresetUnchanged(sessionId, presetId, this.presetForSession(agent.session));
    }
    if (agent.session.header.cwd !== cwd) {
      throw new ApiSessionCwdConflict(sessionId, cwd, agent.session.header.cwd);
    }
    return agent;
  }
  /**
   * Install or return the Session-local model selection used by prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @returns the installed mutable selection reference.
   */
  selectionFor(agent) {
    const installed = this.selections.get(agent);
    if (installed !== void 0) return installed;
    const projectionState = this.ctx.sessionProjections.stateOf(agent.session, "modelSelection");
    if (projectionState === void 0) {
      throw new Error("api-session: required modelSelection projection is not registered");
    }
    let picked = projectionState.pending === null ? void 0 : agentModelSelection(projectionState.pending);
    const defaultModel = this.ctx.agentDefaultModel;
    const selection = {
      get current() {
        if (picked !== void 0) return picked;
        const loggedHeader = agent.session.requestHeader();
        if (loggedHeader === void 0) return defaultModel.currentSelection();
        const logged = loggedHeader.config;
        return {
          provider: logged.provider,
          model: logged.model,
          // An effort the adapter defaulted is not a conversation choice: restoring
          // it as one would make an unchanged default read as a request change.
          ...logged.reasoningEffort === void 0 || loggedHeader.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort: logged.reasoningEffort }
        };
      },
      set current(next) {
        picked = next;
      },
      consume(provider, model, reasoningEffort) {
        if (picked?.provider !== provider || picked.model !== model || picked.reasoningEffort !== reasoningEffort) return false;
        picked = void 0;
        return true;
      },
      assembled: void 0
    };
    installModelSelection(agent.ctx, selection);
    this.selections.set(agent, selection);
    return selection;
  }
  /**
   * Commit and cache one validated selection for the next prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @param selection - validated selection to record and apply.
   */
  selectForNextRequest(agent, selection) {
    agent.session.append("model/selection", selection);
    this.selectionFor(agent).current = selection;
  }
  /**
   * Let a matching durable request header retire the execution cache.
   * @param agent - live Agent whose request was recorded.
   * @param provider - provider route used by the request.
   * @param model - provider-owned model used by the request.
   * @param reasoningEffort - adapter-owned effort used by the request.
   * @returns whether the pending selection was consumed.
   */
  consumeSelection(agent, provider, model, reasoningEffort) {
    return this.selections.get(agent)?.consume(provider, model, reasoningEffort) ?? false;
  }
  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForSession(session) {
    return this.ctx.sessionProjections.stateOf(session, "agentPreset") ?? void 0;
  }
  /**
   * Serialize image admission and model selection for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission(agent, operation) {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation);
    this.imageAdmissionChains.set(agent, result.then(() => void 0, () => void 0));
    return result;
  }
  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId) {
    const presets = this.ctx.get("agentPresets");
    if (presets === void 0) {
      return { setup: (_agentCtx, agent) => {
        this.installSelection(agent);
      } };
    }
    const resolvedId = (await presets.resolve(presetId)).id;
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        this.installSelection(agent);
        await presets.mount(agentCtx, resolvedId);
      }
    };
  }
  liveAgent(sessionId) {
    const agent = this.ctx.agents.get(sessionId);
    if (agent === void 0) return void 0;
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent) ? { error: apiSessionSubagentOwnershipError(sessionId) } : { agent };
  }
  async resume(sessionId, supplied) {
    if (supplied !== void 0) return this.resumeObserved(sessionId, supplied);
    try {
      var _stack = [];
      try {
        const observation = __using(_stack, await this.ctx.sessionQuery.observeSession(sessionId));
        return await this.resumeObserved(sessionId, observation);
      } catch (_) {
        var _error = _, _hasError = true;
      } finally {
        __callDispose(_stack, _error, _hasError);
      }
    } catch (error) {
      if (error instanceof SessionQueryError && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`);
      }
      throw error;
    }
  }
  async resumeObserved(sessionId, observation) {
    if (observation.header.id !== sessionId || observation.header.cwd === void 0) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`);
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, void 0)) {
      throw new ApiSessionSubagentOwnership(sessionId);
    }
    const composition = await this.composeAgent(this.presetForObservation(observation));
    const published = this.ctx.sessions.get(sessionId);
    const live = this.ctx.agents.get(sessionId);
    if (published !== void 0 && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId);
    }
    return (await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup
    })).agent;
  }
  async createOrAdopt(sessionId, cwd, checkPersistedIdentity, presetId) {
    const attached = this.ctx.sessions.get(sessionId);
    const live = this.ctx.agents.get(sessionId);
    if (attached !== void 0 && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId);
    }
    if (live !== void 0) return live;
    if (checkPersistedIdentity) {
      try {
        var _stack = [];
        try {
          const observation = __using(_stack, await this.ctx.sessionQuery.observeSession(sessionId));
          if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, void 0)) {
            throw new ApiSessionSubagentOwnership(sessionId);
          }
          if (observation.header.cwd !== cwd) {
            throw new ApiSessionCwdConflict(sessionId, cwd, observation.header.cwd);
          }
          const storedPreset = this.presetForObservation(observation);
          this.assertPresetUnchanged(sessionId, presetId, storedPreset);
          const composition2 = await this.composeAgent(storedPreset);
          return (await this.ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: this.agentOptions(),
            setup: composition2.setup
          })).agent;
        } catch (_) {
          var _error = _, _hasError = true;
        } finally {
          __callDispose(_stack, _error, _hasError);
        }
      } catch (error) {
        if (!(error instanceof SessionQueryError) || error.code !== "SESSION_QUERY_SESSION_NOT_FOUND") throw error;
      }
    }
    try {
      await mkdir(cwd, { recursive: true });
    } catch (error) {
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error });
    }
    const composition = await this.composeAgent(presetId);
    return (await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }
      },
      setup: composition.setup
    })).agent;
  }
  agentOptions() {
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection();
    return { provider, model };
  }
  installSelection(agent) {
    this.selectionFor(agent);
  }
  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation) {
    if (observation.projections === void 0) {
      throw new Error("api-session: Agent activation requires a projected Session observation");
    }
    return observation.projections.values.agentPreset ?? void 0;
  }
  assertPresetUnchanged(sessionId, requested, existing) {
    if (requested === void 0 || requested === existing) return;
    throw new ApiSessionPresetConflict(sessionId, requested, existing);
  }
};
function agentModelSelection(selection) {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }
  };
}

// src/host-routes.ts
var SessionHostRoutes = class {
  prompts = /* @__PURE__ */ new Map();
  presentations = /* @__PURE__ */ new Map();
  registerPrompt(sessionId, route) {
    if (this.prompts.has(sessionId)) throw new Error("HOST_PROMPT_ROUTE_OWNED: " + sessionId);
    this.prompts.set(sessionId, route);
    return () => {
      if (this.prompts.get(sessionId) === route) this.prompts.delete(sessionId);
    };
  }
  registerPresentation(sessionId, presentation) {
    if (this.presentations.has(sessionId)) throw new Error("HOST_PRESENTATION_OWNED: " + sessionId);
    this.presentations.set(sessionId, presentation);
    return () => {
      if (this.presentations.get(sessionId) === presentation) this.presentations.delete(sessionId);
    };
  }
  async prompt(call) {
    const route = this.prompts.get(call.request.sessionId);
    if (route === void 0) return false;
    await route(call);
    return true;
  }
  event(sessionId, input) {
    const event = input;
    const present = this.presentations.get(sessionId)?.event;
    if (present === void 0) return event;
    const result = present(structuredClone(event));
    if (result.seq !== event.seq || result.time !== event.time) {
      throw new Error("HOST_PRESENTATION_CURSOR_CHANGED: " + sessionId);
    }
    return result;
  }
  stream(sessionId, frame) {
    return this.presentations.get(sessionId)?.stream?.(frame) ?? (this.presentations.get(sessionId)?.stream === void 0 ? frame : null);
  }
  baseline(sessionId, baseline) {
    return this.presentations.get(sessionId)?.baseline?.(baseline) ?? baseline;
  }
};

// src/commands.ts
import { randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
import { AttachmentError } from "@deepseek-ai/dsh-attachment";
import {
  ReasoningEffortId as ReasoningEffortId2,
  assistantStreamChunks,
  createUserMessage,
  freezeMessage
} from "@deepseek-ai/dsh-llm";
import { SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
import { SessionQueryError as SessionQueryError2 } from "@deepseek-ai/dsh-session-query";
import { SessionTitleInvalidError } from "@deepseek-ai/dsh-session-title";
import { canonicalClientTimeZone } from "@deepseek-ai/dsh-util-time";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { RemoteError as RemoteError2, remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
function hasPromptContent(content) {
  return content.some((part) => part.type !== "text" || part.text.trim().length > 0);
}
var SessionCommandController = class {
  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Session-local model selection.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   */
  constructor(ctx, agents, defaultCwd, hostRoutes = new SessionHostRoutes()) {
    this.ctx = ctx;
    this.agents = agents;
    this.defaultCwd = defaultCwd;
    this.hostRoutes = hostRoutes;
  }
  ctx;
  agents;
  defaultCwd;
  hostRoutes;
  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  async create(request) {
    if (request.workspaceId !== void 0 && request.cwd !== void 0) {
      throw new RemoteError2("gateway/bad-request", "session.create accepts workspaceId or cwd, not both", {});
    }
    const sessionId = request.sessionId ?? brandString(`session-${randomUUID()}`);
    let workspace;
    if (request.workspaceId !== void 0) {
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId);
      if (workspace === void 0) {
        throw new RemoteError2("workspace/not-found", `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId
        });
      }
    }
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd;
    let adopted;
    try {
      adopted = await this.agents.ensureSession(
        sessionId,
        cwd,
        request.sessionId !== void 0,
        request.agentPreset
      );
    } catch (error) {
      this.rejectCreation(sessionId, error);
    }
    if (workspace !== void 0) {
      try {
        await workspace.attachSession(sessionId);
      } catch (error) {
        throw new RemoteError2(
          "session/workspace-attach-failed",
          `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId, workspaceId: workspace.id }
        );
      }
    }
    const agentPreset = this.agents.presetForSession(adopted.session);
    return { sessionId, ...agentPreset === void 0 ? {} : { agentPreset } };
  }
  /**
   * Validate and install one Session-local model selection.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session.
   */
  async selectModel(request) {
    const agent = await this.resolveAgent(request.sessionId);
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        const resolved = await this.ctx.llm.resolveCallConfig({
          provider: request.provider,
          model: request.model,
          ...request.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId2(request.reasoningEffort) }
        });
        const selected = {
          provider: resolved.provider,
          model: resolved.model,
          ...resolved.reasoningEffort === void 0 ? {} : { reasoningEffort: resolved.reasoningEffort }
        };
        this.agents.selectForNextRequest(agent, selected);
        try {
          await this.ctx.agentDefaultModel.saveSelection(selected);
        } catch (error) {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`
          );
        }
        return { selected: { ...selected } };
      } catch (error) {
        if (remoteErrorOf(error) !== void 0) throw error;
        throw new RemoteError2(
          "session/model-unavailable",
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model }
        );
      }
    });
  }
  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  async rename(request) {
    const agent = await this.resolveAgent(request.sessionId);
    const titles = this.ctx.get("sessionTitle");
    if (titles === void 0) {
      throw new RemoteError2("gateway/internal", "renaming is unavailable: this deployment mounts no session-title service", {});
    }
    try {
      const accepted = titles.rename(agent.session, request.title);
      return { title: accepted.title, seq: accepted.eventSeq };
    } catch (error) {
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError2("session/title-invalid", error.message, { sessionId: request.sessionId });
      }
      throw new RemoteError2(
        "gateway/internal",
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {}
      );
    }
  }
  /**
   * Create a new ordinary Session from one completed-turn prefix.
   * @param request - source Session and optional event anchor.
   * @returns the new Session identity.
   */
  async fork(request) {
    var _stack = [];
    try {
      let atSeq;
      try {
        atSeq = request.atSeq === void 0 ? void 0 : SessionSeq(request.atSeq);
      } catch {
        throw new RemoteError2("gateway/bad-request", "atSeq must be a non-negative safe integer", {});
      }
      let observed;
      try {
        observed = await this.ctx.sessionQuery.observeSession(request.sessionId);
      } catch (error) {
        if (error instanceof SessionQueryError2 && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") {
          throw new RemoteError2("session/not-found", `session "${request.sessionId}" not found`, {
            sessionId: request.sessionId
          });
        }
        throw new RemoteError2(
          "gateway/internal",
          `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
          {}
        );
      }
      const source = __using(_stack, observed);
      const lastSeq = source.events.at(-1)?.seq ?? -1;
      const anchoredBoundary = atSeq === void 0 ? void 0 : source.events.find((event) => event.type === "turn/end" && event.seq >= atSeq);
      const boundary = anchoredBoundary ?? (atSeq === void 0 || atSeq > lastSeq ? source.events.findLast((event) => event.type === "turn/end") : void 0);
      if (boundary === void 0) {
        throw new RemoteError2(
          "session/fork-unavailable",
          atSeq !== void 0 && atSeq <= lastSeq ? `session "${request.sessionId}" has not completed the turn containing event ${String(atSeq)}` : `session "${request.sessionId}" has no completed turn to fork from`,
          { sessionId: request.sessionId }
        );
      }
      let cut = SessionLogOffset(boundary.seq + 1);
      while (cut < source.events.length && source.events[cut]?.type !== "turn/start") {
        cut = SessionLogOffset(cut + 1);
      }
      let workspace;
      try {
        workspace = await this.forkWorkspace(source.header);
      } catch (error) {
        throw new RemoteError2(
          "gateway/internal",
          `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
          {}
        );
      }
      const childId = brandString(`session-${randomUUID()}`);
      const composition = await this.agents.composeAgent(this.agents.presetForObservation(source));
      try {
        const { provider, model } = this.ctx.agentDefaultModel.currentSelection();
        await this.ctx.agents.create({
          sessionId: childId,
          seed: source.events.slice(0, cut),
          inheritedEventCount: cut,
          meta: {
            ...source.header.cwd === void 0 ? {} : { cwd: source.header.cwd },
            parentSession: source.header.id,
            isSeeded: true,
            ...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }
          },
          agentOptions: { provider, model },
          setup: composition.setup
        });
      } catch (error) {
        throw new RemoteError2(
          "gateway/internal",
          `failed to fork session "${request.sessionId}": ${String(error)}`,
          {}
        );
      }
      if (workspace !== void 0) {
        try {
          await workspace.attachSession(childId);
        } catch (error) {
          throw new RemoteError2(
            "session/workspace-attach-failed",
            `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
            { sessionId: childId, workspaceId: workspace.id }
          );
        }
      }
      return { sessionId: childId };
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  /**
   * Reject empty content, then admit one prompt after Agent and attachment validation.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  async prompt(request) {
    if (!hasPromptContent(request.content)) {
      throw new RemoteError2(
        "gateway/bad-request",
        "prompt content must include non-whitespace text or an attachment",
        {}
      );
    }
    const clientTimeZone = request.clientTimeZone === void 0 ? void 0 : canonicalClientTimeZone(request.clientTimeZone);
    if (request.clientTimeZone !== void 0 && clientTimeZone === void 0) {
      throw new RemoteError2(
        "session/invalid-time-zone",
        "clientTimeZone must be UTC or a valid IANA Area/Location name",
        { value: request.clientTimeZone }
      );
    }
    const agent = await this.resolveAgent(request.sessionId);
    if (hasPromptRequest(agent, request.requestId)) return { accepted: true };
    const selection = this.agents.selectionFor(agent).current;
    if (!routeServed(this.ctx, selection.provider)) {
      throw new RemoteError2(
        "session/model-unavailable",
        `no adapter serves provider "${selection.provider}"; select a model for this session`,
        { provider: selection.provider, model: selection.model }
      );
    }
    const source = {
      kind: "user",
      rpcId: request.requestId,
      ...clientTimeZone === void 0 ? {} : { clientTimeZone }
    };
    const hasImage = request.content.some((part) => part.type === "image");
    const admit = async () => {
      try {
        var _stack = [];
        try {
          if (hasImage) {
            const current = this.agents.selectionFor(agent).current;
            const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
            if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) {
              throw new RemoteError2(
                "session/attachment-invalid",
                `Model "${current.model}" does not support image input.`,
                { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }
              );
            }
          }
          const admission = resolvePromptFileReceipts(
            request.content,
            (receiptId) => this.ctx.fileUploads.resolve(agent, receiptId)
          );
          const content = await this.ctx.attachments.admitPromptContent(admission.content);
          const message = createUserMessage({ content, source });
          if (this.ctx.agents.get(agent.id) !== agent) {
            throw new RemoteError2(
              "session/not-found",
              `session "${agent.id}" was disposed during prompt admission`,
              { sessionId: agent.id }
            );
          }
          const binding = __using(_stack, this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId));
          const owned = await this.hostRoutes.prompt({ request, message, agent });
          if (!owned) {
            if (request.mode === "steer") agent.steer(message);
            else agent.followup(message);
          }
          binding.commit();
        } catch (_) {
          var _error = _, _hasError = true;
        } finally {
          __callDispose(_stack, _error, _hasError);
        }
      } catch (error) {
        if (remoteErrorOf(error) !== void 0) throw error;
        if (error instanceof AttachmentError) {
          throw new RemoteError2("session/attachment-invalid", error.message, { reason: error.code });
        }
        throw new RemoteError2("session/agent-busy", "prompt rejected", { reason: String(error) });
      }
      return { accepted: true };
    };
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit();
  }
  /**
   * Read one durable image after proving the Session log references it.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request) {
    let source;
    try {
      source = await this.readSessionState(request.sessionId);
    } catch (error) {
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError2("session/not-found", error.message, { sessionId: request.sessionId });
      }
      throw new RemoteError2(
        "gateway/internal",
        `attachment authorization unavailable for session "${request.sessionId}": ${String(error)}`,
        {}
      );
    }
    const ref = referencedImage(source.events, String(request.attachmentId));
    if (ref === void 0) {
      throw new RemoteError2(
        "session/attachment-invalid",
        "Image is not referenced by this session.",
        { reason: "ATTACHMENT_NOT_REFERENCED" }
      );
    }
    try {
      const stored = await this.ctx.attachments.readImage(ref);
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString("base64")
      };
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new RemoteError2("session/attachment-invalid", error.message, { reason: error.code });
      }
      throw new RemoteError2("gateway/internal", "Unable to read image attachment.", {});
    }
  }
  /**
   * Mutate one still-pending queue occurrence without resuming a cold Agent.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  updateQueue(request) {
    if (request.action.kind === "edit") {
      if (request.action.content.some((block) => block.type !== "text")) {
        throw new RemoteError2(
          "session/attachment-invalid",
          "queue edits accept text content only",
          { reason: "QUEUE_EDIT_NON_TEXT" }
        );
      }
      if (!hasPromptContent(request.action.content)) {
        throw new RemoteError2(
          "gateway/bad-request",
          "queue edit content must include non-whitespace text",
          {}
        );
      }
    }
    const agent = this.ctx.agents.get(request.sessionId);
    if (agent === void 0) {
      throw new RemoteError2("session/queue-item-not-found", "queued item is no longer pending", { itemId: request.itemId });
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      const identity = this.ctx.sessionProjections.snapshot(agent.session, ["subagent"]).values.subagent;
      if (identity?.mode !== "continuable" || !agent.session.isOwnSeq(identity.seq)) {
        throw apiSessionSubagentOwnershipError(request.sessionId);
      }
    }
    const nextTurn = agent.inbox.nextTurn.find((message2) => message2.id === request.itemId);
    const nextStep = agent.inbox.nextStep.find((message2) => message2.id === request.itemId);
    const located = nextTurn === void 0 ? nextStep === void 0 ? void 0 : { target: "next-step", message: nextStep } : { target: "next-turn", message: nextTurn };
    if (located === void 0) {
      throw new RemoteError2("session/queue-item-not-found", "queued item is no longer pending", { itemId: request.itemId });
    }
    const { target, message } = located;
    if (request.action.kind === "steer" && (target !== "next-turn" || agent.status !== "running")) {
      throw new RemoteError2("session/steer-unavailable", "current turn no longer accepts steering", { itemId: request.itemId });
    }
    switch (request.action.kind) {
      case "edit":
        agent.inbox.replace(request.itemId, freezeMessage({
          ...message,
          content: [...request.action.content]
        }));
        break;
      case "remove": {
        agent.inbox.remove(request.itemId);
        const source = message.source;
        if (source.kind === "user" && "rpcId" in source) {
          this.ctx.fileUploads.retirePrompt(agent, source.rpcId);
        }
        break;
      }
      case "steer":
        agent.inbox.remove(request.itemId);
        agent.steer(message);
        break;
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(request.action, "queue action");
    }
    return { accepted: true };
  }
  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request) {
    const agent = this.ctx.agents.get(request.sessionId);
    if (agent === void 0) {
      throw new RemoteError2(
        "session/not-found",
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId }
      );
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId);
    }
    agent.cancel({ kind: "user" }, { keepInbox: true });
    return { accepted: true };
  }
  async resolveAgent(sessionId) {
    const found = await this.agents.resolveAgent(sessionId);
    if ("error" in found) throw found.error;
    return found.agent;
  }
  rejectCreation(sessionId, error) {
    if (remoteErrorOf(error) !== void 0) throw error;
    if (error instanceof ApiSessionPresetConflict) {
      throw new RemoteError2("agent-preset/conflict", error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
        ...error.existingPreset === void 0 ? {} : { existingPreset: error.existingPreset }
      });
    }
    if (error instanceof ApiSessionCwdConflict) {
      throw new RemoteError2("session/conflict", error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...error.existingCwd === void 0 ? {} : { existingCwd: error.existingCwd }
      });
    }
    if (error instanceof ApiSessionSubagentOwnership) {
      throw apiSessionSubagentOwnershipError(error.sessionId);
    }
    throw new RemoteError2("gateway/internal", `failed to create session "${sessionId}": ${String(error)}`, {});
  }
  async readSessionState(sessionId) {
    const attached = this.ctx.sessions.get(sessionId);
    if (attached !== void 0) {
      return { id: attached.id, header: attached.header, events: attached.snapshotEvents() };
    }
    const inspected = await inspectApiSession(this.ctx, sessionId);
    return { id: inspected.meta.id, header: inspected.meta, events: inspected.events };
  }
  async forkWorkspace(source) {
    const workspaces = this.ctx.workspaceRegistry.list();
    const direct = workspaces.find((workspace) => workspace.sessionIds.includes(source.id));
    if (direct !== void 0 || source.origin !== "subagent") return direct;
    const lineage = await this.ctx.sessionQuery.traceSession(source.id);
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find((candidate) => candidate.sessionIds.includes(ancestor.header.id));
      if (workspace !== void 0) return workspace;
    }
    return void 0;
  }
};
function resolvePromptFileReceipts(content, stagedFile) {
  const receiptIds = /* @__PURE__ */ new Set();
  const resolved = content.map((part) => {
    if (part.type !== "file") return part;
    const attachment = stagedFile(part.receiptId);
    if (attachment === void 0) {
      throw new RemoteError2(
        "session/attachment-invalid",
        "File was not uploaded for this session.",
        { reason: "FILE_NOT_STAGED" }
      );
    }
    receiptIds.add(part.receiptId);
    return { type: "file", attachment };
  });
  return { content: resolved, receiptIds: [...receiptIds] };
}
function hasPromptRequest(agent, requestId) {
  const matches = (message) => {
    const source = message.source;
    return source.kind === "user" && "rpcId" in source && source.rpcId === requestId;
  };
  if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return true;
  return agent.session.snapshotEvents().some((event) => {
    if (event.type !== "user/message") return false;
    const source = event.data.source;
    return source.kind === "user" && "rpcId" in source && source.rpcId === requestId;
  });
}
function imageBlockIn(content, match) {
  if (!Array.isArray(content)) return void 0;
  for (const value of content) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const block = value;
    if (block.type === "image" && typeof block.attachment === "object" && block.attachment !== null) {
      const ref = block.attachment;
      if (match(ref)) return ref;
    }
    if (block.type === "tool-result") {
      const nested = imageBlockIn(block.content, match);
      if (nested !== void 0) return nested;
    }
  }
  return void 0;
}
function imageInEvent(event, match) {
  const data = event.data;
  const direct = imageBlockIn(data.content, match);
  if (direct !== void 0) return direct;
  const message = imageBlockIn(data.message?.content, match);
  if (message !== void 0) return message;
  for (const inserted of data.inserted ?? []) {
    const found = imageBlockIn(inserted.content, match);
    if (found !== void 0) return found;
  }
  if (event.type === "assistant/message" || event.type === "assistant/attempt") {
    for (const chunk of assistantStreamChunks(event.data.stream, "block-end")) {
      const found = imageBlockIn([chunk.block], match);
      if (found !== void 0) return found;
    }
  }
  return void 0;
}
function referencedImage(events, attachmentId) {
  for (const event of events) {
    const found = imageInEvent(event, (ref) => String(ref.attachmentId) === attachmentId);
    if (found !== void 0) return found;
  }
  return void 0;
}
function routeServed(ctx, provider) {
  return ctx.llm.listProviders().some((entry) => entry.id === provider);
}

// src/control.ts
import { Deque } from "@deepseek-ai/dsh-deque";
var SessionControlController = class {
  /** @param ctx - Host context carrying live Agent, projection, and jobs services. */
  constructor(ctx) {
    this.ctx = ctx;
    ctx.sessionProjections.onChanged((session, key, value, seq) => {
      this.broadcast({
        type: "projection",
        sessionId: session.id,
        key,
        value,
        seq
      });
      if (key !== "inbox") return;
      const agent = this.ctx.agents.get(session.id);
      if (agent?.session !== session) return;
      this.broadcast({
        type: "queue",
        sessionId: session.id,
        items: queueItemsFromInbox(value)
      });
    });
    ctx.inject(["jobs"], (jobsCtx) => {
      jobsCtx.jobs.onJobsChanged((owner) => {
        this.onJobsChanged(owner);
      });
    });
    ctx.on("session/created", (session) => {
      const jobs = this.jobsFor(this.ctx.agents.get(session.id));
      if (jobs.length > 0) this.broadcast({ type: "jobs", sessionId: session.id, jobs });
    });
    ctx.effect(() => () => {
      for (const stream of this.streams) stream.end();
      this.streams.clear();
    }, "session-controller.control");
  }
  ctx;
  streams = /* @__PURE__ */ new Set();
  /**
   * Open one generation of Host-wide live control state.
   * @param signal - Remote stream cancellation.
   * @returns one complete baseline followed by live replacement frames.
   */
  async *control(signal) {
    signal.throwIfAborted();
    const queue = new ControlQueue();
    this.streams.add(queue);
    try {
      yield { type: "baseline", value: this.baseline() };
      yield* queue.iterate(signal);
    } finally {
      this.streams.delete(queue);
      queue.end();
    }
  }
  baseline() {
    const sessions = this.ctx.sessions.list();
    const queues = /* @__PURE__ */ Object.create(null);
    const jobs = /* @__PURE__ */ Object.create(null);
    for (const session of sessions) {
      const agent = this.ctx.agents.get(session.id);
      queues[session.id] = agent?.session === session ? queueItems(agent) : [];
      jobs[session.id] = this.jobsFor(agent);
    }
    return {
      queues,
      jobs,
      projections: this.projectionBaseline(sessions)
    };
  }
  projectionBaseline(sessions) {
    const blocks = /* @__PURE__ */ Object.create(null);
    for (const session of sessions) {
      const snapshot = this.ctx.sessionProjections.snapshot(session);
      blocks[session.id] = {
        asOfSeq: snapshot.asOfSeq,
        // Every projection definition validates its value before snapshot publication.
        values: snapshot.values
      };
    }
    return blocks;
  }
  onJobsChanged(owner) {
    if (owner !== void 0) {
      this.broadcast({ type: "jobs", sessionId: owner.id, jobs: this.jobsFor(owner) });
      return;
    }
    for (const session of this.ctx.sessions.list()) {
      this.broadcast({
        type: "jobs",
        sessionId: session.id,
        jobs: this.jobsFor(this.ctx.agents.get(session.id))
      });
    }
  }
  jobsFor(agent) {
    const jobs = this.ctx.get("jobs");
    return jobs === void 0 ? [] : jobs.list(agent).map(jobView);
  }
  broadcast(frame) {
    for (const stream of this.streams) stream.push(frame);
  }
};
var ControlQueue = class {
  buffer = new Deque();
  wake;
  done = false;
  push(frame) {
    if (this.done) return;
    this.buffer.pushBack(frame);
    const wake = this.wake;
    this.wake = void 0;
    wake?.();
  }
  end() {
    if (this.done) return;
    this.done = true;
    const wake = this.wake;
    this.wake = void 0;
    wake?.();
  }
  async *iterate(signal) {
    const onAbort = () => {
      this.end();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!this.done && !signal.aborted) {
        const frame = this.buffer.popFront();
        if (frame !== void 0) {
          yield frame;
          continue;
        }
        await new Promise((resolve) => {
          this.wake = resolve;
        });
      }
      while (this.buffer.size > 0 && !signal.aborted) yield this.buffer.popFront();
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.end();
    }
  }
};
function queueItems(agent) {
  return queueItemsFromInbox({
    "next-turn": agent.inbox.nextTurn,
    "next-step": agent.inbox.nextStep
  });
}
function queueItemsFromInbox(inbox) {
  return [
    ...inbox["next-turn"].map((message) => ({
      id: message.id,
      placement: "queued",
      ...promptRpcId(message),
      message: { id: message.id, content: message.content }
    })),
    ...inbox["next-step"].map((message) => ({
      id: message.id,
      placement: message.source.kind === "user" ? "steering" : "context",
      ...promptRpcId(message),
      message: { id: message.id, content: message.content }
    }))
  ];
}
function promptRpcId(message) {
  const source = message.source;
  return source.kind === "user" && "rpcId" in source ? { rpcId: source.rpcId } : {};
}
function jobView(job) {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...job.detail === void 0 ? {} : { detail: job.detail },
    startedAt: job.startedAt,
    ...job.finishedAt === void 0 ? {} : { finishedAt: job.finishedAt }
  };
}

// src/history.ts
import { Deque as Deque2 } from "@deepseek-ai/dsh-deque";
import {
  isAppendSurfaceEvent,
  SessionLogOffset as SessionLogOffset2,
  SessionSeq as SessionSeq2
} from "@deepseek-ai/dsh-session";
import { SessionQueryError as SessionQueryError3 } from "@deepseek-ai/dsh-session-query";
import { RemoteError as RemoteError3 } from "@deepseek-ai/dsh-typert-protocol";

// src/assistant-stream.ts
import { AssistantStreamAccumulator } from "@deepseek-ai/dsh-llm";
var EMPTY_BASELINE = { revision: 0 };
var SessionAssistantStreamAccumulator = class {
  activeAttempt;
  revision = 0;
  snapshotValue = EMPTY_BASELINE;
  dirty = false;
  /**
   * Fold one trusted frame from the current attached Agent lifecycle.
   * @param frame - next dense process-local Assistant frame.
   * @param durableCursor - last committed Session seq when this frame was observed.
   */
  accept(frame, durableCursor) {
    if (frame.type === "start" && frame.revision === 1 && this.revision !== 0) {
      this.activeAttempt = void 0;
      this.revision = 0;
    }
    if (frame.revision !== this.revision + 1) {
      this.activeAttempt = void 0;
      this.revision = frame.revision;
      this.dirty = true;
      return;
    }
    this.revision = frame.revision;
    switch (frame.type) {
      case "start":
        this.activeAttempt = {
          attemptId: frame.attemptId,
          startedAfterSeq: durableCursor,
          turn: frame.turn,
          step: frame.step,
          stream: new AssistantStreamAccumulator(),
          nextIndex: 0
        };
        break;
      case "chunk": {
        const attempt = this.activeAttempt;
        if (attempt === void 0 || attempt.attemptId !== frame.attemptId || frame.index !== attempt.nextIndex) {
          this.activeAttempt = void 0;
          break;
        }
        attempt.stream.push({ time: frame.time, chunk: frame.chunk });
        attempt.nextIndex += 1;
        break;
      }
      case "end":
        this.activeAttempt = void 0;
        break;
    }
    this.dirty = true;
  }
  /**
   * Read the cached reconnect baseline, materializing it after a state change.
   * @returns the identity-stable baseline for the latest accepted revision.
   */
  snapshot() {
    if (!this.dirty) return this.snapshotValue;
    this.snapshotValue = {
      revision: this.revision,
      ...this.activeAttempt === void 0 ? {} : {
        activeAttempt: {
          attemptId: this.activeAttempt.attemptId,
          startedAfterSeq: this.activeAttempt.startedAfterSeq,
          turn: this.activeAttempt.turn,
          step: this.activeAttempt.step,
          nextIndex: this.activeAttempt.nextIndex,
          stream: this.activeAttempt.stream.snapshot()
        }
      }
    };
    this.dirty = false;
    return this.snapshotValue;
  }
};

// src/history.ts
var DEFAULT_MAX_MESSAGES = 50;
var MESSAGE_TYPES = /* @__PURE__ */ new Set(["user/message", "assistant/message"]);
var SessionHistoryController = class {
  /**
   * @param ctx - Host context carrying Session query and projection services.
   * @param promote - starts ordinary Session activation after snapshot delivery.
   */
  constructor(ctx, promote, hostRoutes = new SessionHostRoutes()) {
    this.ctx = ctx;
    this.promote = promote;
    this.hostRoutes = hostRoutes;
    ctx.on("agent/assistant-stream", ({ agent, frame }) => {
      let stream = this.assistantStreams.get(agent.session.id);
      if (stream === void 0) {
        stream = new SessionAssistantStreamAccumulator();
        this.assistantStreams.set(agent.session.id, stream);
      }
      stream.accept(frame, cursorBeforeNext(agent.session.seq));
    }, { global: true });
    ctx.on("agent/disposed", ({ agent }) => {
      this.assistantStreams.delete(agent.session.id);
    }, { global: true });
    ctx.effect(() => () => {
      for (const close of this.closeFollowers) close();
      this.closeFollowers.clear();
    }, "session-controller.history");
  }
  ctx;
  promote;
  hostRoutes;
  closeFollowers = /* @__PURE__ */ new Set();
  assistantStreams = /* @__PURE__ */ new Map();
  /**
   * Read one message-aligned history page without activating an Agent.
   * @param request - durable address and backwards-page cursor.
   * @param signal - caller cancellation for persistence reads.
   * @returns a contiguous event page.
   */
  async page(request, signal) {
    var _stack = [];
    try {
      validatePageRequest(request);
      const throughSeq = request.throughSeq === -1 ? -1 : SessionSeq2(request.throughSeq);
      const beforeSeq = request.beforeSeq === void 0 ? void 0 : SessionLogOffset2(request.beforeSeq);
      const source = __using(_stack, await this.sourceFor(request.address, signal, false));
      signal.throwIfAborted();
      const sourceLog = source.events;
      const sourceCursor = sourceLog.at(-1)?.seq ?? -1;
      if (throughSeq > sourceCursor) {
        throw new RemoteError3(
          "gateway/bad-request",
          `session page through seq ${String(throughSeq)} is past cursor ${String(sourceCursor)}`,
          {}
        );
      }
      if (throughSeq >= 0 && sourceLog[throughSeq]?.seq !== throughSeq) {
        throw new RemoteError3("gateway/internal", `session log does not contain through seq ${String(throughSeq)}`, {});
      }
      const page = paginate(
        sourceLog,
        beforeSeq,
        request.maxMessages ?? DEFAULT_MAX_MESSAGES,
        throughSeq
      );
      const records = this.pageRecords(addressId(request.address), page.events);
      return {
        records,
        hasMore: page.hasMore
      };
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  /**
   * Follow events appended after an initial cursor on one durable address.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - stream cancellation owned by the Remote carrier.
   * @returns a complete opening snapshot followed by gap-free durable events and opted-in assistant frames.
   */
  async *follow(request, signal) {
    validateFollowRequest(request);
    const { address } = request;
    const target = addressId(address);
    const buffered = new Deque2();
    let snapshotCursor;
    let assistantStreamOrdinal = 0;
    let wake;
    const notify = () => {
      const resume = wake;
      wake = void 0;
      resume?.();
    };
    const follower = { closed: false };
    const close = () => {
      follower.closed = true;
      notify();
    };
    this.closeFollowers.add(close);
    const disposeEvent = this.ctx.on("session/event", (session, event) => {
      if (session.id !== target) return;
      buffered.pushBack({ type: "event", event });
      notify();
    }, { global: true });
    const disposeCreated = this.ctx.on("session/created", (session) => {
      if (session.id !== target) return;
      const suffix = session.snapshotEvents(snapshotCursor === void 0 ? session.firstLiveSeq : SessionLogOffset2(snapshotCursor + 1));
      for (let index = suffix.length - 1; index >= 0; index -= 1) {
        buffered.pushFront({ type: "event", event: suffix[index] });
      }
      notify();
    }, { global: true });
    const disposeAssistantStream = request.assistantStream !== true ? void 0 : this.ctx.on("agent/assistant-stream", ({ agent, frame }) => {
      if (agent.session.id !== target) return;
      buffered.pushBack({
        type: "assistant-stream",
        frame: wireAssistantStreamFrame(frame, cursorBeforeNext(agent.session.seq)),
        ordinal: ++assistantStreamOrdinal
      });
      notify();
    }, { global: true });
    const onAbort = () => {
      notify();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      var _stack = [];
      try {
        const source = __using(_stack, await this.sourceFor(address, signal, true));
        const events = source.events;
        signal.throwIfAborted();
        const cursor = source.cursor;
        snapshotCursor = cursor;
        const page = paginate(events, void 0, request.maxMessages ?? DEFAULT_MAX_MESSAGES);
        const assistantStream = request.assistantStream === true ? this.hostRoutes.baseline(target, this.assistantStreams.get(target)?.snapshot() ?? { revision: 0 }) : void 0;
        const assistantStreamOrdinalCut = assistantStreamOrdinal;
        yield {
          type: "snapshot",
          header: wireHeader(source.header),
          cursor,
          records: this.pageRecords(target, page.events),
          hasMore: page.hasMore,
          projections: source.projections === void 0 ? { asOfSeq: cursor, values: {} } : projectionBlock(source.projections),
          ...assistantStream === void 0 ? {} : { assistantStream }
        };
        if (address.kind === "session" && source.source === "prepared") {
          const promotion = source.retain();
          try {
            this.promote(promotion);
          } catch (error) {
            promotion[Symbol.dispose]();
            throw error;
          }
        }
        let nextOffset = SessionLogOffset2(cursor + 1);
        while (!follower.closed && !signal.aborted) {
          const item = buffered.popFront();
          if (item === void 0) {
            await new Promise((resolve) => {
              wake = resolve;
            });
            continue;
          }
          if (item.type === "assistant-stream") {
            if (item.ordinal > assistantStreamOrdinalCut) {
              const frame = this.hostRoutes.stream(target, item.frame);
              if (frame !== null) yield { type: "assistant-stream", frame };
            }
            continue;
          }
          const expectedSeq = SessionSeq2(nextOffset);
          if (item.event.seq < expectedSeq) continue;
          if (item.event.seq !== expectedSeq) {
            throw new RemoteError3("gateway/internal", `session event stream skipped seq ${String(expectedSeq)}`, {});
          }
          nextOffset = SessionLogOffset2(nextOffset + 1);
          yield { type: "event", event: this.hostRoutes.event(target, item.event) };
        }
      } catch (_) {
        var _error = _, _hasError = true;
      } finally {
        __callDispose(_stack, _error, _hasError);
      }
    } finally {
      this.closeFollowers.delete(close);
      signal.removeEventListener("abort", onAbort);
      disposeCreated();
      disposeEvent();
      disposeAssistantStream?.();
    }
  }
  pageRecords(sessionId, events) {
    return events.map((event) => ({ type: "event", event: this.hostRoutes.event(sessionId, event) }));
  }
  async sourceFor(address, signal, withProjections) {
    const sessionId = addressId(address);
    try {
      const observation = await this.ctx.sessionQuery.observeSession(sessionId, {
        signal,
        projectionMode: withProjections || address.kind === "subagent" ? "all" : "none"
      });
      if (observation.header.cwd === void 0) {
        observation[Symbol.dispose]();
        rejectNotFound(address);
      }
      try {
        validateAddress(
          address,
          observation.header,
          observation.inheritedEventCount,
          observation.projections
        );
      } catch (error) {
        observation[Symbol.dispose]();
        throw error;
      }
      return observation;
    } catch (error) {
      if (error instanceof SessionQueryError3 && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") rejectNotFound(address);
      throw error;
    }
  }
};
function cursorBeforeNext(nextSeq) {
  return nextSeq === 0 ? -1 : SessionSeq2(nextSeq - 1);
}
function wireAssistantStreamFrame(frame, durableCursor) {
  if (frame.type === "start") return { ...frame, startedAfterSeq: durableCursor };
  if (frame.type === "end") return frame;
  return {
    ...frame,
    chunk: frame.chunk
  };
}
function projectionBlock(snapshot) {
  return {
    asOfSeq: snapshot.asOfSeq,
    // Projection definitions validate whole JSON values before snapshot publication.
    values: snapshot.values
  };
}
function validatePageRequest(request) {
  if (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1 || Object.is(request.throughSeq, -0)) {
    throw new RemoteError3("gateway/bad-request", "throughSeq must be an integer greater than or equal to -1", {});
  }
  if (request.beforeSeq !== void 0 && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0 || Object.is(request.beforeSeq, -0))) {
    throw new RemoteError3("gateway/bad-request", "beforeSeq must be a non-negative safe integer", {});
  }
  if (request.maxMessages !== void 0 && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError3("gateway/bad-request", "maxMessages must be a positive safe integer", {});
  }
}
function validateFollowRequest(request) {
  if (request.maxMessages !== void 0 && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError3("gateway/bad-request", "maxMessages must be a positive safe integer", {});
  }
}
function addressId(address) {
  return address.kind === "session" ? address.sessionId : address.childSessionId;
}
function validateAddress(address, header, inheritedEventCount, projections) {
  if (address.kind === "session") {
    if (header.origin === "subagent") {
      throw new RemoteError3("session/agent-busy", "subagent Sessions require their durable parent address", {
        reason: "use subagent delivery for this child session"
      });
    }
    return;
  }
  if (header.origin !== "subagent" || header.parentSession !== address.parentSessionId) {
    throw new RemoteError3("subagent/unauthorized", "subagent does not belong to the supplied parent", {
      childSessionId: address.childSessionId
    });
  }
  const identity = projections?.values.subagent;
  if (identity === null) {
    throw new RemoteError3("subagent/catalog-diagnostic", "subagent descriptor is corrupt", {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: "corrupt"
    });
  }
  if (identity === void 0 || identity.seq < inheritedEventCount) {
    throw new RemoteError3("subagent/catalog-diagnostic", "subagent descriptor is unavailable", {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: "unsupported"
    });
  }
  if (identity.mode !== address.mode) {
    throw new RemoteError3("subagent/unauthorized", "subagent mode does not match the supplied address", {
      childSessionId: address.childSessionId
    });
  }
}
function rejectNotFound(address) {
  if (address.kind === "session") {
    throw new RemoteError3("session/not-found", `session "${address.sessionId}" not found`, { sessionId: address.sessionId });
  }
  throw new RemoteError3("subagent/not-found", "subagent is unavailable", {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId
  });
}
function paginate(events, beforeSeq, maxMessages, throughSeq = events.at(-1)?.seq ?? -1) {
  const end = SessionLogOffset2(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1));
  let count = 0;
  let cut = SessionLogOffset2(0);
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index];
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue;
    count++;
    const sources = event.sourceEventSeqs;
    let groupStart = event.seq;
    if (sources !== void 0) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source;
      }
    }
    if (count >= maxMessages) {
      cut = SessionLogOffset2(groupStart);
      break;
    }
  }
  return { events: events.slice(cut, end), hasMore: cut > 0 };
}
function wireHeader(header) {
  return { ...header };
}

// src/file-references.ts
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
var _list_dec, _a, _init;
var SessionFileReferences = class extends (_a = TypertRemoteService, _list_dec = [Remote], _a) {
  /** @param ctx - Host context carrying the selected file-reference provider. */
  constructor(ctx) {
    super(ctx, "sessionFileReferences", { namespace: "fileReferences" });
    __runInitializers(_init, 5, this);
  }
  list(agent, query, signal) {
    return this.ctx.fileReferences.list(agent, query, signal);
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "list", _list_dec, SessionFileReferences);
__decoratorMetadata(_init, SessionFileReferences);
__publicField(SessionFileReferences, "inject", ["fileReferences", "typert"]);

// src/list.ts
import { SessionLogOffset as SessionLogOffset3 } from "@deepseek-ai/dsh-session";
import { SessionQueryError as SessionQueryError4 } from "@deepseek-ai/dsh-session-query";
import { RemoteError as RemoteError4 } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";

// src/types.ts
var SESSION_SEARCH_RESULT_LIMIT = 20;
var SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240;

// src/list.ts
var SEARCH_PROVIDER_CALL_LIMIT = 100;
var SESSION_SEARCH_QUERY_MAX_CHARS = 500;
var MESSAGE_TYPES2 = /* @__PURE__ */ new Set(["user/message", "assistant/message"]);
var sessionListMetadataSchema = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable()
});
var imageLimitsSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.string())
});
function applySessionListMetadata(state, event) {
  const blank = state.blank && event.type !== "turn/start";
  const lastPromptAt = event.type === "user/message" && event.data.source.kind === "user" ? event.time : state.lastPromptAt;
  return blank === state.blank && lastPromptAt === state.lastPromptAt ? state : { blank, lastPromptAt };
}
function truncateUnicodeCodePoints(value, maximum) {
  let count = 0;
  let end = 0;
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end);
    count++;
    end += codePoint.length;
  }
  return value;
}
var ApiSessionList = class {
  /** @param ctx - Host context carrying Session, query, persistence, and projection services. */
  constructor(ctx) {
    this.ctx = ctx;
    ctx.sessionProjections.register({
      key: "sessionListMetadata",
      stateSchema: sessionListMetadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataSchema, view: (state) => state },
      stateVersion: 1
    });
    ctx.inject(["attachments"], (attachmentCtx) => {
      ctx.sessionProjections.register({
        key: "imageLimits",
        stateSchema: z.null(),
        init: () => null,
        apply: (state) => state,
        wire: {
          viewSchema: imageLimitsSchema,
          view: () => attachmentCtx.attachments.imageLimits
        },
        stateVersion: 1
      });
    });
  }
  ctx;
  /**
   * Build one current attached-Session summary.
   * @param session - attached Session to summarize.
   * @returns current list metadata and available projections.
   */
  summaryFor(session) {
    const projections = this.projectionsFor(session.header, session);
    const metadata = projections?.values.sessionListMetadata;
    return {
      sessionId: session.id,
      updatedAt: updatedAt(session.header, metadata),
      running: this.ctx.agents.get(session.id)?.status === "running",
      blank: metadata?.blank ?? session.seq === 0,
      ...listFields(session.header),
      ...projections === void 0 ? {} : { projections }
    };
  }
  /**
   * Read every visible attached and persisted Session without activating an Agent.
   * @param signal - optional cancellation for persistence reads.
   * @returns visible Session summaries ordered by activity.
   */
  async list(signal) {
    signal?.throwIfAborted();
    const records = await this.ctx.sessionQuery.listSessions(signal);
    signal?.throwIfAborted();
    const items = [];
    const cold = [];
    for (const record of records) {
      const live = this.ctx.sessions.get(record.header.id);
      if (live !== void 0) {
        items.push(this.summaryFor(live));
        continue;
      }
      if (record.header.cwd === void 0) continue;
      cold.push(record.header);
    }
    for (const header of cold) items.push(this.summarizeCold(header));
    items.sort((left, right) => right.updatedAt - left.updatedAt);
    return items;
  }
  summarizeCold(header) {
    const projections = this.projectionsFor(header, void 0);
    const metadata = projections?.values.sessionListMetadata;
    return {
      sessionId: header.id,
      updatedAt: updatedAt(header, metadata),
      running: false,
      // A large, metadata-less, or inaccessible cache miss remains unknown and visible.
      blank: metadata?.blank ?? false,
      ...listFields(header),
      ...projections === void 0 ? {} : { projections }
    };
  }
  /**
   * Search current visible message content without activating any matching Session.
   * @param query - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  async search(query, signal) {
    const normalizedQuery = normalizeSearchQuery(query);
    signal.throwIfAborted();
    const provider = this.ctx.get("sessionQuery");
    if (provider === void 0) {
      throw new RemoteError4(
        "gateway/internal",
        "session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query",
        {}
      );
    }
    try {
      const visible = await provider.listSessions(signal);
      signal.throwIfAborted();
      const visibleIds = new Set(visible.filter((record) => record.header.cwd !== void 0).map((record) => record.header.id));
      if (visibleIds.size === 0) return { items: [], hasMore: false };
      const authorized = [];
      const acceptedIds = /* @__PURE__ */ new Set();
      const seenCursors = /* @__PURE__ */ new Set();
      let cursor;
      let providerCalls = 0;
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT;
      while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
        signal.throwIfAborted();
        if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
          throw new Error(`session search provider exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`);
        }
        providerCalls++;
        const requestedCursor = cursor;
        const requestedLimit = pageLimit;
        let page;
        try {
          page = await provider.searchSessions({
            query: normalizedQuery,
            eventFilters: [
              { kind: "type", values: ["user/message", "assistant/message"] },
              { kind: "surface", values: ["current"] }
            ],
            limit: requestedLimit,
            ...requestedCursor === void 0 ? {} : { cursor: requestedCursor }
          }, { signal });
          signal.throwIfAborted();
        } catch (error) {
          signal.throwIfAborted();
          if (requestedCursor === void 0 && error instanceof SessionQueryError4 && error.code === "SESSION_QUERY_INVALID_LIMIT" && requestedLimit > 1) {
            pageLimit = Math.max(1, Math.floor(requestedLimit / 2));
            continue;
          }
          if (requestedCursor !== void 0 && error instanceof SessionQueryError4 && error.code === "SESSION_QUERY_STALE_CURSOR") {
            authorized.length = 0;
            acceptedIds.clear();
            seenCursors.clear();
            cursor = void 0;
            continue;
          }
          throw error;
        }
        if (page.items.length > requestedLimit) {
          throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`);
        }
        for (const hit of page.items) {
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue;
          if (!visibleIds.has(hit.header.id) || hit.bestMatch.sessionId !== hit.header.id || hit.bestMatch.surface !== "current" || !MESSAGE_TYPES2.has(hit.bestMatch.type) || acceptedIds.has(hit.header.id)) continue;
          acceptedIds.add(hit.header.id);
          authorized.push({
            sessionId: hit.header.id,
            snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS)
          });
        }
        if (page.nextCursor !== void 0) {
          if (seenCursors.has(page.nextCursor)) {
            throw new Error("session search provider repeated a continuation cursor");
          }
          seenCursors.add(page.nextCursor);
        }
        if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === void 0) break;
        cursor = page.nextCursor;
      }
      return {
        items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
        hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT
      };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SessionQueryError4 && error.code === "SESSION_QUERY_ABORTED") {
        throw new RemoteError4("gateway/cancelled", "session search was aborted", {});
      }
      throw new RemoteError4("gateway/internal", `session search failed: ${String(error)}`, {});
    }
  }
  projectionsFor(header, session) {
    try {
      const cache = this.ctx.get("sessionProjectionCache");
      const block = session === void 0 ? header.isSeeded ? void 0 : cache?.cachedSnapshot(header, SessionLogOffset3(0)) ?? cache?.cachedPredecessorTitle(header, SessionLogOffset3(0)) : this.ctx.sessionProjections.cachedSnapshot(session);
      return block !== void 0 && Object.keys(block.values).length > 0 ? {
        asOfSeq: block.asOfSeq,
        // Listing hints contain every currently cached wire value but remain
        // partial: missing cells and cache rows are never materialized here.
        values: block.values
      } : void 0;
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${header.id}" failed; serving the row without it: ${String(error)}`
      );
      return void 0;
    }
  }
};
function normalizeSearchQuery(query) {
  const normalized = query.trim();
  if (normalized.length === 0) {
    throw new RemoteError4("gateway/bad-request", "session search query must not be empty", {});
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new RemoteError4(
      "gateway/bad-request",
      `session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`,
      {}
    );
  }
  if (normalized.includes("\0")) {
    throw new RemoteError4("gateway/bad-request", "session search query must not contain NUL", {});
  }
  return normalized;
}
function updatedAt(header, metadata) {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0);
}
function listFields(header) {
  return {
    ...header.parentSession === void 0 ? {} : { parentSessionId: header.parentSession },
    ...header.origin === void 0 ? {} : { origin: header.origin },
    ...header.cwd === void 0 ? {} : { cwd: header.cwd }
  };
}

// src/catalog.ts
async function buildModelCatalog(ctx, defaultSelection = ctx.agentDefaultModel.currentSelection()) {
  const providers = ctx.llm.listProviders();
  const catalog = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id);
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
        const reasoning = resolved.reasoning === void 0 ? void 0 : {
          efforts: resolved.reasoning.efforts.map((effort) => ({
            id: effort.id,
            name: effort.name,
            ...effort.description === void 0 ? {} : { description: effort.description }
          })),
          ...resolved.reasoning.defaultEffort === void 0 ? {} : { defaultEffort: resolved.reasoning.defaultEffort }
        };
        return {
          id: model.id,
          name: model.name,
          ...model.description === void 0 ? {} : { description: model.description },
          ...reasoning === void 0 ? {} : { reasoning }
        };
      }));
      return {
        kind: "group",
        group: { id: provider.id, name: provider.name, models: entries }
      };
    } catch (error) {
      return {
        kind: "failure",
        failure: {
          id: provider.id,
          name: provider.name,
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }));
  return {
    default: { ...defaultSelection },
    routableProviders: providers.map((provider) => provider.id),
    groups: catalog.flatMap((item) => item.kind === "group" ? [item.group] : []).filter((group) => group.models.length > 0),
    failures: catalog.flatMap((item) => item.kind === "failure" ? [item.failure] : [])
  };
}

// src/model-selection-projection.ts
import { z as z2 } from "zod";
var modelSelectionSchema = z2.object({
  provider: z2.string().min(1),
  model: z2.string().min(1),
  reasoningEffort: z2.string().min(1).optional()
});
var modelSelectionProjectionStateSchema = z2.object({
  lastUsed: modelSelectionSchema.nullable(),
  pending: modelSelectionSchema.nullable()
});
var modelSelectionProjectionSchema = z2.object({
  lastUsed: modelSelectionSchema.nullable(),
  next: modelSelectionSchema.nullable()
});
function applyModelSelectionProjection(state, event) {
  if (event.type === "model/selection") {
    return sameSelection(state.pending, event.data) ? state : { lastUsed: state.lastUsed, pending: event.data };
  }
  if (event.type !== "request/header") return state;
  const lastUsed = {
    provider: event.data.header.config.provider,
    model: event.data.header.config.model,
    ...event.data.header.config.reasoningEffort === void 0 ? {} : { reasoningEffort: String(event.data.header.config.reasoningEffort) }
  };
  const pending = sameSelection(state.pending, lastUsed) ? null : state.pending;
  return sameSelection(state.lastUsed, lastUsed) && pending === state.pending ? state : { lastUsed, pending };
}
var modelSelectionProjection = {
  key: "modelSelection",
  stateSchema: modelSelectionProjectionStateSchema,
  init: () => ({ lastUsed: null, pending: null }),
  apply: applyModelSelectionProjection,
  wire: {
    viewSchema: modelSelectionProjectionSchema,
    view: (state) => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed })
  },
  stateVersion: 2
};
function sameSelection(left, right) {
  return left === right || left !== null && right !== null && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
function installModelSelectionProjection(ctx) {
  ctx.sessionProjections.register(modelSelectionProjection);
}

// src/skill-catalog.ts
import { SessionQueryError as SessionQueryError5 } from "@deepseek-ai/dsh-session-query";
import { isUserInvocable } from "@deepseek-ai/dsh-skill";
import { Remote as Remote2, RemoteError as RemoteError5, TypertRemoteService as TypertRemoteService2 } from "@deepseek-ai/dsh-typert-protocol";
var _list_dec2, _a2, _init2;
var SessionSkillCatalog = class extends (_a2 = TypertRemoteService2, _list_dec2 = [Remote2], _a2) {
  /** @param ctx - Host context carrying Session reads and optional skill/preset services. */
  constructor(ctx) {
    super(ctx, "sessionSkillCatalog", { namespace: "skills" });
    __runInitializers(_init2, 5, this);
  }
  async list(request, signal) {
    void signal;
    const { sessionId } = request;
    let cwd;
    let agentPreset;
    try {
      var _stack = [];
      try {
        const observation = __using(_stack, await this.ctx.sessionQuery.observeSession(sessionId));
        if (observation.projections === void 0) {
          throw new Error("skill catalog requires a projected Session observation");
        }
        cwd = observation.header.cwd;
        agentPreset = observation.projections.values.agentPreset ?? void 0;
      } catch (_) {
        var _error = _, _hasError = true;
      } finally {
        __callDispose(_stack, _error, _hasError);
      }
    } catch (error) {
      if (error instanceof SessionQueryError5 && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") {
        throw new RemoteError5("session/not-found", `session "${sessionId}" not found`, { sessionId });
      }
      throw new RemoteError5(
        "gateway/internal",
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {}
      );
    }
    if (cwd === void 0) {
      throw new RemoteError5("gateway/internal", `session "${sessionId}" has no project cwd`, {});
    }
    const live = this.ctx.agents.get(sessionId);
    const presets = this.ctx.get("agentPresets");
    const scoped = live === void 0 ? void 0 : presets?.serviceFor(live, "skills");
    const skillRegistry = scoped ?? this.ctx.get("skills");
    if (skillRegistry === void 0) {
      throw new RemoteError5(
        "gateway/internal",
        "skill registry is absent: neither this session's agent preset nor the host composition mounts @deepseek-ai/dsh-skill",
        {}
      );
    }
    const scope = await this.scopeFor(sessionId, agentPreset);
    try {
      const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable);
      return {
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          ...skill.whenToUse === void 0 ? {} : { whenToUse: skill.whenToUse },
          modelInvocable: skill.invocation.modelInvocable
        }))
      };
    } catch (error) {
      throw new RemoteError5("gateway/internal", `skill listing failed: ${String(error)}`, {});
    }
  }
  /** Resolve a live or standing preset scope without creating an Agent. */
  async scopeFor(sessionId, agentPreset) {
    const live = this.ctx.agents.get(sessionId);
    if (live !== void 0) return live;
    const presets = this.ctx.get("agentPresets");
    if (presets === void 0) return void 0;
    try {
      return await presets.standingKeyFor(agentPreset);
    } catch {
      return void 0;
    }
  }
};
_init2 = __decoratorStart(_a2);
__decorateElement(_init2, 1, "list", _list_dec2, SessionSkillCatalog);
__decoratorMetadata(_init2, SessionSkillCatalog);
__publicField(SessionSkillCatalog, "inject", ["agents", "sessionQuery", "typert"]);

// src/media-references.ts
import { isAbsolute } from "node:path";
import { FsError } from "@deepseek-ai/dsh-fs";
import mime from "mime-types";
var BASE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  // HTML and SVG files may be opened directly on the authenticated API origin.
  "Content-Security-Policy": "sandbox; default-src 'none'"
};
async function serveFile(request, fs, maxBytes) {
  const fail = (status, text) => new Response(request.method === "HEAD" ? null : text, { status, headers: BASE_HEADERS });
  const path = new URL(request.url).searchParams.get("path");
  if (path === null || path.length === 0) return fail(400, "missing path");
  if (path.includes("\0") || !isAbsolute(path)) return fail(400, "absolute path required");
  try {
    const target = await fs.resolve(path, { signal: request.signal });
    const mediaType = mime.lookup(target.displayPath) || "application/octet-stream";
    const headers = {
      ...BASE_HEADERS,
      "Content-Type": mediaType
    };
    if (request.method === "HEAD") {
      const info = await fs.stat(target, request.signal);
      if (info === void 0) return fail(404, "not found");
      if (info.type !== "file") return fail(403, "not a regular file");
      if (info.size !== void 0) {
        if (info.size > maxBytes) return fail(413, "file exceeds byte limit");
        headers["Content-Length"] = String(info.size);
      }
      return new Response(null, { headers });
    }
    const bytes = await fs.readBytes(target, request.signal, maxBytes);
    headers["Content-Length"] = String(bytes.byteLength);
    return new Response(bytes.slice(), { headers });
  } catch (error) {
    if (!(error instanceof FsError)) throw error;
    const statuses = {
      FS_NOT_FOUND: 404,
      FS_NOT_REGULAR_FILE: 403,
      FS_PERMISSION_DENIED: 403,
      FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413,
      FS_ABORTED: 499
    };
    return fail(statuses[error.code] ?? 500, error.code);
  }
}
var SessionMediaReferences = {
  inject: ["connection", "fs", "attachments"],
  apply(ctx) {
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes;
    ctx.effect(() => ctx.connection.fetch.register({
      path: "/api/file",
      methods: ["GET", "HEAD"],
      requestBody: "buffered",
      fetch: (request) => serveFile(request, ctx.fs, maxBytes)
    }), "session-controller: /api/file");
  }
};

// src/index.ts
var _control_dec, _follow_dec, _page_dec, _cancel_dec, _updateQueue_dec, _attachment_dec, _prompt_dec, _fork_dec, _rename_dec, _openWorkspacePath_dec, _canOpenWorkspacePath_dec, _modelCatalog_dec, _selectModel_dec, _create_dec, _search_dec, _list_dec3, _a3, _init3;
var SessionController = class extends (_a3 = TypertRemoteService3, _list_dec3 = [Remote3("list")], _search_dec = [Remote3("search")], _create_dec = [Remote3("create")], _selectModel_dec = [Remote3("selectModel")], _modelCatalog_dec = [Remote3("modelCatalog")], _canOpenWorkspacePath_dec = [Remote3], _openWorkspacePath_dec = [Remote3("openWorkspacePath")], _rename_dec = [Remote3("rename")], _fork_dec = [Remote3("fork")], _prompt_dec = [Remote3("prompt")], _attachment_dec = [Remote3("attachment")], _updateQueue_dec = [Remote3("updateQueue")], _cancel_dec = [Remote3("cancel")], _page_dec = [Remote3("page")], _follow_dec = [Remote3({ mode: "stream" })], _control_dec = [Remote3({ mode: "stream" })], _a3) {
  /**
   * @param ctx - Host context containing the Session capability assembly.
   * @param config - native-opener deployment policy.
   * @param internals - host integrations replaceable by direct unit tests.
   */
  constructor(ctx, config, internals = {}) {
    super(ctx, "sessionController", { namespace: "session" });
    __runInitializers(_init3, 5, this);
    __publicField(this, "agents");
    __publicField(this, "hostRoutingVersion", 1);
    __publicField(this, "hostRoutes", new SessionHostRoutes());
    __publicField(this, "commands");
    __publicField(this, "controlState");
    __publicField(this, "history");
    __publicField(this, "listState");
    __publicField(this, "openPath");
    __publicField(this, "revealPath");
    __publicField(this, "canOpenPath");
    __publicField(this, "promotions", /* @__PURE__ */ new Set());
    installModelSelectionProjection(ctx);
    this.agents = new ApiSessionAgentController(ctx);
    this.commands = new SessionCommandController(ctx, this.agents, process.cwd(), this.hostRoutes);
    ctx.effect(() => ctx.fileUploads.registerAgentResolver(async (sessionId) => {
      const result = await this.agents.resolveAgent(sessionId);
      if ("error" in result) throw result.error;
      return result.agent;
    }), "session-controller: file-upload Agent resolver");
    this.controlState = new SessionControlController(ctx);
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.promotions]);
    }, "session-controller.promotions");
    this.history = new SessionHistoryController(ctx, (observation) => {
      this.promote(observation);
    }, this.hostRoutes);
    this.listState = new ApiSessionList(ctx);
    this.openPath = internals.openPath ?? openNativePath;
    this.revealPath = internals.revealPath ?? revealNativePath;
    this.canOpenPath = internals.canOpenPath ?? (() => config.nativeOpen ?? (internals.openPath !== void 0 || canOpenNativePath()));
    ctx.plugin(SessionFileReferences);
    ctx.plugin(SessionMediaReferences);
    ctx.plugin(SessionSkillCatalog);
    ctx.on("session/created", (session) => {
      ctx.emit("api-session/added", this.listState.summaryFor(session));
    });
    ctx.on("session/disposed", (session) => {
      ctx.emit("api-session/removed", session.id);
    });
    ctx.on("agent/status", ({ agent, status }) => {
      ctx.emit("api-session/status", agent.id, status === "running");
    });
    ctx.on("agent/error", ({ agent, error }) => {
      ctx.emit("api-session/error", agent.id, errorChain(error));
    });
    ctx.on("session/event", (session, event) => {
      if (event.type === "request/header") {
        const agent = ctx.agents.get(session.id);
        if (agent?.session === session) this.agents.consumeSelection(
          agent,
          event.data.header.config.provider,
          event.data.header.config.model,
          event.data.header.config.reasoningEffort
        );
      }
      if (event.type !== "user/message" || event.data.source.kind !== "user") return;
      ctx.emit("api-session/activity", session.id, event.time);
    });
  }
  /** Source-level host extension; leases affect exactly one existing Session. */
  registerPromptRoute(sessionId, handler) {
    return this.hostRoutes.registerPrompt(sessionId, handler);
  }
  /** Presentation is a derived wire view. The append-only native log remains untouched. */
  registerHistoryPresentation(sessionId, presentation) {
    return this.hostRoutes.registerPresentation(sessionId, presentation);
  }
  promote(observation) {
    const sessionId = observation.header.id;
    const task = (async () => {
      var _stack = [];
      try {
        const ownedObservation = __using(_stack, observation);
        const result = await this.agents.resolveObservedAgent(ownedObservation);
        if ("error" in result) this.ctx.emit("api-session/error", sessionId, result.error.message);
      } catch (_) {
        var _error = _, _hasError = true;
      } finally {
        __callDispose(_stack, _error, _hasError);
      }
    })().catch((error) => {
      this.ctx.logger.error(`session-controller: background activation for "${sessionId}" failed: ${errorChain(error)}`);
    });
    this.promotions.add(task);
    void task.finally(() => {
      this.promotions.delete(task);
    });
  }
  /**
   * Resolve or resume one ordinary Session for another Host API domain.
   * @param sessionId - Session identity whose Agent owns the operation.
   * @returns the live Agent or the stable Session-domain failure.
   */
  resolveAgent(sessionId) {
    return this.agents.resolveAgent(sessionId);
  }
  /**
   * Inspect one attached or persisted Session without activating its Agent.
   * @param sessionId - durable Session identity.
   * @param signal - optional caller cancellation for persistence reads.
   * @returns the current attached state or persisted header and event prefix.
   */
  inspect(sessionId, signal) {
    const attached = this.ctx.sessions.get(sessionId);
    if (attached !== void 0) {
      return Promise.resolve({
        meta: attached.header,
        inheritedEventCount: attached.inheritedEventCount,
        events: attached.snapshotEvents()
      });
    }
    return inspectApiSession(this.ctx, sessionId, signal);
  }
  async list(_request, signal) {
    return { items: await this.listState.list(signal) };
  }
  search(request, signal) {
    return this.listState.search(request.query, signal);
  }
  create(request) {
    return this.commands.create(request);
  }
  selectModel(request) {
    return this.commands.selectModel(request);
  }
  modelCatalog() {
    return buildModelCatalog(this.ctx);
  }
  canOpenWorkspacePath() {
    return this.canOpenPath();
  }
  /**
   * Describe the serving desktop for authenticated file-action routes.
   * @returns Host name, configured availability, and platform-specific file-manager behavior.
   */
  workspaceDesktop() {
    const fileManager = nativeFileManager();
    return { name: hostname(), available: fileManager !== null && this.canOpenPath(), fileManager };
  }
  async openWorkspacePath(request, signal) {
    if (request.path.length === 0) {
      throw new RemoteError6(
        "gateway/bad-request",
        "session.openWorkspacePath requires a non-empty path",
        {}
      );
    }
    signal.throwIfAborted();
    try {
      if (request.action === "reveal") await this.revealPath(request.path, signal);
      else await this.openPath(request.path, signal);
      return { opened: true };
    } catch (error) {
      if (signal.aborted) throw new RemoteError6("gateway/cancelled", "path open was aborted", {});
      throw new RemoteError6(
        "gateway/internal",
        `path open failed: ${error instanceof Error ? error.message : String(error)}`,
        {}
      );
    }
  }
  rename(request) {
    return this.commands.rename(request);
  }
  fork(request) {
    return this.commands.fork(request);
  }
  prompt(request, signal) {
    signal.throwIfAborted();
    return this.commands.prompt(request);
  }
  attachment(request) {
    return this.commands.attachment(request);
  }
  updateQueue(request) {
    return this.commands.updateQueue(request);
  }
  cancel(request) {
    return this.commands.cancel(request);
  }
  page(request, signal) {
    return this.history.page(request, signal);
  }
  follow(request, signal) {
    return this.history.follow(request, signal);
  }
  control(signal) {
    return this.controlState.control(signal);
  }
};
_init3 = __decoratorStart(_a3);
__decorateElement(_init3, 1, "list", _list_dec3, SessionController);
__decorateElement(_init3, 1, "search", _search_dec, SessionController);
__decorateElement(_init3, 1, "create", _create_dec, SessionController);
__decorateElement(_init3, 1, "selectModel", _selectModel_dec, SessionController);
__decorateElement(_init3, 1, "modelCatalog", _modelCatalog_dec, SessionController);
__decorateElement(_init3, 1, "canOpenWorkspacePath", _canOpenWorkspacePath_dec, SessionController);
__decorateElement(_init3, 1, "openWorkspacePath", _openWorkspacePath_dec, SessionController);
__decorateElement(_init3, 1, "rename", _rename_dec, SessionController);
__decorateElement(_init3, 1, "fork", _fork_dec, SessionController);
__decorateElement(_init3, 1, "prompt", _prompt_dec, SessionController);
__decorateElement(_init3, 1, "attachment", _attachment_dec, SessionController);
__decorateElement(_init3, 1, "updateQueue", _updateQueue_dec, SessionController);
__decorateElement(_init3, 1, "cancel", _cancel_dec, SessionController);
__decorateElement(_init3, 1, "page", _page_dec, SessionController);
__decorateElement(_init3, 1, "follow", _follow_dec, SessionController);
__decorateElement(_init3, 1, "control", _control_dec, SessionController);
__decoratorMetadata(_init3, SessionController);
__publicField(SessionController, "inject", [
  "agentDefaultModel",
  "agents",
  "attachments",
  "fileUploads",
  "llm",
  "sessions",
  "sessionProjections",
  "sessionQuery",
  "typert",
  "workspaceRegistry"
]);
__publicField(SessionController, "Config", z3.object({
  nativeOpen: z3.boolean()
}));
var index_default = SessionController;
export {
  ApiSessionNotFound,
  SessionController,
  SessionFileReferences,
  SessionSkillCatalog,
  buildModelCatalog,
  index_default as default
};
//# sourceMappingURL=index.js.map
