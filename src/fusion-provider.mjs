import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { GenerationError, priceUsage, unknownMeters } from '../upstream/cortico/src/core/generation.ts';
import { nativeChatInput, requestContext } from '../upstream/cortico/src/providers/transport/native-input.ts';
import { ChatResponseAssembly } from '../upstream/cortico/src/providers/transport/response-assembly.ts';
import { nativeUsageMeters, toolNameCodec } from './fusion-provider-facts.mjs';

function unsupported(feature) {
  throw Object.assign(new Error('The native ResponseClient cannot represent ' + feature + '.'), { code: 'NATIVE_RESPONSE_UNSUPPORTED' });
}
function validate(request, options) {
  if (request.previous_response_id) unsupported('previous_response_id without explicit context');
  if (request.background) unsupported('background response resources');
  if (request.truncation && request.truncation !== 'disabled') unsupported('automatic context truncation');
  if (request.text?.format && request.text.format.type !== 'text') unsupported('structured text format');
  if (request.tool_choice && !['auto', 'none'].includes(request.tool_choice)) unsupported('forced tool choice');
  if (request.top_p != null && request.top_p !== 1) unsupported('top_p');
  if (request.presence_penalty != null && request.presence_penalty !== 0) unsupported('presence_penalty');
  if (request.frequency_penalty != null && request.frequency_penalty !== 0) unsupported('frequency_penalty');
  if (request.top_logprobs != null && request.top_logprobs !== 0) unsupported('logprobs');
  if (request.max_tool_calls != null) unsupported('a provider-side tool-call limit');
  if (request.service_tier && !['auto', 'default'].includes(request.service_tier)) unsupported('a native service tier override');
  if (request.reasoning?.summary && request.reasoning.summary !== 'none') unsupported('a reasoning summary mode');
  for (const tool of request.tools ?? []) if (tool.type !== 'function') unsupported('tool type ' + tool.type);
  for (const entry of requestContext(request, options)) {
    if (entry.item.type === 'reasoning' && entry.item.encrypted_content
      && !entry.item.content?.some(part => typeof part.text === 'string' && part.text)) {
      unsupported('encrypted reasoning without provider-readable content');
    }
  }
}
const wireUsage = usage => {
  const meters = nativeUsageMeters(usage);
  return { ...(meters.input === null ? {} : { prompt_tokens: meters.input }),
    ...(meters.output === null ? {} : { completion_tokens: meters.output }),
    ...(meters.total === null ? {} : { total_tokens: meters.total }),
    ...(meters.cachedInput === null ? {} : { prompt_cache_hit_tokens: meters.cachedInput }),
    ...(meters.uncachedInput === null ? {} : { prompt_cache_miss_tokens: meters.uncachedInput }),
    ...(meters.reasoning === null ? {} : { completion_tokens_details: { reasoning_tokens: meters.reasoning } }) };
};

