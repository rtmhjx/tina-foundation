// upstream/dsh-token-meter/src/index.js
import { Service } from "@deepseek-ai/cordis";
import z3 from "@deepseek-ai/schemastery";
import { assembleAssistantStream } from "@deepseek-ai/dsh-llm";

// upstream/dsh-token-meter/src/pressure-usage.js
import { lastAssistantStreamChunk } from "@deepseek-ai/dsh-llm";
function pressureUsageOf(event, billingUsage) {
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return void 0;
  const finish = Array.isArray(event.data.stream) ? lastAssistantStreamChunk(event.data.stream, "finish") : void 0;
  const response = event.data.message?.source?.replayState?.response ?? finish?.replayState?.response;
  if (response?.kind === "cortico-response-v1" || response?.kind === "cortico-attempts-v1") {
    const last = response.lastRequestUsage;
    if (!["last-provider-attempt", "response-usage"].includes(last?.basis) || !Number.isSafeInteger(last?.input) || last.input < 0) return void 0;
    return {
      inputTokens: last.input,
      ...Number.isSafeInteger(last.output) && last.output >= 0 ? { outputTokens: last.output } : {}
    };
  }
  if (!finish && (event.type === "assistant/attempt" || event.data.interrupted === true)) return void 0;
  return billingUsage;
}

// upstream/dsh-token-meter/src/index.js
import { deepFreeze } from "@deepseek-ai/dsh-util-values";
import { canonicalHeader as canonicalHeader2, headerEquals, isSurfaceEvent as isSurfaceEvent3, SessionLogOffset, SessionSeq as SessionSeq4 } from "@deepseek-ai/dsh-session";

// upstream/dsh-token-meter/src/breakdown-projection.js
import { z } from "zod";
import { canonicalHeader, isSurfaceEvent, SessionSeq } from "@deepseek-ai/dsh-session";

// upstream/dsh-token-meter/src/estimate.js
var CHARS_PER_TOKEN = 4;
var BLOCK_OVERHEAD = 4;
var ROLE_OVERHEAD = 4;
function estimateStructuralBlock(block) {
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
}
function estimateContent(blocks) {
  let tokens = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "text":
      case "reasoning":
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
        break;
      case "tool-call":
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN) + Math.ceil(block.arguments.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
        break;
      case "tool-result":
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD;
        break;
      default:
        tokens += estimateStructuralBlock(block);
    }
  }
  return tokens;
}
function estimateSystemMessage(message) {
  if (message.content.length === 0)
    return 0;
  let characters = 0;
  for (const block of message.content) {
    characters += block.type === "text" ? block.text.length : JSON.stringify(block).length;
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
}
function estimateMessage(message) {
  if (message.role === "system")
    return estimateSystemMessage(message);
  return estimateContent(message.content) + ROLE_OVERHEAD;
}
function estimateToolsTokens(header) {
  if (header?.tools === void 0 || header.tools.length === 0)
    return 0;
  return Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}

// upstream/dsh-token-meter/src/surface-fold.js
import { deriveEventMessage } from "@deepseek-ai/dsh-session";
function collectProjectedAttachments(blocks, images, files) {
  let imageTokens = 0;
  let fileTokens = 0;
  for (const block of blocks) {
    if (block.type === "image") {
      images.push(block.attachment);
      imageTokens += estimateStructuralBlock(block);
    } else if (block.type === "file") {
      files.push(block.attachment);
      fileTokens += estimateStructuralBlock(block);
    } else if (block.type === "tool-result") {
      const nested = collectProjectedAttachments(block.content, images, files);
      imageTokens += nested.imageTokens;
      fileTokens += nested.fileTokens;
    }
  }
  return { imageTokens, fileTokens };
}
function analyzeNode(seq, message) {
  if (message === null) {
    return {
      seq,
      heuristicTokens: 0,
      imageStructuralTokens: 0,
      fileStructuralTokens: 0,
      images: [],
      files: []
    };
  }
  const heuristicTokens = estimateMessage(message);
  const images = [];
  const files = [];
  const structural = collectProjectedAttachments(message.content, images, files);
  return {
    seq,
    heuristicTokens,
    imageStructuralTokens: structural.imageTokens,
    fileStructuralTokens: structural.fileTokens,
    images,
    files
  };
}
function planSurfaceTokens(nodes, event) {
  const node = analyzeNode(event.seq, deriveEventMessage(event));
  const tokens = node.heuristicTokens;
  const op = event.surfaceOp;
  if (op === "append") {
    return { tokens, deltaTokens: tokens, node, target: "append" };
  }
  const startIdx = nodes.findIndex((candidate) => candidate.seq === op.startSeq);
  const endIdx = nodes.findIndex((candidate) => candidate.seq === op.endSeq);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error(`token surface: replace at seq ${event.seq} has invalid current range ${op.startSeq}-${op.endSeq}`);
  }
  const removed = nodes.slice(startIdx, endIdx + 1).reduce((total, candidate) => total + candidate.heuristicTokens, 0);
  return { tokens, deltaTokens: tokens - removed, node, target: { startIdx, endIdx } };
}
function commitSurfaceTokens(nodes, plan) {
  if (plan.target === "append") {
    nodes.push(plan.node);
    return;
  }
  nodes.splice(plan.target.startIdx, plan.target.endIdx - plan.target.startIdx + 1, plan.node);
}

