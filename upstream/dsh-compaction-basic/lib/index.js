// src/index.ts
import z from "@deepseek-ai/schemastery";
import { CompactionEngine, ManualCompactionError as ManualCompactionError2 } from "@deepseek-ai/dsh-compaction";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { agentCarrier } from "@deepseek-ai/dsh-agent";

// src/config.ts
import { deepFreeze } from "@deepseek-ai/dsh-util-values";
var DEFAULT_THRESHOLD_RATIO = 0.8;
var DEFAULT_RETAIN_RATIO = 0.16;
var POLICY_CONFIG_KEYS = [
  "thresholdRatio",
  "retainRatio",
  "retainTokens",
  "summarizationProvider",
  "summarizationModel",
  "maxTokens",
  "compactionRetries",
  "maxOverflowRetries"
];
var BASIC_COMPACT_CONFIG_KEYS = /* @__PURE__ */ new Set([
  ...POLICY_CONFIG_KEYS,
  "modelPolicies",
  "auto"
]);
var MODEL_POLICY_KEYS = /* @__PURE__ */ new Set([
  "provider",
  "model",
  ...POLICY_CONFIG_KEYS
]);
var TargetPressureConfigError = class extends Error {
  /**
   * @param targetKey - exact provider/model route used as the warning key.
   * @param message - actionable configuration failure detail.
   */
  constructor(targetKey, message) {
    super(message);
    this.targetKey = targetKey;
  }
  targetKey;
};
function resolveConfig(config = {}) {
  validateKeys(config, BASIC_COMPACT_CONFIG_KEYS, "BasicCompactionConfig");
  validatePolicy(config, "BasicCompactionConfig");
  if (config.auto !== void 0 && typeof config.auto !== "boolean") {
    throw new Error("BasicCompactionConfig: auto must be a boolean");
  }
  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
  const retention = resolveRetention(config, { retainRatio: DEFAULT_RETAIN_RATIO });
  validateRatioRetention(thresholdRatio, retention, "BasicCompactionConfig");
  const modelPolicies = resolveModelPolicies(config.modelPolicies);
  for (const [index, policy] of modelPolicies.entries()) {
    validateRatioRetention(
      policy.thresholdRatio ?? thresholdRatio,
      resolveRetention(policy, retention),
      `BasicCompactionConfig: modelPolicies[${index}]`
    );
  }
  return deepFreeze({
    thresholdRatio,
    ...retention,
    summarizationProvider: config.summarizationProvider ?? "",
    summarizationModel: config.summarizationModel ?? "",
    maxTokens: config.maxTokens ?? 8192,
    compactionRetries: config.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 1,
    modelPolicies,
    auto: config.auto ?? true
  });
}
function resolveTargetPolicy(config, target) {
  const override = config.modelPolicies.find((policy) => policy.provider === target.provider && policy.model === target.model);
  const inheritedRetention = config.retainTokens === void 0 ? { retainRatio: config.retainRatio } : { retainTokens: config.retainTokens };
  return deepFreeze({
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    ...resolveRetention(override ?? {}, inheritedRetention),
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries
  });
}
function resolveCompactSpec(policy, contextWindow) {
  const targetKey = `${policy.target.provider}/${policy.target.model}`;
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`
    );
  }
  const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio);
  const retainTokens = policy.retainTokens === void 0 ? Math.floor(contextWindow * policy.retainRatio) : policy.retainTokens;
  if (retainTokens >= thresholdTokens) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: ${policy.target.provider}/${policy.target.model} retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`
    );
  }
  return deepFreeze({
    target: { ...policy.target },
    contextWindow,
    thresholdRatio: policy.thresholdRatio,
    thresholdTokens,
    retainTokens,
    summarizationProvider: policy.summarizationProvider,
    summarizationModel: policy.summarizationModel,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries
  });
}
function resolveRetention(config, fallback) {
  if (config.retainTokens !== void 0) return { retainTokens: config.retainTokens };
  if (config.retainRatio !== void 0) return { retainRatio: config.retainRatio };
  return fallback;
}
function validateRatioRetention(thresholdRatio, retention, name) {
  if (retention.retainRatio !== void 0 && retention.retainRatio >= thresholdRatio) {
    throw new Error(
      `${name}: retainRatio (${retention.retainRatio}) must be less than the resolved thresholdRatio (${thresholdRatio})`
    );
  }
}
function resolveModelPolicies(configured) {
  if (configured === void 0) return [];
  if (!Array.isArray(configured)) {
    throw new Error("BasicCompactionConfig: modelPolicies must be an array");
  }
  const seen = /* @__PURE__ */ new Set();
  return configured.map((source, index) => {
    const name = `BasicCompactionConfig: modelPolicies[${index}]`;
    assertModelPolicy(source, name);
    const key = `${source.provider}\0${source.model}`;
    if (seen.has(key)) {
      throw new Error(
        `BasicCompactionConfig: duplicate model policy for ${source.provider}/${source.model}`
      );
    }
    seen.add(key);
    return { ...source };
  });
}
function assertModelPolicy(source, name) {
  if (!isUnknownRecord(source)) throw new Error(`${name} must be an object`);
  validateKeys(source, MODEL_POLICY_KEYS, name);
  assertNonEmptyString(`${name}.provider`, source.provider);
  assertNonEmptyString(`${name}.model`, source.model);
  validatePolicy(source, name);
}
function validatePolicy(config, name) {
  const thresholdRatio = config.thresholdRatio;
  const retainRatio = config.retainRatio;
  const retainTokens = config.retainTokens;
  const maxTokens = config.maxTokens;
  const compactionRetries = config.compactionRetries;
  const maxOverflowRetries = config.maxOverflowRetries;
  if (thresholdRatio !== void 0) assertRatio(`${name}.thresholdRatio`, thresholdRatio);
  if (retainRatio !== void 0) assertRatio(`${name}.retainRatio`, retainRatio);
  if (retainTokens !== void 0) assertNonNegativeInteger(`${name}.retainTokens`, retainTokens);
  if (retainRatio !== void 0 && retainTokens !== void 0) {
    throw new Error(`${name}: retainRatio and retainTokens are mutually exclusive`);
  }
  if (maxTokens !== void 0) assertPositiveInteger(`${name}.maxTokens`, maxTokens);
  if (compactionRetries !== void 0) {
    assertNonNegativeInteger(`${name}.compactionRetries`, compactionRetries);
  }
  if (maxOverflowRetries !== void 0) {
    assertNonNegativeInteger(`${name}.maxOverflowRetries`, maxOverflowRetries);
  }
  validateSummarizationPair(config, name);
}
function validateSummarizationPair(config, name) {
  const provider = config.summarizationProvider;
  const model = config.summarizationModel;
  if (provider !== void 0 && typeof provider !== "string") {
    throw new Error(`${name}.summarizationProvider must be a string`);
  }
  if (model !== void 0 && typeof model !== "string") {
    throw new Error(`${name}.summarizationModel must be a string`);
  }
  if (provider === void 0 && model === void 0) return;
  if (provider === void 0 || model === void 0 || provider.length === 0 !== (model.length === 0)) {
    throw new Error(
      `${name}: summarizationProvider and summarizationModel must be set together as an empty or non-empty pair`
    );
  }
}
function validateKeys(config, keys, name) {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`);
  }
}
function isUnknownRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertNonEmptyString(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}
function assertPositiveInteger(name, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`);
  }
}
function assertNonNegativeInteger(name, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} (${String(value)}) must be a non-negative integer`);
  }
}
function assertRatio(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`);
  }
}

