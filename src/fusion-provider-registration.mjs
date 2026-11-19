import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inputItem, record } from '../upstream/cortico/src/protocol/open-responses/context.ts';
import { GenerationError } from '../upstream/cortico/src/core/generation.ts';
import { boundedContextWindow, nativeGenerationUsage, lastRequestUsage, toolNameCodec, providerFinishReason } from './fusion-provider-facts.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function unsupported(value) {
  throw Object.assign(new Error('Cortico Provider adapter cannot represent ' + value + '.'), { code: 'CORTICO_PROVIDER_UNSUPPORTED' });
}
function modelFacts(provider, model, entry, instance, module) {
  const efforts = new Map([['off', { id: 'off', name: 'Off' }]]);
  for (const tier of module?.reasoningTiers ?? []) if (tier.thinking) {
    const id = tier.effort ?? tier.id;
    efforts.set(id, { id, name: tier.label });
  }
  for (const effort of module?.effortSuggestions ?? []) efforts.set(effort, { id: effort, name: effort });
  if (entry.spec?.thinking) {
    const id = entry.spec.reasoningEffort ?? 'default';
    efforts.set(id, { id, name: id === 'default' ? 'Provider default' : id });
  }
  const contextWindow = boundedContextWindow(instance.contextWindow?.(model), entry.spec?.contextWindow);
  return { provider, id: model, name: model,
    inputModalities: entry.multimodal === true ? ['text', 'image'] : ['text'],
    ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
    ...(entry.spec?.maxTokens === undefined ? {} : { defaultMaxTokens: entry.spec.maxTokens }),
    reasoning: { efforts: [...efforts.values()],
      defaultEffort: entry.spec?.thinking ? entry.spec.reasoningEffort ?? 'default' : 'off' },
  };
}
async function encodedParts(ctx, blocks, options) {
  const result = [];
  for (const block of blocks) {
    options.signal?.throwIfAborted();
    if (block.type === 'text') result.push({ type: 'input_text', text: block.text });
    else if (block.type === 'image') {
      const attachments = ctx.get('attachments');
      if (!attachments) unsupported('an image without native attachment storage');
      const image = await attachments.readImage(block.attachment);
      const bytes = image.data ?? image.bytes;
      if (!bytes) throw new Error('Native image bytes are unavailable.');
      result.push({ type: 'input_image', image_url: 'data:' + block.attachment.mediaType + ';base64,' + Buffer.from(bytes).toString('base64') });
    } else if (block.type === 'file') {
      // The native runtime normally projects files to source-linked read handles.
      // Preserve bytes for an explicitly unprojected one-shot file message.
      const attachments = ctx.get('attachments');
      if (!attachments) unsupported('a file without native attachment storage');
      const chunks = [];
      let size = 0;
      for await (const chunk of attachments.readFileStream(block.attachment, options.signal)) {
        size += chunk.byteLength;
        if (size > (options.maxInlineFileBytes ?? 32 * 1024 * 1024)) throw new Error('Native file exceeds the explicit inline Provider budget.');
        chunks.push(chunk);
      }
      result.push({ type: 'input_file', filename: block.attachment.name ?? 'attachment',
        file_data: Buffer.concat(chunks).toString('base64') });
    } else unsupported('native content block ' + block.type);
  }
  return result;
}
async function requestFor(ctx, nativeOptions) {
  const context = [];
  for (const message of nativeOptions.messages) {
    const replay = message.source?.replayState?.response;
    if (message.role === 'assistant' && replay?.kind === 'cortico-response-v1'
      && replay.contentDigest === digest(message.content)) {
      context.push(...replay.output.map(item => record(structuredClone(item), { origin: replay.origin, responseId: replay.responseId })));
      continue;
    }
    if (replay?.output?.some(item => item.type === 'reasoning' && item.encrypted_content)) {
      unsupported('modified assistant content with encrypted Provider replay');
    }
    let parts = [];
    const flush = () => {
      if (!parts.length) return;
      context.push(record({ type: 'message', id: 'msg_' + randomUUID(), status: 'completed', role: message.role,
        content: message.role === 'assistant' ? parts.map(part => part.type === 'input_text'
          ? { type: 'output_text', text: part.text, annotations: [] } : part) : parts }));
      parts = [];
    };
    for (const block of message.content) {
      if (block.type === 'reasoning') {
        flush();
        context.push(record({ type: 'reasoning', id: 'rs_' + randomUUID(), summary: [],
          content: [{ type: 'reasoning_text', text: block.text }] }));
      } else if (block.type === 'tool-call') {
        flush();
        context.push(record({ type: 'function_call', id: 'fc_' + randomUUID(), status: 'completed',
          call_id: block.id, name: block.name, arguments: block.arguments }));
      } else if (block.type === 'tool-result') {
        flush();
        context.push(record({ type: 'function_call_output', id: 'fco_' + randomUUID(), status: 'completed',
          call_id: block.toolCallId, output: await encodedParts(ctx, block.content, nativeOptions) }));
      } else parts.push(...await encodedParts(ctx, [block], nativeOptions));
    }
    flush();
  }
  const effort = nativeOptions.reasoningEffort;
  const request = {
    model: nativeOptions.model, input: context.map(inputItem),
    ...(nativeOptions.system === undefined ? {} : { instructions: nativeOptions.system }),
    ...(nativeOptions.tools === undefined ? {} : { tools: nativeOptions.tools.map(tool => ({ type: 'function', ...tool })) }),
    ...(nativeOptions.temperature === undefined ? {} : { temperature: nativeOptions.temperature }),
    ...(nativeOptions.maxTokens === undefined ? {} : { max_output_tokens: nativeOptions.maxTokens }),
    ...(effort === undefined || effort === 'default' ? {} : { reasoning: { effort: effort === 'off' ? 'none' : effort } }),
  };
  if (nativeOptions.stop?.length) unsupported('native stop sequences');
  const names = toolNameCodec([...(request.tools ?? []).map(tool => tool.name),
    ...context.filter(entry => entry.item.type === 'function_call').map(entry => entry.item.name)]);
  // Some Providers rebuild the wire request from context rather than input.
  // Normalize both independent sending views; neither aliases native history.
  for (const tool of request.tools ?? []) tool.name = names.encode(tool.name);
  for (const entry of context) if (entry.item.type === 'function_call') entry.item.name = names.encode(entry.item.name);
  request.input = context.map(inputItem);
  return { request, context, names };
}
function nativeOutput(response, names) {
  const blocks = [];
  const keyed = [];
  const callIds = new Set();
  for (let index = 0; index < response.output.length; index++) {
    const item = response.output[index];
    if (item.type === 'function_call') {
      if (item.status && item.status !== 'completed') throw new Error('Provider returned an unfinished tool call.');
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name
        || typeof item.arguments !== 'string' || callIds.has(item.call_id)) throw new Error('Provider tool call has invalid or repeated identity.');
      callIds.add(item.call_id);
      const block = { type: 'tool-call', id: item.call_id, name: names.decode(item.name), arguments: item.arguments };
      blocks.push(block); keyed.push({ key: index + '/call', block });
    } else if (item.type === 'message' || item.type === 'reasoning') {
      for (const [field, parts] of [['content', item.content ?? []], ['summary', item.summary ?? []]]) {
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
          const part = parts[partIndex];
          const text = part.text ?? part.refusal;
          if (typeof text !== 'string') unsupported('Provider output part ' + part.type);
          const block = { type: item.type === 'reasoning' ? 'reasoning' : 'text', text };
          // Empty encrypted reasoning remains exclusively in adapter-private replay.
          if (!text) continue;
          blocks.push(block); keyed.push({ key: index + '/' + field + '/' + partIndex, block });
        }
      }
    } else unsupported('Provider output item ' + item.type);
  }
  return { blocks, keyed };
}
async function* nativeStream(ctx, bound, originalOptions, lifetime, entry, failureFor, assertExecutionMode) {
  const iteration = new AbortController();
  const options = { ...originalOptions, signal: AbortSignal.any([lifetime, iteration.signal, ...originalOptions.signal ? [originalOptions.signal] : []]) };
  if (options.reasoningEffort === undefined) options.reasoningEffort = entry?.spec?.thinking
    ? entry.spec.reasoningEffort ?? 'default' : entry?.spec?.reasoningEffort === 'none' ? 'none' : 'off';
  if (options.temperature === undefined && entry?.spec?.temperature !== undefined) options.temperature = entry.spec.temperature;
  await assertExecutionMode(options);
  const { request, context, names } = await requestFor(ctx, options);
  options.signal.throwIfAborted();
  const queue = [];
  let wake = Promise.withResolvers();
  let settled = false;
  let generation;
  let failure;
  let publishedUsage = false;
  const positions = new Map();
  const calls = new Map();
  const announcedCalls = new Set();
  const emitted = new Set();
  const streamed = new Map();
  let nextIndex = 0;
  const allocate = key => {
    if (!positions.has(key)) positions.set(key, nextIndex++);
    return positions.get(key);
  };
  const push = event => { queue.push(event); wake.resolve(); };
  const { reasoningEffort: _configuredEffort, ...entrySpec } = entry?.spec ?? {};
  const task = Promise.resolve().then(() => bound.respond(request, {
    signal: options.signal, context, sessionId: options.sessionId,
    ...(options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
    nativeSpec: { ...entrySpec, model: options.model,
      thinking: options.reasoningEffort !== 'off' && options.reasoningEffort !== 'none',
      ...(options.reasoningEffort === undefined || options.reasoningEffort === 'default' || options.reasoningEffort === 'off'
        ? {} : { reasoningEffort: options.reasoningEffort }) },
    onEvent: push,
  })).then(value => { generation = value; }, error => { failure = error; })
    .finally(() => { settled = true; wake.resolve(); });
  const aborted = () => wake.resolve();
  options.signal.addEventListener('abort', aborted, { once: true });
  try {
    while (!settled || queue.length) {
      if (options.signal.aborted) { await task; break; }
      if (!queue.length) { await wake.promise; wake = Promise.withResolvers(); continue; }
      const event = queue.shift();
      let key;
      let blockType;
      let delta;
      if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
        key = event.output_index + '/call'; blockType = 'tool-call';
        if (calls.has(key) || announcedCalls.has(event.item.call_id)) throw new Error('Provider announced a duplicate tool call.');
        announcedCalls.add(event.item.call_id);
        calls.set(key, { id: event.item.call_id, name: names.decode(event.item.name) });
        const argumentsDelta = event.item.arguments ?? '';
        streamed.set(key, { ...calls.get(key), arguments: argumentsDelta });
        const index = allocate(key);
        if (!emitted.has(key)) { emitted.add(key); yield { type: 'block-start', index, blockType }; }
        yield { type: 'tool-call-delta', index, id: event.item.call_id, name: names.decode(event.item.name), argumentsDelta };
      } else if (event.type === 'response.function_call_arguments.delta') {
        key = event.output_index + '/call';
        // The added item is authoritative for name/call id. Native block-end
        // later carries the complete call even if a provider has no delta events.
        const call = calls.get(key);
        if (!call) throw new Error('Provider tool arguments arrived before the call identity.');
        streamed.get(key).arguments += event.delta;
        yield { type: 'tool-call-delta', index: allocate(key), id: call.id,
          argumentsDelta: event.delta };
      } else if (['response.output_text.delta', 'response.refusal.delta', 'response.reasoning.delta',
        'response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(event.type)) {
        const summary = 'summary_index' in event;
        key = event.output_index + '/' + (summary ? 'summary' : 'content') + '/' + (summary ? event.summary_index : event.content_index);
        blockType = event.type.startsWith('response.reasoning') ? 'reasoning' : 'text';
        delta = event.delta;
        streamed.set(key, (streamed.get(key) ?? '') + delta);
        const index = allocate(key);
        if (!emitted.has(key)) { emitted.add(key); yield { type: 'block-start', index, blockType }; }
        yield { type: blockType === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text: delta };
      }
    }
    await task;
    if (failure) {
      const attempts = failure instanceof GenerationError ? failure.attempts : [];
      const usage = nativeGenerationUsage({ attempts });
      if (usage) { publishedUsage = true; yield { type: 'usage', usage }; }
      const error = failureFor(failure, options.signal);
      if (!error.failure) throw error;
      yield { type: 'finish', reason: { kind: options.signal.aborted ? 'aborted' : 'error', failure: error.failure },
        replayState: { response: { kind: 'cortico-attempts-v1', attempts,
          lastRequestUsage: lastRequestUsage({ attempts }) } } };
      return;
    }
    options.signal.throwIfAborted();
    if (!generation?.response) throw new Error('Cortico Provider returned no response.');
    const { response } = generation;
    if (response.status !== 'completed' && response.status !== 'incomplete') throw new GenerationError(
      response.error?.message ?? 'Cortico Provider response failed.', generation.attempts ?? [], response, generation.origin, 0,
      JSON.stringify({ error: response.error }));
    const output = nativeOutput(response, names);
    const finalKeys = new Set(output.keyed.map(part => part.key));
    for (const key of emitted) if (!finalKeys.has(key)) throw new Error('Provider final response omitted streamed content.');
    for (const { key, block } of output.keyed) {
      const observed = streamed.get(key);
      if (observed !== undefined && (block.type === 'tool-call'
        ? observed.id !== block.id || observed.name !== block.name || observed.arguments !== block.arguments
        : observed !== block.text)) throw new Error('Provider final response differs from streamed content.');
      const index = allocate(key);
      if (!emitted.has(key)) {
        emitted.add(key);
        yield { type: 'block-start', index, blockType: block.type };
        if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
        else yield { type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text: block.text };
      }
      yield { type: 'block-end', index, block };
    }
    const usage = nativeGenerationUsage(generation);
    if (usage) { publishedUsage = true; yield { type: 'usage', usage }; }
    const orderedBlocks = [...output.keyed].sort((a, b) => positions.get(a.key) - positions.get(b.key)).map(part => part.block);
    yield { type: 'finish', reason: providerFinishReason(response, output.blocks.some(block => block.type === 'tool-call')),
    replayState: { response: { kind: 'cortico-response-v1', responseId: response.id, origin: generation.origin,
      output: response.output, contentDigest: digest(orderedBlocks), attempts: generation.attempts,
      lastRequestUsage: lastRequestUsage(generation),
      selection: { model: request.model, reasoningEffort: request.reasoning?.effort ?? null } } } };
  } catch (error) {
    iteration.abort(error);
    await task;
    const attempts = generation?.attempts ?? (failure instanceof GenerationError ? failure.attempts : []);
    const usage = nativeGenerationUsage({ attempts, response: generation?.response });
    if (!publishedUsage && usage) yield { type: 'usage', usage };
    const normalized = failureFor(error, originalOptions.signal?.aborted || lifetime.aborted ? options.signal : undefined);
    yield { type: 'finish', reason: { kind: originalOptions.signal?.aborted || lifetime.aborted ? 'aborted' : 'error', failure: normalized.failure },
      replayState: { response: { kind: 'cortico-attempts-v1', attempts,
        lastRequestUsage: lastRequestUsage({ attempts, response: generation?.response }) } } };
  } finally {
    options.signal.removeEventListener('abort', aborted);
    // Closing the consumer owns cancellation too: no orphan transport continues
    // after iterator.return() or a protocol failure. Providers must honor signal.
    iteration.abort(new Error('Cortico Provider stream consumer closed.'));
    await task;
  }
}

/** Register one Cortico endpoint as a real native LlmRuntime route. */
export async function registerCorticoProvider(ctx, {
  registry, name, getEntry, getModule, providerId = 'cortico:' + name,
}) {
  const require = createRequire(new URL('package.json', ctx.baseUrl));
  const { LlmAdapter, LlmError, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
  const lifetime = new AbortController();
  let disposed = false;
  const assertExecutionMode = module => async options => {
    if (options.reasoningEffort !== 'ultra') return;
    // API 6 advertises reasoning tiers, not an agent orchestration runtime.
    // An explicitly supplied capability validator is the extension seam for a
    // future real implementation; a static effort label is not sufficient.
    if (module?.executionModes?.ultra === 'codex-ultra' && typeof module.validateExecutionMode === 'function') {
      await module.validateExecutionMode({ model: options.model, mode: 'ultra', signal: options.signal });
      return;
    }
    throw new LlmError(module?.id === 'chatgpt'
      ? 'The SIWC direct route rejected reasoning.effort=ultra in the verified capability probe; no lower effort was requested.'
      : 'The selected Provider has no verified Ultra execution mode; no lower effort was requested.', 'ULTRA_UNSUPPORTED');
  };
  const failureFor = module => (error, signal) => {
    if (!(error instanceof GenerationError)) return error instanceof LlmError ? error
      : new LlmError(error?.message ?? 'Provider stream failed.', signal?.aborted ? 'ABORTED' : 'PROVIDER_PROTOCOL_ERROR', { cause: error });
    const requestId = error.attempts.findLast(attempt => attempt.purpose !== 'diagnostic'
      && typeof attempt.requestId === 'string' && attempt.requestId.length > 0)?.requestId;
    const detail = [error.partial?.error?.code, error.partial?.error?.message, error.body, error.message].filter(Boolean).join(' ');
    // A generic 413 can be a file/body limit. Only explicit Provider evidence is
    // allowed to trigger destructive context maintenance and retry.
    const code = signal?.aborted ? 'ABORTED'
      : (error.status !== 413 && module?.contextOverflow?.(error)) || isContextWindowExceededError(detail) ? CONTEXT_WINDOW_EXCEEDED_CODE
      : isQuotaExceededError(detail) ? 'QUOTA'
      : error.status === 401 ? 'AUTH' : error.status === 403 ? 'PERMISSION_DENIED'
      : error.status === 429 ? 'RATE_LIMIT' : error.status >= 500 ? 'SERVER'
      : error.status === 413 ? 'REQUEST_TOO_LARGE'
      : error.status === 0 && (error.partial?.error || error.cause?.name === 'StreamErrorEvent') ? 'PROVIDER_STREAM_ERROR'
      : error.status === 0 && error.cause?.name === 'TimeoutError' ? 'TIMEOUT'
      : error.status === 0 ? 'TRANSPORT' : 'INVALID_REQUEST';
    return new LlmError(error.message, code, { cause: error,
      ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}),
      ...(requestId ? { requestId } : {}),
    });
  };
  class CorticoAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Cortico / ' + name }; }
    async listModels(provider) {
      const entry = getEntry();
      const instance = registry.resolve(name);
      const models = await instance.listModels?.() ?? (entry.spec?.model ? [{ id: entry.spec.model }] : []);
      return models.map(model => ({ provider, id: model.id, name: model.displayName ?? model.id,
        ...(model.inputImages === undefined ? {} : { inputModalities: model.inputImages ? ['text', 'image'] : ['text'] }) }));
    }
    async resolveModel(provider, model, signal) {
      signal?.throwIfAborted();
      return modelFacts(provider, model, getEntry(), registry.resolve(name), getModule?.());
    }
    async prepareCall(provider, model, signal) {
      signal?.throwIfAborted();
      if (disposed) throw new Error('Cortico Provider registration is disposed.');
      const entry = structuredClone(getEntry());
      const instance = registry.resolve(name);
      const bound = registry.bind(name).bind?.() ?? registry.bind(name);
      const module = getModule?.();
      return { model: modelFacts(provider, model, entry, instance, module),
        stream: options => nativeStream(ctx, bound, options, lifetime.signal, entry, failureFor(module), assertExecutionMode(module)) };
    }
    stream(options) {
      const bound = registry.bind(name).bind?.() ?? registry.bind(name);
      const module = getModule?.();
      return nativeStream(ctx, bound, options, lifetime.signal, structuredClone(getEntry()), failureFor(module), assertExecutionMode(module));
    }
  }
  const registration = ctx.llm.registerAdapter([providerId], new CorticoAdapter());
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort(new Error('Cortico Provider registration unloaded.'));
    registration();
  };
  ctx.effect(() => dispose);
  return Object.freeze({ providerId, dispose });
}