// upstream/dsh-token-meter/src/breakdown-projection.js
var tokenCount = z.number().int().nonnegative();
var sessionSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq);
var breakdownSchema = z.object({
  systemTokens: tokenCount,
  toolsTokens: tokenCount,
  messageTokens: tokenCount
}).strict();
var contextBreakdownStateSchema = z.object({
  nodes: z.array(z.object({
    seq: sessionSeq,
    heuristicTokens: tokenCount,
    system: z.boolean()
  }).strict()),
  breakdown: breakdownSchema
}).strict();
var contextBreakdownProjectionDefinition = {
  key: "contextBreakdown",
  stateVersion: 4,
  stateSchema: contextBreakdownStateSchema,
  init: () => ({
    nodes: [],
    breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 }
  }),
  apply: (state, event) => {
    if (event.type === "request/header") {
      const toolsTokens = estimateToolsTokens(canonicalHeader(event.data.header));
      return toolsTokens === state.breakdown.toolsTokens ? state : { ...state, breakdown: { ...state.breakdown, toolsTokens } };
    }
    if (!isSurfaceEvent(event))
      return state;
    const plan = planSurfaceTokens(state.nodes, event);
    const nodes = [...state.nodes];
    commitSurfaceTokens(nodes, {
      ...plan,
      node: { seq: event.seq, heuristicTokens: plan.tokens, system: event.type === "system/message" }
    });
    const systemTokens = nodes.findLast((node) => node.system && node.heuristicTokens > 0)?.heuristicTokens ?? 0;
    const messageTokens = state.breakdown.systemTokens + state.breakdown.messageTokens + plan.deltaTokens - systemTokens;
    const breakdown = systemTokens === state.breakdown.systemTokens && messageTokens === state.breakdown.messageTokens ? state.breakdown : { systemTokens, toolsTokens: state.breakdown.toolsTokens, messageTokens };
    return { nodes, breakdown };
  },
  wire: {
    viewSchema: breakdownSchema,
    view: (state) => state.breakdown
  }
};

// upstream/dsh-token-meter/src/usage-projection.js
import { z as z2 } from "zod";
import { lastAssistantStreamChunk as lastAssistantStreamChunk2 } from "@deepseek-ai/dsh-llm";
import { SessionSeq as SessionSeq3 } from "@deepseek-ai/dsh-session";

// upstream/dsh-token-meter/src/surface-projection.js
import { deriveEventMessage as deriveEventMessage2, isSurfaceEvent as isSurfaceEvent2, SessionSeq as SessionSeq2 } from "@deepseek-ai/dsh-session";
function foldSurfaceProjection(claim, event) {
  if (event.type === "compaction/summary" || event.type === "compaction/prune") {
    const { shadowedRange, shadowedTokenCount } = event.data;
    return {
      deltaTokens: 0,
      claim: {
        start: SessionSeq2(shadowedRange.start),
        end: SessionSeq2(shadowedRange.end),
        tokens: shadowedTokenCount
      }
    };
  }
  if (!isSurfaceEvent2(event))
    return { deltaTokens: 0, claim: void 0 };
  const message = deriveEventMessage2(event);
  const tokens = message === null ? 0 : estimateMessage(message);
  const op = event.surfaceOp;
  if (op === "append")
    return { deltaTokens: tokens, claim: void 0 };
  if (claim === void 0)
    return { deltaTokens: 0, claim: void 0 };
  if (claim.start !== op.startSeq || claim.end !== op.endSeq) {
    throw new Error(`token surface: replace at seq ${event.seq} over range ${op.startSeq}-${op.endSeq} has no adjacent shadow price (armed claim covers ${claim.start}-${claim.end})`);
  }
  return { deltaTokens: tokens - claim.tokens, claim: void 0 };
}