// src/region.ts
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore
} from "@deepseek-ai/dsh-compaction";
import { createUserMessage as createUserMessage2, errorChain } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";

// src/summarizer.ts
import { contentHasImage, createUserMessage, BlockAssembler, LlmError } from "@deepseek-ai/dsh-llm";
var SUMMARY_OPEN_TAG = "<compacted-summary>";
var SUMMARY_CLOSE_TAG = "</compacted-summary>";
var COMPACTION_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
  "",
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section \u2014 never drop a section.',
  "",
  "## Primary Request and Intent",
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  "",
  "## Key Technical Concepts",
  "- [technologies, frameworks, patterns, and conventions in play]",
  "",
  "## Files and Code",
  "- [exact path: why it matters, key changes or snippets]",
  "",
  "## Errors and Fixes",
  "- [error: how it was resolved, plus any related user feedback]",
  "",
  "## Pending Jobs",
  "- [explicitly requested work not yet completed]",
  "",
  "## Current Work",
  "- [precisely what was in progress at this checkpoint]",
  "",
  "## Next Step",
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  "",
  "## Critical Context",
  "- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
  "",
  "Rules:",
  "- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Capture user feedback and explicit instructions faithfully, especially corrections.",
  "- Do NOT mention this summarization request or that the context was compacted.",
  "- Output only the checkpoint text: do not call any tool or take any other action.",
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`
].join("\n");
var CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";
async function summarizeWithLlm(ctx, config, input, agent, signal, targetOverride, summaryInstruction, effectiveHeader) {
  const latest = effectiveHeader === void 0 ? agent.session.requestHeader()?.config : effectiveHeader.config;
  const configured = config.summarizationProvider.length === 0 ? void 0 : { provider: config.summarizationProvider, model: config.summarizationModel };
  const agentTarget = agent.options.provider !== void 0 && agent.options.provider.length > 0 && agent.options.model !== void 0 && agent.options.model.length > 0 ? { provider: agent.options.provider, model: agent.options.model } : void 0;
  const target = configured ?? targetOverride ?? latest ?? agentTarget;
  if (target === void 0) {
    throw new Error(
      "no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields"
    );
  }
  if (targetOverride && configured && (configured.provider !== targetOverride.provider || configured.model !== targetOverride.model)) {
    throw Object.assign(new Error("A distinct summarizer route requires an explicitly validated effort policy"), { code: "FUSION_SUMMARIZER_POLICY_REQUIRED" });
  }
  const reasoningEffort = latest?.provider === target.provider && latest.model === target.model ? latest.reasoningEffort : void 0;
  const assembler = new BlockAssembler();
  const instruction = summaryInstruction === void 0 ? COMPACTION_INSTRUCTION : `${COMPACTION_INSTRUCTION.replace("- Write concise English engineering prose.", "- Use the original language of each topic where possible.")}