/** Synchronize configured endpoints after native ProviderHub configuration changes. */
export async function mountCorticoProviderRegistrations(ctx, {
  registry, entries, getModule, excludeNames = [], subscribe, onError,
}) {
  const registrations = new Map();
  const excluded = new Set(excludeNames);
  let queue = Promise.resolve();
  let closed = false;
  let lastError;
  const routeFor = name => 'cortico:' + name;
  function refresh() {
    const work = async () => {
      if (closed) throw new Error('Cortico Provider registration service is stopped.');
      const active = entries();
      for (const [name, registration] of registrations) if (!Object.hasOwn(active, name) || excluded.has(name)) {
        registration.dispose(); registrations.delete(name);
      }
      for (const name of Object.keys(active)) if (!excluded.has(name) && !registrations.has(name)) {
        registrations.set(name, await registerCorticoProvider(ctx, {
          registry, name, providerId: routeFor(name), getEntry: () => entries()[name],
          getModule: getModule ? () => getModule(entries()[name].kind) : undefined,
        }));
      }
      lastError = undefined;
      return [...registrations].map(([name, registration]) => ({ name, providerId: registration.providerId }));
    };
    const run = queue.then(work, work); queue = run.then(() => {}, () => {}); return run;
  }
  const unsubscribe = subscribe?.(() => { void refresh().catch(error => {
    lastError = { code: error.code ?? 'PROVIDER_REGISTRATION_FAILED', message: 'Cortico Provider registration refresh failed.' };
    onError?.(error);
  }); });
  const service = Object.freeze({
    refresh, routeFor,
    status: () => ({ routes: [...registrations].map(([name, registration]) => ({ name, providerId: registration.providerId })), lastError }),
    async select({ name, model = entries()[name]?.spec?.model, sessionId }) {
      await refresh();
      if (!registrations.has(name) || !model) throw new Error('Cortico Provider endpoint/model is unavailable.');
      return ctx.sessionController.selectModel({ sessionId, provider: routeFor(name), model });
    },
    dispose() {
      closed = true; unsubscribe?.();
      for (const registration of registrations.values()) registration.dispose();
      registrations.clear();
    },
  });
  ctx.effect(() => service.dispose);
  await refresh();
  return service;
}