// upstream/dsh-token-meter/src/usage-projection.js
var zeroBuckets = () => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
});
var bucketsFrom = (usage) => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0
});
var bucketsEqual = (left, right) => left.uncachedInputTokens === right.uncachedInputTokens && left.outputTokens === right.outputTokens && left.cacheReadTokens === right.cacheReadTokens && left.cacheWriteTokens === right.cacheWriteTokens;
var addReplacing = (totals, previous, next) => ({
  uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
  outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
  cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens
});
var projectionSchema = z2.object({
  uncachedInputTokens: z2.number().int().nonnegative(),
  outputTokens: z2.number().int().nonnegative(),
  cacheReadTokens: z2.number().int().nonnegative(),
  cacheWriteTokens: z2.number().int().nonnegative()
}).strict();
var tokenUsageStateSchema = z2.object({
  totals: projectionSchema,
  last: z2.object({
    turn: z2.number().int().nonnegative(),
    step: z2.number().int().nonnegative(),
    buckets: projectionSchema
  }).nullable()
}).strict();
var pressureSchema = z2.object({
  pressureTokens: z2.number().int().nonnegative().optional(),
  projectedTokens: z2.number().int().nonnegative().optional(),
  contextWindow: z2.number().int().positive().optional()
}).strict().transform(({ pressureTokens, projectedTokens, contextWindow }) => ({
  ...pressureTokens === void 0 ? {} : { pressureTokens },
  ...projectedTokens === void 0 ? {} : { projectedTokens },
  ...contextWindow === void 0 ? {} : { contextWindow }
}));
var pressureFrom = (usage) => usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
function usageOf(event) {
  if (event.type === "assistant/message" && event.data.usage !== void 0)
    return event.data.usage;
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt")
    return void 0;
  return lastAssistantStreamChunk2(event.data.stream, "usage")?.usage;
}
var contextPressureStateSchema = z2.object({
  contextWindow: z2.number().int().positive().optional(),
  pressureTokens: z2.number().int().nonnegative().optional(),
  surfaceTokens: z2.number().int().nonnegative(),
  sampledSurfaceTokens: z2.number().int().nonnegative().optional(),
  headTokens: z2.number().int().nonnegative().optional(),
  sampledHeadTokens: z2.number().int().nonnegative().optional(),
  claim: z2.object({
    start: z2.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq3),
    end: z2.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq3),
    tokens: z2.number().int().nonnegative()
  }).optional()
}).strict();
var tokenUsageProjectionDefinition = {
  key: "tokenUsage",
  stateVersion: 2,
  stateSchema: tokenUsageStateSchema,
  init: () => ({ totals: zeroBuckets(), last: null }),
  apply: (state, event) => {
    if (event.type === "llm/retry-started") {
      return state.last?.turn === event.data.turn && state.last.step === event.data.step ? { ...state, last: null } : state;
    }
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") {
      return state;
    }
    const sample = usageOf(event);
    if (sample === void 0)
      return state;
    const { turn, step } = event.data;
    const usage = sample;
    const buckets = bucketsFrom(usage);
    const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last.buckets : void 0;
    if (previous !== void 0 && bucketsEqual(previous, buckets))
      return state;
    return {
      totals: addReplacing(state.totals, previous, buckets),
      last: { turn, step, buckets }
    };
  },
  wire: { viewSchema: projectionSchema, view: (state) => state.totals }
};
var contextPressureProjectionDefinition = {
  key: "contextPressure",
  stateVersion: 5,
  stateSchema: contextPressureStateSchema,
  init: () => ({ surfaceTokens: 0 }),
  apply: (state, event) => {
    const fold = foldSurfaceProjection(state.claim, event);
    let next = state;
    if (event.type === "request/context") {
      const messages = event.data.requestHead?.messages ?? [];
      if (!Array.isArray(messages)) throw new TypeError("Invalid request head messages");
      next = { ...next, headTokens: messages.reduce((sum, message) => sum + estimateMessage(message), 0) };
      const contextWindow = event.data.contextWindow;
      if (contextWindow !== state.contextWindow) {
        if (contextWindow !== void 0) {
          next = { ...next, contextWindow };
        } else {
          const { contextWindow: _removed, ...withoutContextWindow } = next;
          next = withoutContextWindow;
        }
      }
    }
    const usage = pressureUsageOf(event, usageOf(event));
    if (usage !== void 0) {
      const pressureTokens = pressureFrom(usage);
      if (pressureTokens !== next.pressureTokens || next.sampledSurfaceTokens !== next.surfaceTokens || next.sampledHeadTokens !== next.headTokens) {
        next = { ...next, pressureTokens, sampledSurfaceTokens: next.surfaceTokens, sampledHeadTokens: next.headTokens };
      }
    } else if (event.type === "assistant/message" || event.type === "assistant/attempt") {
      const { pressureTokens: _pressure, sampledSurfaceTokens: _sample, sampledHeadTokens: _head, ...withoutSample } = next;
      next = withoutSample;
    }
    if (fold.deltaTokens !== 0) {
      next = { ...next, surfaceTokens: next.surfaceTokens + fold.deltaTokens };
    }
    if (state.claim === void 0 && fold.claim === void 0)
      return next;
    const { claim: _expired, ...withoutClaim } = next;
    return fold.claim === void 0 ? withoutClaim : { ...withoutClaim, claim: fold.claim };
  },
  wire: {
    viewSchema: pressureSchema,
    view: ({ contextWindow, pressureTokens, surfaceTokens, sampledSurfaceTokens, headTokens, sampledHeadTokens }) => ({
      ...contextWindow === void 0 ? {} : { contextWindow },
      ...pressureTokens === void 0 ? {} : { pressureTokens },
      ...pressureTokens === void 0 || sampledSurfaceTokens === void 0 || headTokens === void 0 || sampledHeadTokens === void 0 ? {} : { projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens + headTokens - sampledHeadTokens) }
    })
  }
};