${summaryInstruction}`;
  const messages = [
    ...input.messages,
    createUserMessage({
      content: [{ type: "text", text: instruction }],
      source: { kind: "plugin", plugin: "dsh-compaction-basic" }
    })
  ];
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.tools === void 0 ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    ...reasoningEffort === void 0 ? {} : { reasoningEffort },
    sessionId: agent.session.id,
    purpose: "compaction",
    ...signal === void 0 ? {} : { signal }
  };
  let called = false;
  try {
    signal?.throwIfAborted();
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type !== "finish" || !["error", "aborted"].includes(chunk.reason.kind) || chunk.replayState !== void 0) called = true;
      assembler.push(chunk);
    }
    const error = finishError(assembler.finish);
    if (error !== void 0) throw error;
    const rawOutput = assembler.blocks();
    const summary = summaryText(rawOutput);
    if (!summary.some((block) => block.text.trim().length > 0)) {
      throw new Error("summarization produced no text summary content");
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens: config.maxTokens,
      ...assembler.usage === void 0 ? {} : { usage: assembler.usage },
      ...assembler.replayState === void 0 ? {} : { replayState: assembler.replayState }
    };
  } catch (error) {
    const replay = assembler.replayState;
    const attempts = replay?.response?.attempts;
    const evidenced = Array.isArray(attempts) ? attempts.length > 0 : called;
    if (error instanceof Error) Object.assign(error, { compactionCall: {
      ...evidenced ? { llmStreamCall: true } : { llmStreamCoverage: Array.isArray(attempts) ? "not-dispatched" : "unknown" },
      provider: options.provider,
      model: options.model,
      ...assembler.usage === void 0 ? {} : { usage: assembler.usage },
      ...assembler.replayState === void 0 ? {} : { replayState: assembler.replayState }
    } });
    throw error;
  }
}
function frameSummary(summary) {
  return [
    { type: "text", text: `${CHECKPOINT_PREAMBLE}

${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: "text", text: SUMMARY_CLOSE_TAG }
  ];
}
function finishError(finish) {
  switch (finish.kind) {
    case "error":
    case "aborted": {
      const error = new Error(finish.failure.message);
      error.code = finish.failure.code;
      return error;
    }
    case "max-tokens": {
      const error = new Error("summarization truncated at the token cap (incomplete checkpoint)");
      error.code = "MAX_TOKENS";
      return error;
    }
    default:
      return void 0;
  }
}
function summaryText(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError("compaction summary cannot contain image output", "UNSUPPORTED_CONTENT");
  }
  return blocks.filter((block) => block.type === "text");
}

