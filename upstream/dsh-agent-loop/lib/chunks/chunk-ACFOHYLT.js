// lib/types/request-head.js
import { createHash } from "node:crypto";
import { LlmError, freezeMessage } from "@deepseek-ai/dsh-llm";
var DEFAULT_MAX_REQUEST_HEAD_TOKENS = 32768;
var digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
var fail = (code, text) => {
  throw new LlmError(text, code);
};
var snapshotDigest = (head) => digest({ providers: head.providers, messages: head.messages });
function estimateRequestMessage(message) {
  const content = (blocks) => blocks.reduce((sum, block) => {
    switch (block.type) {
      case "text":
      case "reasoning":
        return sum + Math.ceil(block.text.length / 4) + 4;
      case "tool-call":
        return sum + Math.ceil(block.name.length / 4) + Math.ceil(block.arguments.length / 4) + 4;
      case "tool-result":
        return sum + content(block.content) + 4;
      default:
        return sum + Math.ceil(JSON.stringify(block).length / 4) + 4;
    }
  }, 0);
  if (message.role !== "system")
    return content(message.content) + 4;
  if (!message.content.length)
    return 0;
  return Math.ceil(message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : JSON.stringify(block).length), 0) / 4) + 4;
}
function normalize(value, providerId, sessionId) {
  if (!value || !Array.isArray(value.messages) || value.revision !== void 0 && typeof value.revision !== "string")
    fail("REQUEST_HEAD_INVALID", "A request head provider returned an invalid value.");
  const result = [];
  const pending = /* @__PURE__ */ new Map();
  const seenCalls = /* @__PURE__ */ new Set();
  const seenIds = /* @__PURE__ */ new Set();
  const source = { kind: "plugin", plugin: "request-head/" + providerId, form: "recall" };
  const idFor = (id) => "request-head-" + digest([sessionId, providerId, id]);
  const close = () => {
    for (const [id] of pending)
      result.push(freezeMessage({
        id: idFor("missing-result:" + id),
        role: "user",
        source,
        content: [{
          type: "tool-result",
          toolCallId: id,
          isError: true,
          content: [{ type: "text", text: "This request-only example did not include a tool result." }]
        }]
      }));
    pending.clear();
  };
  for (const raw of value.messages) {
    if (!raw || typeof raw !== "object")
      fail("REQUEST_HEAD_INVALID", "A request head contains an invalid message.");
    if (raw.role === "system" || raw.role === "developer")
      continue;
    if (!["user", "assistant"].includes(raw.role) || typeof raw.id !== "string" || !raw.id || !Array.isArray(raw.content))
      fail("REQUEST_HEAD_INVALID", "A request head message has an invalid role, identity or content.");
    if (seenIds.has(raw.id))
      fail("REQUEST_HEAD_ID_COLLISION", "A request head provider reused a message identity.");
    seenIds.add(raw.id);
    if (raw.role === "user") {
      const plain = [];
      for (const block of raw.content) {
        if (!block || typeof block.type !== "string")
          fail("REQUEST_HEAD_INVALID", "A request head contains an invalid content block.");
        if (block.type === "tool-call")
          fail("REQUEST_HEAD_INVALID", "A user request head cannot contain a tool call.");
        if (block.type === "tool-result") {
          if (!pending.delete(block.toolCallId))
            continue;
          if (!Array.isArray(block.content))
            fail("REQUEST_HEAD_INVALID", "A request head contains an invalid tool result.");
          result.push(freezeMessage({ id: idFor(raw.id + ":tool-result:" + block.toolCallId), role: "user", source, content: [block] }));
        } else {
          if ((block.type === "text" || block.type === "reasoning") && typeof block.text !== "string")
            fail("REQUEST_HEAD_INVALID", "A request head contains invalid text.");
          plain.push(block);
        }
      }
      if (plain.length) {
        close();
        result.push(freezeMessage({ id: idFor(raw.id), role: "user", content: plain, source }));
      }
      continue;
    }
    const content = [];
    close();
    for (const block of raw.content) {
      if (!block || typeof block.type !== "string")
        fail("REQUEST_HEAD_INVALID", "A request head contains an invalid content block.");
      if (block.type === "tool-call") {
        if (raw.role !== "assistant" || typeof block.id !== "string" || typeof block.name !== "string" || typeof block.arguments !== "string")
          fail("REQUEST_HEAD_INVALID", "A request head contains an invalid tool call.");
        if (seenCalls.has(block.id))
          fail("REQUEST_HEAD_CALL_COLLISION", "A request head reused a tool call identity.");
        seenCalls.add(block.id);
        pending.set(block.id, block);
      } else if (block.type === "tool-result") {
        continue;
      } else if ((block.type === "text" || block.type === "reasoning") && typeof block.text !== "string")
        fail("REQUEST_HEAD_INVALID", "A request head contains invalid text.");
      content.push(block);
    }
    if (content.length)
      result.push(freezeMessage({ id: idFor(raw.id), role: raw.role, content, source }));
  }
  close();
  return result;
}
var RequestHeadRegistry = class {
  entries = /* @__PURE__ */ new Map();
  register(ctx, registration) {
    if (!registration || typeof registration.id !== "string" || !registration.id || typeof registration.sessionId !== "string" || typeof registration.provide !== "function")
      fail("REQUEST_HEAD_REGISTRATION_INVALID", "A request head registration needs an id, sessionId and provider.");
    const key = registration.sessionId + "\0" + registration.id;
    if (this.entries.has(key))
      fail("REQUEST_HEAD_REGISTRATION_CONFLICT", "A request head provider identity is already registered for this session.");
    const entry = { registration: { ...registration }, active: true };
    return ctx.effect(() => {
      this.entries.set(key, entry);
      return () => {
        entry.active = false;
        if (this.entries.get(key) === entry)
          this.entries.delete(key);
      };
    }, "agentLoop.requestHead()");
  }
  async assemble(context) {
    const entries = [...this.entries.values()].filter((entry) => entry.active && entry.registration.sessionId === context.agent.session.id);
    if (!entries.length)
      return void 0;
    const providers = [];
    const messages = [];
    for (const entry of entries) {
      context.signal.throwIfAborted();
      const value = await entry.registration.provide(context);
      context.signal.throwIfAborted();
      if (!entry.active)
        continue;
      const normalized = normalize(value, entry.registration.id, context.agent.session.id);
      providers.push({ id: entry.registration.id, ...value.revision === void 0 ? {} : { revision: value.revision } });
      messages.push(...normalized);
    }
    const head = { version: 1, sessionId: context.agent.session.id, turn: context.turn, step: context.step, providers, messages, digest: snapshotDigest({ providers, messages }) };
    return head;
  }
};
function deriveRequestMessages(session, head = session.requestContext()?.requestHead) {
  const surface = session.deriveMessages();
  if (!head)
    return surface;
  if (head.version !== 1 || head.sessionId !== session.id || head.digest !== snapshotDigest(head))
    fail("REQUEST_HEAD_AUDIT_INVALID", "The request head audit snapshot is invalid.");
  const ids = new Set(surface.map((message) => message.id));
  const calls = new Set(surface.flatMap((message) => message.content.filter((block) => block.type === "tool-call").map((block) => block.id)));
  const providerIds = new Set(head.providers.map((provider) => "request-head/" + provider.id));
  for (const message of head.messages) {
    if (!["user", "assistant"].includes(message.role) || message.source.kind !== "plugin" || !providerIds.has(message.source.plugin))
      fail("REQUEST_HEAD_AUDIT_INVALID", "The request head has an invalid authority source.");
    if (ids.has(message.id))
      fail("REQUEST_HEAD_ID_COLLISION", "Request head and surface message identities collide.");
    ids.add(message.id);
    for (const block of message.content)
      if (block.type === "tool-call") {
        if (calls.has(block.id))
          fail("REQUEST_HEAD_CALL_COLLISION", "Request head and surface tool call identities collide.");
        calls.add(block.id);
      }
  }
  let at = 0;
  while (surface[at]?.role === "system")
    at++;
  return [...surface.slice(0, at), ...head.messages, ...surface.slice(at)];
}
function priceRequestHead(session, head, header, contextWindow, maxHeadTokens) {
  const headTokens = head.messages.reduce((sum, message) => sum + estimateRequestMessage(message), 0);
  const surfaceTokens = session.deriveMessages().reduce((sum, message) => sum + estimateRequestMessage(message), 0);
  const toolsTokens = header.tools?.length ? Math.ceil(JSON.stringify(header.tools).length / 4) + 4 : 0;
  const outputReserve = header.config.maxTokens ?? 0;
  const knownWindow = Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : void 0;
  return { ...head, budget: {
    estimator: "native-fixed-density-v1",
    headTokens,
    surfaceTokens,
    toolsTokens,
    outputReserve,
    estimatedTokens: headTokens + surfaceTokens + toolsTokens + outputReserve,
    maxHeadTokens,
    ...knownWindow === void 0 ? {} : { contextWindow: knownWindow },
    enforcement: headTokens === 0 ? "empty-head" : knownWindow === void 0 ? "head-limit-only" : "context-window"
  } };
}
function assertRequestHeadBudget(head) {
  const budget = head?.budget;
  if (!budget || budget.headTokens === 0)
    return;
  if (budget.headTokens > budget.maxHeadTokens)
    fail("HEAD_CONTEXT_BUDGET_EXCEEDED", `Request head needs ${budget.headTokens} estimated tokens; configured head limit is ${budget.maxHeadTokens}.`);
  if (budget.contextWindow !== void 0 && budget.estimatedTokens > budget.contextWindow)
    fail("REQUEST_CONTEXT_BUDGET_EXCEEDED", `Request needs ${budget.estimatedTokens} estimated tokens including head, surface, tools and output reserve; context window is ${budget.contextWindow}.`);
}

export {
  DEFAULT_MAX_REQUEST_HEAD_TOKENS,
  estimateRequestMessage,
  RequestHeadRegistry,
  deriveRequestMessages,
  priceRequestHead,
  assertRequestHeadBudget
};
//# sourceMappingURL=chunk-ACFOHYLT.js.map