// upstream/dsh-token-meter/src/route-pricing.js
function priceSurface(nodes, pricing, fileText) {
  const images = pricing === void 0 ? [] : nodes.flatMap((node) => node.images);
  const hasFiles = fileText !== void 0 && nodes.some((node) => node.files.length > 0);
  if ((pricing === void 0 || images.length === 0) && !hasFiles) {
    let surfaceTokens2 = 0;
    const publicNodes2 = nodes.map((node) => {
      surfaceTokens2 += node.heuristicTokens;
      return { seq: node.seq, tokens: node.heuristicTokens, heuristicTokens: node.heuristicTokens };
    });
    return { nodes: publicNodes2, surfaceTokens: surfaceTokens2 };
  }
  const prices = pricing === void 0 ? [] : pricing.priceImages(images);
  if (pricing !== void 0 && prices.length !== images.length) {
    throw new Error(`token meter: route image pricing answered ${prices.length} prices for ${images.length} occurrences`);
  }
  let cursor = 0;
  let surfaceTokens = 0;
  const publicNodes = nodes.map((node) => {
    let tokens = node.heuristicTokens;
    if (fileText !== void 0 && node.files.length > 0) {
      tokens -= node.fileStructuralTokens;
      for (const file of node.files) {
        tokens += estimateContent([{ type: "text", text: fileText(file) }]);
      }
    }
    if (pricing !== void 0 && node.images.length > 0) {
      tokens -= node.imageStructuralTokens;
      for (let occurrence = 0; occurrence < node.images.length; occurrence += 1) {
        const price = prices[cursor];
        cursor += 1;
        tokens += price.visualTokens + estimateContent([{ type: "text", text: price.text }]);
      }
    }
    surfaceTokens += tokens;
    return { seq: node.seq, tokens, heuristicTokens: node.heuristicTokens };
  });
  return { nodes: publicNodes, surfaceTokens };
}