// src/region.ts
var SurfaceChangedError = class extends Error {
};
function systemHead(session, headSeq) {
  const head = session.eventAt(headSeq);
  return head.type === "system/message" ? head : void 0;
}
function selectCompactableRange(session, measurement, retainTokens, protectedNativeSeqs = []) {
  const pricedNodes = measurement.nodes;
  if (pricedNodes.length === 0) return null;
  const surfaceNodes = session.surface.nodes;
  if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error("compaction: token-meter surface does not match the current session surface");
  }
  const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;
  let accumulated = 0;
  let keepFromIdx = pricedNodes.length;
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens;
    keepFromIdx = index;
    if (accumulated >= retainTokens) break;
  }
  const protectedSet = new Set(protectedNativeSeqs);
  const protectedIndex = surfaceNodes.findIndex((seq) => protectedSet.has(seq));
  if (protectedIndex >= 0) keepFromIdx = Math.min(keepFromIdx, protectedIndex);
  if (keepFromIdx <= firstIdx) return null;
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
    keepFromIdx -= 1;
  }
  if (keepFromIdx <= firstIdx) return null;
  const first = surfaceNodes[firstIdx];
  const cutoff = surfaceNodes[keepFromIdx - 1];
  return { start: first, end: cutoff };
}
async function compactSurfaceRegion(dependencies, session, start, end, agent, options, signal) {
  if (options.owner === null) signal?.throwIfAborted();
  const selection = validateSurfaceRegion(session, start, end);
  const entryState = inspectCompactionEntryState(session);
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    "compaction"
  );
  let owner;
  if (options.owner === null) {
    if (entryState.openTurn !== null) {
      throw new ManualCompactionError("busy", "manual compaction: the session already has an open turn");
    }
    owner = null;
  } else {
    if (entryState.openTurn === null) {
      throw new Error("compactRegion: no open turn \u2014 automatic compaction events must be enclosed in a turn");
    }
    owner = entryState.openTurn;
  }
  const compactionId = CompactionId(randomUUID());
  const lifecycle = {
    compactionId,
    ...options.sourceCommandId === void 0 ? {} : { sourceCommandId: options.sourceCommandId },
    turn: owner
  };
  const startEvent = session.append("compaction/start", lifecycle);
  const assertStable = options.stability === "whole-surface" ? assertWholeSurfaceUnchanged : assertSelectedSpanStable;
  let failure;
  let flushFailure;
  let result;
  let completedSummary;
  let closed = false;
  let closing = false;
  let stage = "summary";
  try {
    const prepared = prepareCompaction(dependencies, session, selection);
    const summarized = await summarizeCompaction(
      dependencies,
      prepared,
      agent,
      compactionId,
      options.sourceCommandId,
      signal
    );
    completedSummary = summarized;
    if (options.owner === null) signal?.throwIfAborted();
    assertStable(dependencies, session, summarized);
    if (dependencies.guardPlan) {
      const visibleSeqs = summarized.measurement.nodes.map((node) => node.seq);
      const shadowed = new Set(summarized.shadowedSeqs);
      const permit = await dependencies.guardPlan({
        sessionId: session.id,
        compactionId,
        start: summarized.start,
        end: summarized.end,
        shadowedSeqs: [...summarized.shadowedSeqs],
        retainedSeqs: visibleSeqs.filter((seq) => !shadowed.has(seq)),
        visibleSeqs: [...visibleSeqs],
        surfaceGeneration: session.surface.replaceGeneration,
        summary: structuredClone(summarized.summary),
        checkpointMessage: structuredClone(summarized.checkpointMessage)
      });
      if (permit?.allow !== true || typeof permit.revalidate !== "function") throw Object.assign(new Error("Compaction plan was not authorized"), { code: "FUSION_COMPACTION_PLAN_REJECTED" });
      signal?.throwIfAborted();
      assertStable(dependencies, session, summarized);
      if (permit.revalidate() !== true) throw Object.assign(new Error("Protected inputs changed before compaction commit"), { code: "FUSION_COMPACTION_INPUT_CHANGED" });
    }
    stage = "commit";
    const pending = commitCompactionBody(session, startEvent, summarized);
    closing = true;
    const endEvent = session.append("compaction/end", lifecycle);
    closed = true;
    result = completeCompaction(pending, endEvent);
  } catch (error) {
    failure = { error, stage: closing ? "commit" : stage };
    if (!closing) {
      closing = true;
      try {
        const call = completedSummary?.llmStreamCall === true ? completedSummary : error?.compactionCall;
        session.append("compaction/end", {
          ...lifecycle,
          error: errorChain(error),
          ...call?.llmStreamCall === true || call?.llmStreamCoverage ? {
            ...call.llmStreamCall === true ? { llmStreamCall: true } : { llmStreamCoverage: call.llmStreamCoverage },
            provider: call.provider,
            model: call.model,
            ...call.usage === void 0 ? {} : { usage: call.usage },
            ...call.replayState === void 0 ? {} : { replayState: call.replayState }
          } : {}
        });
        closed = true;
      } catch (closeError) {
        failure = { error: closeError, stage: "commit" };
      }
    }
  }
  if (closed && options.flush !== void 0) {
    try {
      await options.flush();
    } catch (error) {
      flushFailure = error;
    }
  }
  if (options.owner === null) signal?.throwIfAborted();
  if (failure !== void 0) {
    if (options.owner === null) throwManualFailure(failure);
    throw failure.error;
  }
  if (flushFailure !== void 0) {
    throw new ManualCompactionError(
      "persistence",
      "manual compaction durability checkpoint failed",
      { cause: flushFailure }
    );
  }
  if (result === void 0) throw new Error("compaction committed without a result");
  return result;
}
function throwManualFailure(failure) {
  if (failure.stage === "commit") {
    throw new ManualCompactionError(
      "commit",
      "manual compaction did not commit cleanly",
      { cause: failure.error }
    );
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError(
      "changed",
      "the compacted history changed during manual compaction",
      { cause: failure.error }
    );
  }
  throw new ManualCompactionError(
    "summary",
    "manual compaction could not produce a smaller summary",
    { cause: failure.error }
  );
}
function assertCompactionInactive(unmatchedCompactionStart, latestEndSeedSeq, stage) {
  if (unmatchedCompactionStart === void 0 || latestEndSeedSeq !== void 0 && latestEndSeedSeq > unmatchedCompactionStart.seq) return;
  throw new ManualCompactionError(
    "busy",
    `${stage}: compaction already in progress; the session compaction lock is already active`
  );
}
function assertNoActiveCompaction(session, stage) {
  const entryState = inspectCompactionEntryState(session);
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    stage
  );
}
function validateSurfaceRegion(session, start, end) {
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`);
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`);
  if (startIdx > endIdx) {
    throw new Error(
      `compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`
    );
  }
  if (!toolPairingBalancedBefore(session, nodes[startIdx])) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`);
  }
  if (!toolPairingBalancedAfter(session, nodes[endIdx])) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`);
  }
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) };
}
function prepareCompaction(dependencies, session, selection) {
  const measurement = dependencies.meter.measure(session, dependencies.requestHeader, dependencies.requestContext === void 0 ? void 0 : { requestContext: dependencies.requestContext });
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1);
  if (selectedNodes.length !== selection.shadowedSeqs.length || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new SurfaceChangedError("compaction: selected surface changed before summarization began");
  }
  return {
    ...selection,
    measurement,
    selectedNodes,
    // The shadow-price protocol prices replacements with the fixed heuristic
    // so the O(1) projection fold stays in agreement with its own appends;
    // retention, range selection, and the shrink comparison read the
    // route-priced `tokens` instead.
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    input: buildSummarizationInput(session, selection.shadowedSeqs, dependencies.requestHeader)
  };
}
async function summarizeCompaction(dependencies, prepared, agent, compactionId, sourceCommandId, signal) {
  const summaryResult = await dependencies.summarize(prepared.input, agent, signal);
  const checkpointMessage = createUserMessage2({
    content: frameSummary(summaryResult.summary),
    source: compactCheckpointSource(compactionId, sourceCommandId)
  });
  const framedSummaryTokenCount = dependencies.meter.estimateMessage(checkpointMessage);
  if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) {
    const error = new Error(
      `summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`
    );
    if (summaryResult.llmStreamCall === true) Object.assign(error, { compactionCall: summaryResult });
    throw error;
  }
  return {
    ...prepared,
    ...summaryResult,
    checkpointMessage
  };
}
function assertWholeSurfaceUnchanged(dependencies, session, prepared) {
  const current = dependencies.meter.measure(session, dependencies.requestHeader, dependencies.requestContext === void 0 ? void 0 : { requestContext: dependencies.requestContext });
  if (!isDeepStrictEqual(current.nodes, prepared.measurement.nodes)) {
    throw new SurfaceChangedError("compaction: session surface changed during summarization");
  }
}
function assertSelectedSpanStable(dependencies, session, prepared) {
  let current;
  try {
    current = validateSurfaceRegion(session, prepared.start, prepared.end);
  } catch (error) {
    throw new SurfaceChangedError(
      "compaction: the selected span is no longer a valid replacement target",
      { cause: error }
    );
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) {
    throw new SurfaceChangedError("compaction: the selected span changed during summarization");
  }
  const measured = dependencies.meter.measure(session, dependencies.requestHeader, dependencies.requestContext === void 0 ? void 0 : { requestContext: dependencies.requestContext }).nodes.slice(current.startIdx, current.endIdx + 1);
  if (!isDeepStrictEqual(measured, prepared.selectedNodes)) {
    throw new SurfaceChangedError("compaction: the selected span was rewritten during summarization");
  }
}
function commitCompactionBody(session, startEvent, summarized) {
  const {
    start,
    end,
    shadowedSeqs,
    shadowedTokenCount,
    summary,
    provider,
    model,
    maxTokens,
    usage,
    replayState,
    checkpointMessage
  } = summarized;
  const callProvenance = summarized.llmStreamCall === true ? { rawOutput: summarized.rawOutput, llmStreamCall: true } : summarized.rawOutput === void 0 ? {} : { rawOutput: summarized.rawOutput };
  const summaryEvent = session.append("compaction/summary", {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === void 0 ? {} : { sourceCommandId: startEvent.data.sourceCommandId },
    summary,
    ...callProvenance,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider,
    model,
    ...maxTokens === void 0 ? {} : { maxTokens },
    ...usage === void 0 ? {} : { usage },
    ...replayState === void 0 ? {} : { replayState }
  });
  session.append("user/message", checkpointMessage, {
    surfaceOp: { op: "replace", startSeq: start, endSeq: end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs]
  });
  return {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === void 0 ? {} : { sourceCommandId: startEvent.data.sourceCommandId },
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount
  };
}
function completeCompaction(pending, endEvent) {
  return { ...pending, endSeq: endEvent.seq };
}
function buildSummarizationInput(session, shadowedSeqs, requestHeader) {
  const header = requestHeader ?? session.requestHeader();
  const head = systemHead(session, session.surface.nodes[0]);
  const system = head === void 0 ? null : session.deriveEventMessage(head);
  const regionMessages = shadowedSeqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter((message) => message !== null);
  return {
    ...header?.tools === void 0 ? {} : { tools: header.tools },
    messages: system === null ? regionMessages : [system, ...regionMessages]
  };
}
function inspectCompactionEntryState(session) {
  let openTurn = null;
  let openTurnStateKnown = false;
  let unmatchedCompactionStart;
  let compactionEntryStateKnown = false;
  let latestEndSeedSeq;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (latestEndSeedSeq === void 0 && event.type === "session/end-seed") {
      latestEndSeedSeq = event.seq;
    }
    if (!compactionEntryStateKnown) {
      if (event.type === "compaction/start") {
        unmatchedCompactionStart = event;
        compactionEntryStateKnown = true;
      } else if (event.type === "compaction/end") {
        compactionEntryStateKnown = true;
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === "turn/start") {
        openTurn = event.data.turn;
        openTurnStateKnown = true;
      } else if (event.type === "turn/end") {
        openTurnStateKnown = true;
      }
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== void 0) break;
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq };
}