export async function nativeMessages(ctx, request, options, selection, prepared, adapterOptions, native) {
  const messages = [];
  const inputs = nativeChatInput(request, options);
  for (const input of inputs) {
    const content = [];
    const addImage = async (bytes, mediaType, name) => {
      const attachments = ctx.get('attachments');
      if (!attachments) unsupported('images without the native attachment service');
      const [ref] = await attachments.saveImages([{ data: bytes, mediaType, ...(name ? { name } : {}) }]);
      content.push({ type: 'image', attachment: ref });
    };
    if (input.parts) {
      for (const part of input.parts) {
        options.signal?.throwIfAborted();
        if (part.type === 'text') content.push({ type: 'text', text: part.text });
        else if (part.type === 'image_url') {
          const match = /^data:(image\/[^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(part.image_url.url);
          if (!match) unsupported('remote or file-id images without an explicit byte resolver');
          await addImage(Buffer.from(match[2], 'base64'), match[1]);
        } else if (part.type === 'file') {
          const attachments = ctx.get('attachments');
          if (!attachments) unsupported('files without the native attachment service');
          const data = part.file.file_data.replace(/^data:[^;,]+;base64,/, '');
          const ref = await attachments.admitEncodedFile({ data, name: part.file.filename });
          content.push({ type: 'file', attachment: ref });
        } else unsupported('content part ' + part.type);
      }
    } else if (input.content) content.push({ type: 'text', text: input.content });
    for (const blob of input.blobs ?? []) {
      options.signal?.throwIfAborted();
      if (blob.mime.startsWith('image/') && prepared.inputModalities?.includes('image')) {
        if (typeof adapterOptions.resolveBlob !== 'function') unsupported('World image handles without a blob resolver');
        const resolved = await adapterOptions.resolveBlob(blob.handle, blob, options);
        if (!resolved?.bytes) throw new Error('World attachment is unavailable: ' + blob.handle);
        await addImage(resolved.bytes, resolved.mime ?? blob.mime, blob.name);
      } else {
        // This is the World protocol's explicit capability fallback, keeping the
        // source handle and its description available rather than claiming vision.
        content.push({ type: 'text', text: blob.fallbackText + '\n[attachment ' + blob.handle + ', ' + blob.mime + ']' });
      }
    }
    if (input.reasoning_content) content.unshift({ type: 'reasoning', text: input.reasoning_content });
    for (const call of input.tool_calls ?? []) content.push({
      type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments,
    });
    const source = adapterOptions.messageSource?.(input, messages.length) ?? (input.head
      ? { kind: 'plugin', plugin: 'cortico-session-head' }
      : input.role === 'assistant'
      ? { kind: 'model', provider: selection.provider, model: selection.model }
      : input.role === 'tool' ? { kind: 'tool', callId: input.tool_call_id }
        : { kind: 'plugin', plugin: 'cortico-native-response' });
    messages.push(native.freezeMessage({ id: adapterOptions.messageId?.(input, messages.length) ?? randomUUID(),
      role: input.role === 'tool' ? 'user' : input.role,
      source,
      content: input.role === 'tool' ? [{ type: 'tool-result', toolCallId: input.tool_call_id, content }] : content,
    }));
  }
  return messages;
}

/**
 * Cortico auxiliary generations use the native Provider directly. There is no
 * HTTP loopback or second main Agent. A bound client freezes native selection.
 */
export function createNativeResponseClient(ctx, adapterOptions = {}) {
  const lifetime = new AbortController();
  const active = new Set();
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Cortico native response owner unloaded.'));
    await Promise.all([...active]);
  });
  const defaultSelection = () => structuredClone(typeof adapterOptions.defaultSelection === 'function'
    ? adapterOptions.defaultSelection() : adapterOptions.defaultSelection ?? ctx.agentDefaultModel.currentSelection());
  let nativeImport;
  const native = () => nativeImport ??= (async () => {
    const resolver = createRequire(new URL('package.json', ctx.baseUrl));
    return import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-llm')).href);
  })();
  function client(boundSelection) {
    return Object.freeze({
      bind: () => client(boundSelection ?? defaultSelection()),
      async respond(request, options = {}) {
        const completion = Promise.withResolvers();
        active.add(completion.promise);
        try {
        options = { ...options, signal: AbortSignal.any([lifetime.signal, ...options.signal ? [options.signal] : []]) };
        validate(request, options);
        const selection = { ...(boundSelection ?? defaultSelection()) };
        if (request.model && !(adapterOptions.aliasModels ?? []).includes(request.model)) selection.model = request.model;
        if (request.reasoning?.effort) selection.reasoningEffort = request.reasoning.effort;
        if (request.temperature != null) selection.temperature = request.temperature;
        if (request.max_output_tokens != null) selection.maxTokens = request.max_output_tokens;
        const origin = { instance: selection.provider, module: 'cordis-native-provider', model: selection.model,
          compatibilityDomain: 'cordis-native/' + selection.provider + '/' + selection.model };
        const generationId = randomUUID();
        const started = Date.now();
        const attempt = { id: randomUUID(), generationId, ordinal: 0, origin, startedAt: new Date(started).toISOString(),
          elapsedMs: 0, requestId: null, responseId: null, outcome: 'failed', status: null, serviceTier: null,
          requestedServiceTier: request.service_tier ?? null, purpose: options.diagnostic ? 'diagnostic' : 'generation',
          meters: unknownMeters(), charges: [] };
        const assembly = new ChatResponseAssembly({ ...request, model: selection.model });
        const emit = event => { if (!options.signal?.aborted) options.onEvent?.(event); };
        const feed = delta => assembly.feed({ model: selection.model, choices: [{ index: 0, delta }] }, emit);
        let finished;
        try {
          options.signal?.throwIfAborted();
          if (request.reasoning?.effort === 'none') {
            const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model, options.signal);
            const efforts = info.reasoning?.efforts ?? [];
            if (efforts.some(effort => effort.id === 'none')) selection.reasoningEffort = 'none';
            else if (efforts.some(effort => effort.id === 'off')) selection.reasoningEffort = 'off';
            else if (info.reasoning === undefined) delete selection.reasoningEffort;
            else unsupported('disabling reasoning on this native model');
          }
          const prepared = await ctx.llm.prepareCall(selection, options.signal);
          origin.model = prepared.config.model;
          const messages = await nativeMessages(ctx, request, options, prepared.config, prepared, adapterOptions, await native());
          const names = toolNameCodec([...(request.tools ?? []).map(tool => tool.name),
            ...messages.flatMap(message => message.content.filter(block => block.type === 'tool-call').map(block => block.name))]);
          const sentMessages = messages.map(message => ({ ...message, content: message.content.map(block => block.type === 'tool-call'
            ? { ...block, name: names.encode(block.name) } : block) }));
          const toolIndexes = new Map();
          const seen = new Set();
          for await (const chunk of prepared.stream({
            ...prepared.config, messages: sentMessages, signal: options.signal,
            ...(options.sessionId ?? adapterOptions.sessionId ? { sessionId: options.sessionId ?? adapterOptions.sessionId } : {}),
            ...request.tools?.length && request.tool_choice !== 'none'
              ? { tools: request.tools.map(tool => ({ name: names.encode(tool.name), description: tool.description ?? '', parameters: tool.parameters ?? {} })) }
              : {},
          })) {
            options.signal?.throwIfAborted();
            if (chunk.type === 'text-delta') { seen.add(chunk.index); feed({ content: chunk.text }); }
            else if (chunk.type === 'reasoning-delta') { seen.add(chunk.index); feed({ reasoning_content: chunk.text }); }
            else if (chunk.type === 'tool-call-delta') {
              seen.add(chunk.index);
              if (!toolIndexes.has(chunk.index)) toolIndexes.set(chunk.index, toolIndexes.size);
              feed({ tool_calls: [{ index: toolIndexes.get(chunk.index), id: chunk.id,
                function: { ...(chunk.name ? { name: names.decode(chunk.name) } : {}), arguments: chunk.argumentsDelta } }] });
            } else if (chunk.type === 'block-end' && !seen.has(chunk.index)) {
              const block = chunk.block;
              if (block.type === 'text') feed({ content: block.text });
              else if (block.type === 'reasoning') feed({ reasoning_content: block.text });
              else if (block.type === 'tool-call') {
                if (!toolIndexes.has(chunk.index)) toolIndexes.set(chunk.index, toolIndexes.size);
                feed({ tool_calls: [{ index: toolIndexes.get(chunk.index), id: block.id,
                  function: { name: names.decode(block.name), arguments: block.arguments } }] });
              } else unsupported('output block ' + block.type);
            } else if (chunk.type === 'usage') {
              assembly.feed({ usage: wireUsage(chunk.usage) }, emit);
              attempt.meters = nativeUsageMeters(chunk.usage);
            } else if (chunk.type === 'finish') {
              finished = chunk.reason;
              if (finished.kind === 'error' || finished.kind === 'aborted') {
                throw Object.assign(new Error(finished.failure.message), { code: finished.failure.code });
              }
              assembly.feed({ choices: [{ index: 0, delta: {}, finish_reason: finished.kind === 'max-tokens' ? 'length'
                : finished.kind === 'tool-calls' ? 'tool_calls' : 'stop' }] }, emit);
            }
          }
          if (!finished) throw new Error('Native provider ended without a terminal finish record.');
          const response = assembly.finish(emit);
          attempt.outcome = response.status === 'incomplete' ? 'incomplete' : 'completed';
          attempt.responseId = response.id;
          attempt.elapsedMs = Date.now() - started;
          attempt.charges = priceUsage(attempt.meters,
            options.quote?.({ startedAt: attempt.startedAt, requestedServiceTier: attempt.requestedServiceTier }) ?? [], null);
          return { response, origin, attempts: [attempt] };
        } catch (error) {
          attempt.elapsedMs = Date.now() - started;
          attempt.outcome = options.signal?.aborted || finished?.kind === 'aborted' ? 'aborted' : 'failed';
          throw new GenerationError(error.message, [attempt], assembly.snapshot(), origin, error.status ?? 0, '', { cause: error });
        }
        } finally {
          active.delete(completion.promise);
          completion.resolve();
        }
      },
    });
  }
  return client();
}