// upstream/dsh-token-meter/src/index.js
function usageTokens(usage) {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens;
}
function optionalHeaderEquals(left, right) {
  if (left === void 0 || right === void 0)
    return left === right;
  return headerEquals(left, right);
}
function validateConfigKeys(config) {
  for (const key of Object.keys(config)) {
    throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`);
  }
}
var TokenMeter = class extends Service {
  static requestHeadAccountingVersion = 1;
  requestHeadAccountingVersion = 1;
  // Schemastery preserves untrusted loader keys on an empty object schema;
  // the public type excludes settings while validateConfigKeys rejects them.
  static Config = z3.object({});
  static inject = ["sessionProjections"];
  states = /* @__PURE__ */ new WeakMap();
  constructor(ctx, config = {}) {
    super(ctx, "tokenMeter");
    validateConfigKeys(config);
    ctx.sessionProjections.register(tokenUsageProjectionDefinition);
    ctx.sessionProjections.register(contextPressureProjectionDefinition);
    ctx.sessionProjections.register(contextBreakdownProjectionDefinition);
    ctx.on("session/event", (session) => {
      if (this.states.has(session))
        this._sync(session);
    });
  }
  /**
   * Measure current request pressure and surface through the durable tail.
   *
   * The effective envelope's routed provider/model selects the request-image
   * pricing every node is priced under: a route whose adapter declares image
   * pricing charges each retained image its visual tokens plus its
   * model-visible text, while other routes keep the fixed heuristic. Provider
   * usage is reused only when the latest successful call's canonical request
   * envelope matches `requestHeader` and its total is no lower than that
   * call's full route-priced anchor; otherwise the complete envelope and
   * surface are repriced. The anchor includes all surface nodes immediately
   * before the assistant message, including inputs admitted after step/start.
   *
   * `requestHeader` replaces the latest logged envelope for pressure and node
   * pricing; the node set always describes the current session surface. Every
   * call clones those positional nodes, so measurement is O(surface).
   *
   * @param session - session to replay through its current durable tail.
   * @param requestHeader - optional effective request envelope replacing the latest logged header.
   * @returns a detached deeply immutable pressure and surface measurement.
   */
  measure(session, requestHeader, options = {}) {
    const state = this._sync(session);
    const header = requestHeader === void 0 ? state.header : canonicalHeader2(requestHeader);
    const pricing = this._routeImagePricing(header);
    const fileText = this._fileRequestText();
    const surface = priceSurface(state.surface, pricing, fileText);
    const anchor = state.anchor;
    const requestContext = Object.hasOwn(options, "requestContext") ? options.requestContext : session.requestContext?.();
    const headMessages = requestContext?.requestHead?.messages ?? [];
    if (!Array.isArray(headMessages)) throw new TypeError("Invalid request head messages");
    const headTokens = headMessages.reduce((sum, message) => sum + estimateMessage(message), 0);
    let baseline;
    let surfaceDeltaTokens;
    if (anchor !== void 0 && optionalHeaderEquals(anchor.header, header)) {
      const anchorSurfaceTokens = priceSurface(anchor.nodes, pricing, fileText).surfaceTokens + anchor.assistantTokens;
      const estimatedAnchorTokens = estimateToolsTokens(header) + anchorSurfaceTokens;
      const usage = anchor.usage;
      baseline = usage !== void 0 && anchor.headKnown && usageTokens(usage) >= estimatedAnchorTokens + anchor.headTokens ? { kind: "usage", tokens: usageTokens(usage), usage } : { kind: "estimated", tokens: estimatedAnchorTokens };
      surfaceDeltaTokens = surface.surfaceTokens - anchorSurfaceTokens;
    } else if (header === void 0 && surface.surfaceTokens === 0) {
      baseline = { kind: "none", tokens: 0 };
      surfaceDeltaTokens = 0;
    } else {
      baseline = {
        kind: "estimated",
        tokens: estimateToolsTokens(header) + surface.surfaceTokens
      };
      surfaceDeltaTokens = 0;
    }
    const headDeltaTokens = baseline.kind === "usage" ? headTokens - anchor.headTokens : headTokens;
    return deepFreeze(structuredClone({
      logRevision: state.consumedEvents,
      baseline,
      surfaceDeltaTokens,
      totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens + headDeltaTokens),
      headTokens,
      headDeltaTokens,
      surfaceTokens: surface.surfaceTokens,
      nodes: surface.nodes
    }));
  }
  /** Resolve the routed model's image pricing, when the llm service and route declare one. */
  _routeImagePricing(header) {
    const config = header?.config;
    if (config === void 0)
      return void 0;
    return this.ctx.get("llm")?.imageRequestPricing(config.provider, config.model);
  }
  /** Resolve request-time file projection when an LLM service is mounted. */
  _fileRequestText() {
    const llm = this.ctx.get("llm");
    return llm === void 0 ? void 0 : (ref) => llm.fileRequestText(ref);
  }
  /**
   * Heuristically price one model-visible message (instance face of the pure
   * `estimateMessage` export from `estimate.ts`).
   * @param message - message to price without mutation.
   * @returns content and role-framing tokens under the fixed service heuristic.
   */
  estimateMessage(message) {
    return estimateMessage(message);
  }
  /** Catch one session's fold up to the current durable tail. */
  _sync(session) {
    let state = this.states.get(session);
    if (state === void 0) {
      state = {
        consumedEvents: SessionLogOffset(0),
        header: void 0,
        surface: [],
        stepStart: void 0,
        anchor: void 0,
        headKnown: false,
        headTokens: 0
      };
      this.states.set(session, state);
    }
    while (state.consumedEvents < session.seq) {
      const event = session.eventAt(SessionSeq4(state.consumedEvents));
      this._foldEvent(state, event);
      state.consumedEvents = SessionLogOffset(state.consumedEvents + 1);
    }
    return state;
  }
  /**
   * Run every fallible step — surface plan and anchor validation — before
   * mutating replay state, so a malformed event remains unread on every
   * retry instead of half-applying.
   */
  _foldEvent(state, event) {
    let nextHeader = state.header;
    let nextStepStart = state.stepStart;
    let nextAnchor = state.anchor;
    let nextHeadKnown = state.headKnown;
    let nextHeadTokens = state.headTokens;
    switch (event.type) {
      case "request/header":
        nextHeader = canonicalHeader2(event.data.header);
        break;
      case "request/context": {
        const messages = event.data.requestHead?.messages ?? [];
        if (!Array.isArray(messages)) throw new TypeError("Invalid request head messages");
        nextHeadTokens = messages.reduce((sum, message) => sum + estimateMessage(message), 0);
        nextHeadKnown = true;
        break;
      }
      case "step/start":
        if (state.stepStart !== void 0) {
          throw new Error(`token meter: step/start at seq ${event.seq} arrived before turn ${state.stepStart.turn}/step ${state.stepStart.step} ended`);
        }
        nextStepStart = { ...event.data };
        break;
      case "step/end":
        if (state.stepStart === void 0 || state.stepStart.turn !== event.data.turn || state.stepStart.step !== event.data.step) {
          throw new Error(`token meter: step/end at seq ${event.seq} has no matching step/start event`);
        }
        nextStepStart = void 0;
        break;
      default:
        break;
    }
    const plan = isSurfaceEvent3(event) ? planSurfaceTokens(state.surface, event) : void 0;
    if (event.type === "assistant/message") {
      const stepStart = state.stepStart;
      if (stepStart === void 0 || stepStart.turn !== event.data.turn || stepStart.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} has no matching step/start event`);
      }
      const eventTokens = plan.tokens;
      const pressureUsage = pressureUsageOf(event, event.data.usage);
      if (pressureUsage !== void 0 && Number.isSafeInteger(pressureUsage.outputTokens) && nextHeader !== void 0) {
        nextAnchor = {
          header: nextHeader,
          nodes: [...state.surface],
          assistantTokens: this._estimateProviderAssistant(event),
          usage: pressureUsage,
          headKnown: nextHeadKnown,
          headTokens: nextHeadTokens
        };
      } else {
        nextAnchor = {
          header: nextHeader,
          nodes: [...state.surface],
          assistantTokens: eventTokens,
          usage: void 0
        };
      }
    }
    state.header = nextHeader;
    state.headKnown = nextHeadKnown;
    state.headTokens = nextHeadTokens;
    state.stepStart = nextStepStart;
    if (plan !== void 0) {
      commitSurfaceTokens(state.surface, plan);
    }
    state.anchor = nextAnchor;
  }
  /**
   * Reassemble provider output from the message's exact embedded stream.
   */
  _estimateProviderAssistant(event) {
    const providerContent = assembleAssistantStream(event.data.stream).blocks();
    return providerContent.length === 0 ? 0 : estimateContent(providerContent) + ROLE_OVERHEAD;
  }
};
var index_default = TokenMeter;
export {
  TokenMeter,
  index_default as default
};