// src/fusion-guard.ts
var coordinators = /* @__PURE__ */ new WeakMap();
var activeGuards = /* @__PURE__ */ new WeakMap();
function hasFusionCompactionCoordinator(session) {
  return coordinators.has(session);
}
function registerFusionCompactionCoordinator(session, policy) {
  if (!session || typeof policy?.interceptCompaction !== "function") throw new TypeError("Invalid compaction coordinator");
  if (coordinators.has(session)) throw new Error("A compaction coordinator is already registered for this session");
  const registration = { policy, pending: /* @__PURE__ */ new Set(), closing: false };
  coordinators.set(session, registration);
  return async () => {
    registration.closing = true;
    await Promise.allSettled([...registration.pending]);
    if (coordinators.get(session) === registration) coordinators.delete(session);
  };
}
function fusionGuardFor(session) {
  const active = activeGuards.get(session);
  if (!active && coordinators.has(session)) {
    throw Object.assign(new Error("Coordinated session requires a compaction plan guard"), { code: "FUSION_COMPACTION_GUARD_REQUIRED" });
  }
  return active?.guard;
}
function fusionAdditionalTokensFor(session) {
  return activeGuards.get(session)?.additionalTokens ?? 0;
}
function fusionTargetFor(session) {
  return activeGuards.get(session)?.target;
}
function fusionThresholdFor(session) {
  return activeGuards.get(session)?.thresholdTokens;
}
function fusionHeaderFor(session) {
  return activeGuards.get(session)?.requestHeader;
}
function fusionContextFor(session) {
  return activeGuards.get(session)?.requestContext;
}
function fusionSummaryInstructionFor(session) {
  return activeGuards.get(session)?.summaryInstruction;
}
function fusionProtectedFor(session) {
  return activeGuards.get(session)?.protectedNativeSeqs ?? [];
}
async function routeFusionCompaction(agent, trigger, boundary, signal, sourceCommandId, run, requestPreview) {
  const session = agent.session;
  const registration = coordinators.get(session);
  if (!registration) return run();
  if (registration.closing) throw Object.assign(new Error("Compaction coordinator is closing"), { code: "FUSION_COMPACTION_CLOSING" });
  let called = false;
  let nativeTask;
  const operation = Promise.resolve().then(async () => {
    try {
      return await registration.policy.interceptCompaction({
        agent,
        trigger,
        boundary,
        signal,
        ...sourceCommandId === void 0 ? {} : { sourceCommandId },
        ...requestPreview ? { requestPreview } : {},
        runNative: (guard, options) => {
          const task = (async () => {
            if (called) throw new Error("A native compaction invocation may run only once");
            if (typeof guard !== "function") throw Object.assign(new Error("A compaction plan guard is required"), { code: "FUSION_COMPACTION_GUARD_REQUIRED" });
            if (activeGuards.has(session)) throw Object.assign(new Error("A compaction is already active for this session"), { code: "FUSION_COMPACTION_BUSY" });
            const additionalTokens = options?.additionalTokens ?? 0;
            if (!Number.isSafeInteger(additionalTokens) || additionalTokens < 0) throw new TypeError("Invalid additional request token estimate");
            const thresholdTokens = options?.thresholdTokens;
            if (thresholdTokens !== void 0 && (!Number.isSafeInteger(thresholdTokens) || thresholdTokens < 1)) throw new TypeError("Invalid compaction threshold");
            const target = options?.target;
            if (target !== void 0 && (typeof target.provider !== "string" || !target.provider || typeof target.model !== "string" || !target.model)) throw new TypeError("Invalid request target");
            const protectedNativeSeqs = options?.protectedNativeSeqs;
            if (protectedNativeSeqs !== void 0 && (!Array.isArray(protectedNativeSeqs) || protectedNativeSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 0))) throw new TypeError("Invalid protected native sequences");
            if (options?.summaryInstruction !== void 0 && typeof options.summaryInstruction !== "string") throw new TypeError("Invalid summary instruction");
            called = true;
            const active = {
              guard,
              additionalTokens,
              ...thresholdTokens === void 0 ? {} : { thresholdTokens },
              ...options?.requestHeader === void 0 ? {} : { requestHeader: options.requestHeader },
              ...target ? { target: { ...target } } : {},
              ...options?.requestContext === void 0 ? {} : { requestContext: options.requestContext },
              ...options?.summaryInstruction === void 0 ? {} : { summaryInstruction: options.summaryInstruction },
              ...protectedNativeSeqs === void 0 ? {} : { protectedNativeSeqs: [...protectedNativeSeqs] }
            };
            activeGuards.set(session, active);
            try {
              return await run();
            } finally {
              if (activeGuards.get(session) === active) activeGuards.delete(session);
            }
          })();
          if (called && !nativeTask) nativeTask = task;
          return task;
        }
      });
    } finally {
      if (nativeTask) await nativeTask.catch(() => {
      });
    }
  });
  registration.pending.add(operation);
  try {
    return await operation;
  } finally {
    registration.pending.delete(operation);
  }
}

// src/index.ts
async function resolveFusionCompactionEngine(agent, ctx = agent.ctx) {
  const found = /* @__PURE__ */ new Set();
  await ctx.parallel(agentCarrier(agent), "agent/compaction-resolve", { agent, register: (engine) => found.add(engine) });
  if (found.size !== 1) throw Object.assign(new Error(`Expected one scoped compaction engine, found ${found.size}`), { code: "CONTEXT_ENGINE_RESOLUTION_FAILED" });
  return [...found][0];
}
function routedTarget(session) {
  const config = session.requestHeader()?.config;
  if (config === void 0 || config.provider.length === 0 || config.model.length === 0) {
    return void 0;
  }
  return { provider: config.provider, model: config.model };
}
function conversationTarget(agent) {
  const routed = routedTarget(agent.session);
  if (routed !== void 0) return routed;
  if (agent.options.provider === void 0 || agent.options.provider.length === 0 || agent.options.model === void 0 || agent.options.model.length === 0) return void 0;
  return { provider: agent.options.provider, model: agent.options.model };
}
var thresholdRatioSchema = z.number();
var retainRatioSchema = z.number();
var retainTokensSchema = z.number().step(1).min(0);
var summarizationProviderSchema = z.string();
var summarizationModelSchema = z.string();
var maxTokensSchema = z.number().step(1).min(1);
var compactionRetriesSchema = z.number().step(1).min(0);
var maxOverflowRetriesSchema = z.number().step(1).min(0);
var modelPolicy = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema
});
var BasicCompactionEngine = class extends CompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];
  static Config = z.object({
    thresholdRatio: thresholdRatioSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean()
  });
  /** Resolved and validated compaction configuration. */
  config;
  warnedPressureConfigTargets = /* @__PURE__ */ new Set();
  overflowRetries = /* @__PURE__ */ new WeakMap();
  overflowAgents = /* @__PURE__ */ new WeakMap();
  constructor(ctx, config = {}) {
    super(ctx);
    ctx.on("agent/compaction-resolve", ({ register }) => {
      register(this);
    });
    this.config = resolveConfig(config);
    if (this.config.auto) this._registerAutomaticCompaction();
  }
  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  _registerAutomaticCompaction() {
    const { ctx } = this;
    const logResult = (result, trigger) => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`
      );
    };
    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      if (hasFusionCompactionCoordinator(agent.session)) {
        return next();
      }
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, "pressure", signal);
          if (result !== null) logResult(result, "step pressure");
        } catch (error) {
          if (hasFusionCompactionCoordinator(agent.session)) throw error;
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next();
            this.warnedPressureConfigTargets.add(error.targetKey);
          }
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`);
        }
      }
      return next();
    });
    ctx.on("agent/status", ({ agent, status }) => {
      if (status === "idle") this.overflowRetries.delete(agent);
    });
    ctx.on("session/event", (session, event) => {
      if (event.type !== "assistant/message") return;
      const agent = this.overflowAgents.get(session);
      if (agent !== void 0) this.overflowRetries.delete(agent);
    });
    ctx.on("agent/request-error", async ({ agent, turn, step, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
      this.overflowAgents.set(agent.session, agent);
      const target = routedTarget(agent.session);
      if (target === void 0) return next();
      const policy = resolveTargetPolicy(this.config, target);
      const retries = this.overflowRetries.get(agent) ?? 0;
      if (retries >= policy.maxOverflowRetries) return next();
      const generation = agent.session.surface.replaceGeneration;
      let result;
      try {
        result = await this.compactIfNeeded(
          agent,
          "context-overflow",
          signal,
          { overflowPosition: { turn, step } }
        );
      } catch (recoveryError) {
        if (hasFusionCompactionCoordinator(agent.session)) throw recoveryError;
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`
          );
          this.overflowRetries.set(agent, retries + 1);
          return { kind: "retry" };
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted ? "cancellation prevents retry" : "preserving the original request error"}`
        );
        return next();
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
      if (result !== null) logResult(result, "context overflow recovery");
      this.overflowRetries.set(agent, retries + 1);
      return { kind: "retry" };
    });
  }
  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  async summarize(input, agent, signal) {
    const target = fusionTargetFor(agent.session) ?? conversationTarget(agent);
    const config = target === void 0 ? this.config : resolveTargetPolicy(this.config, target);
    return summarizeWithLlm(
      this.ctx,
      config,
      input,
      agent,
      signal,
      fusionTargetFor(agent.session),
      fusionSummaryInstructionFor(agent.session),
      fusionHeaderFor(agent.session)
    );
  }
  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  async compactIfNeeded(agent, trigger, signal, requestPreview) {
    return routeFusionCompaction(
      agent,
      trigger,
      "open-turn",
      signal,
      void 0,
      () => this.compactIfNeededNative(agent, trigger, signal),
      requestPreview
    );
  }
  /** Read-only preflight for a coordinator; it must not generate a checkpoint. */
  async inspectFusionPressure(agent, additionalTokens, signal, targetOverride, budget = { outputReserveTokens: 0 }) {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(additionalTokens) || additionalTokens < 0) throw new TypeError("Invalid additional request token estimate");
    const target = targetOverride ?? routedTarget(agent.session);
    if (target === void 0) throw Object.assign(new Error("No routed target for coordinated compaction"), { code: "FUSION_COMPACTION_TARGET_UNKNOWN" });
    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;
    if (context === void 0) throw new TargetPressureConfigError(`${target.provider}/${target.model}`, "Context window is unknown");
    const policy = resolveTargetPolicy(this.config, target);
    const spec = resolveCompactSpec(policy, context.contextWindow);
    if (!Number.isSafeInteger(budget.outputReserveTokens) || budget.outputReserveTokens < 0 || budget.outputReserveTokens >= context.contextWindow)
      throw Object.assign(new Error("Output reservation exceeds or does not identify the model window"), { code: "FUSION_COMPACTION_BUDGET_INVALID" });
    if (budget.stageBudgetTokens !== void 0 && (!Number.isSafeInteger(budget.stageBudgetTokens) || budget.stageBudgetTokens < 1))
      throw new TypeError("Invalid stage budget");
    if (budget.thresholdRatio !== void 0 && (!Number.isFinite(budget.thresholdRatio) || budget.thresholdRatio <= 0 || budget.thresholdRatio > 1))
      throw new TypeError("Invalid stage threshold ratio");
    const stage = budget.stageBudgetTokens === void 0 ? Infinity : Math.floor(budget.stageBudgetTokens * (budget.thresholdRatio ?? policy.thresholdRatio));
    const thresholdTokens = Math.min(spec.thresholdTokens, context.contextWindow - budget.outputReserveTokens, stage);
    if (thresholdTokens < 1) throw Object.assign(new Error("No usable input budget remains"), { code: "FUSION_COMPACTION_BUDGET_INVALID" });
    const totalTokens = this.ctx.tokenMeter.measure(
      agent.session,
      budget.requestHeader,
      budget.requestContext === void 0 ? void 0 : { requestContext: budget.requestContext }
    ).totalTokens + additionalTokens;
    return { needed: totalTokens >= thresholdTokens, totalTokens, thresholdTokens, contextWindow: context.contextWindow };
  }
  async compactIfNeededNative(agent, trigger, signal) {
    const coordinated = !!fusionGuardFor(agent.session);
    const target = fusionTargetFor(agent.session) ?? routedTarget(agent.session);
    if (target === void 0) {
      if (coordinated) throw Object.assign(new Error("No routed target for coordinated compaction"), { code: "FUSION_COMPACTION_TARGET_UNKNOWN" });
      return null;
    }
    const policy = resolveTargetPolicy(this.config, target);
    const meter = this.ctx.tokenMeter;
    const requestHeader = fusionHeaderFor(agent.session);
    const requestContext = fusionContextFor(agent.session);
    const meterOptions = requestContext === void 0 ? void 0 : { requestContext };
    let measurement = meter.measure(agent.session, requestHeader, meterOptions);
    switch (trigger) {
      case "context-overflow":
        break;
      case "pressure":
        break;
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, "compaction trigger");
    }
    const prune = fusionGuardFor(agent.session) ? void 0 : this.ctx.get("toolResultPruner");
    if (trigger === "context-overflow") {
      if (prune !== void 0) {
        prune.pruneSession(agent.session);
        measurement = meter.measure(agent.session, requestHeader, meterOptions);
      }
      const range = selectCompactableRange(agent.session, measurement, 0, fusionProtectedFor(agent.session));
      if (range === null) {
        if (coordinated) throw Object.assign(new Error("No safe range for overflow compaction"), { code: "FUSION_COMPACTION_NO_SAFE_RANGE" });
        return null;
      }
      return this.compactRegion(range.start, range.end, agent, signal);
    }
    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;
    assertNoActiveCompaction(agent.session, "automatic pressure compaction");
    const targetKey = `${target.provider}/${target.model}`;
    if (context === void 0) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; configure contextWindow on that adapter model`
      );
    }
    const spec = resolveCompactSpec(policy, context.contextWindow);
    const additionalTokens = fusionAdditionalTokensFor(agent.session);
    const thresholdTokens = fusionThresholdFor(agent.session) ?? spec.thresholdTokens;
    const retainTokens = coordinated ? Math.min(spec.retainTokens, Math.floor(spec.retainTokens * thresholdTokens / spec.thresholdTokens)) : spec.retainTokens;
    if (measurement.totalTokens + additionalTokens < thresholdTokens) return null;
    if (prune !== void 0) {
      prune.pruneSession(agent.session);
      measurement = meter.measure(agent.session, requestHeader, meterOptions);
    }
    if (measurement.totalTokens + additionalTokens < thresholdTokens) return null;
    let result = null;
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, retainTokens, fusionProtectedFor(agent.session));
      if (range === null) {
        if (result === null) {
          if (coordinated) throw Object.assign(new Error("No safe range for pressure compaction"), { code: "FUSION_COMPACTION_NO_SAFE_RANGE" });
          return null;
        }
        break;
      }
      result = await this.compactRegion(range.start, range.end, agent, signal);
      measurement = meter.measure(agent.session, requestHeader, meterOptions);
      if (coordinated) return result;
      if (measurement.totalTokens + additionalTokens < thresholdTokens) return result;
    }
    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`
    );
  }
  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  async compactRegion(start, end, agent, signal) {
    const guard = fusionGuardFor(agent.session);
    return compactSurfaceRegion(
      this.regionDependencies(agent),
      agent.session,
      start,
      end,
      agent,
      {
        owner: "current-turn",
        stability: "whole-surface",
        ...guard ? { flush: async () => {
          if (!await this.ctx.sessions.flush(agent.session)) throw new Error("Coordinated compaction persistence is unconfirmed");
        } } : {}
      },
      signal
    );
  }
  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  compactNow(agent, signal, sourceCommandId) {
    if (hasFusionCompactionCoordinator(agent.session)) {
      const prepare = agent.prepareMaintenanceRequest;
      if (typeof prepare !== "function") return Promise.reject(Object.assign(new Error("A live native maintenance preview is unavailable"), { code: "CONTEXT_PREVIEW_UNAVAILABLE" }));
      return agent.runMaintenance(async (agentSignal) => {
        const combined = AbortSignal.any([signal, agentSignal]);
        const preview = await prepare.call(agent, combined);
        return routeFusionCompaction(
          agent,
          "manual",
          "idle",
          combined,
          sourceCommandId,
          () => this.compactNowWithin(agent, combined, sourceCommandId),
          preview
        );
      });
    }
    return routeFusionCompaction(
      agent,
      "manual",
      "idle",
      signal,
      sourceCommandId,
      () => this.compactNowNative(agent, signal, sourceCommandId)
    );
  }
  async compactNowWithin(agent, signal, sourceCommandId) {
    signal.throwIfAborted();
    const range = selectCompactableRange(
      agent.session,
      this.ctx.tokenMeter.measure(
        agent.session,
        fusionHeaderFor(agent.session),
        fusionContextFor(agent.session) === void 0 ? void 0 : { requestContext: fusionContextFor(agent.session) }
      ),
      0,
      fusionProtectedFor(agent.session)
    );
    if (range === null) return null;
    return compactSurfaceRegion(
      this.regionDependencies(agent),
      agent.session,
      range.start,
      range.end,
      agent,
      {
        owner: null,
        stability: "selected-span",
        ...sourceCommandId === void 0 ? {} : { sourceCommandId },
        flush: async () => {
          if (!await this.ctx.sessions.flush(agent.session)) throw new Error("Coordinated compaction persistence is unconfirmed");
        }
      },
      signal
    );
  }
  compactNowNative(agent, signal, sourceCommandId) {
    signal.throwIfAborted();
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        try {
          operationSignal.throwIfAborted();
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(
              agent.session,
              fusionHeaderFor(agent.session),
              fusionContextFor(agent.session) === void 0 ? void 0 : { requestContext: fusionContextFor(agent.session) }
            ),
            0,
            fusionProtectedFor(agent.session)
          );
          if (range === null) return null;
          return await compactSurfaceRegion(
            this.regionDependencies(agent),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: "selected-span",
              ...sourceCommandId === void 0 ? {} : { sourceCommandId },
              flush: async () => {
                const saved = await this.ctx.sessions.flush(agent.session);
                if (fusionGuardFor(agent.session) && !saved) throw new Error("Coordinated compaction persistence is unconfirmed");
              }
            },
            operationSignal
          );
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError2(
              "cancelled",
              "manual compaction was cancelled",
              { cause: error }
            );
          }
          operationSignal.throwIfAborted();
          throw error;
        }
      });
    } catch (error) {
      throw new ManualCompactionError2(
        "busy",
        "manual compaction requires an idle agent with no waking queued work",
        { cause: error }
      );
    }
  }
  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  regionDependencies(agent) {
    const guardPlan = fusionGuardFor(agent.session);
    const requestHeader = fusionHeaderFor(agent.session);
    const requestContext = fusionContextFor(agent.session);
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      ...guardPlan ? { guardPlan } : {},
      ...requestHeader ? { requestHeader } : {},
      ...requestContext ? { requestContext } : {}
    };
  }
};
var index_default = BasicCompactionEngine;
export {
  BasicCompactionEngine,
  index_default as default,
  registerFusionCompactionCoordinator,
  resolveFusionCompactionEngine
};
//# sourceMappingURL=index.js.map
