import { createHash } from 'node:crypto';

export const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Native disjoint counters to nullable Cortico meters; absence is not a cache miss. */
export function nativeUsageMeters(usage) {
  const input = tokenCount(usage?.inputTokens), output = tokenCount(usage?.outputTokens);
  const cachedInput = tokenCount(usage?.cacheReadTokens), write = tokenCount(usage?.cacheWriteTokens);
  const total = tokenCount(usage?.totalTokens);
  const aggregateInput = total !== null && output !== null ? tokenCount(total - output)
    : input !== null && cachedInput !== null && write !== null ? input + cachedInput + write : null;
  return { input: aggregateInput, output, total: total ?? (aggregateInput !== null && output !== null ? aggregateInput + output : null),
    cachedInput, uncachedInput: input !== null && write !== null ? input + write
      : aggregateInput !== null && cachedInput !== null ? aggregateInput - cachedInput : null,
    reasoning: tokenCount(usage?.reasoningTokens), details: { cacheWrite: { quantity: write, unit: 'tokens' } }, native: structuredClone(usage ?? null) };
}

export function boundedContextWindow(discovered, configured) {
  const windows = [discovered, configured].filter(value => Number.isSafeInteger(value) && value > 0);
  return windows.length ? Math.min(...windows) : undefined;
}

/** Financial totals include retries. They must never anchor context length. */
export function nativeGenerationUsage(generation) {
  const attempts = generation.attempts ?? [];
  if (attempts.length) {
    const usages = attempts.map(attempt => {
      const meters = attempt.meters ?? {};
      const input = tokenCount(meters.input), output = tokenCount(meters.output);
      const write = meters.details?.cacheWrite === undefined ? 0 : tokenCount(meters.details.cacheWrite.quantity);
      const explicitHit = tokenCount(meters.cachedInput), miss = tokenCount(meters.uncachedInput);
      const hit = explicitHit ?? (input !== null && miss !== null ? tokenCount(input - miss) : null);
      // Native TokenUsage requires disjoint input counts. Unknown cache cannot be
      // represented as uncached input; retain the attempt's nullable meters instead.
      if (input === null || output === null || hit === null || write === null
        || input < hit + write || (miss !== null && input - hit !== miss)) return null;
      return { inputTokens: input - hit - write, outputTokens: output, cacheReadTokens: hit,
        cacheWriteTokens: write, totalTokens: input + output, reasoningTokens: tokenCount(meters.reasoning) };
    });
    if (usages.some(usage => usage === null)) return undefined;
    return Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens']
      .filter(key => usages.every(usage => usage[key] !== null))
      .map(key => [key, usages.reduce((sum, usage) => sum + usage[key], 0)]));
  }
  const usage = generation.response?.usage;
  const input = tokenCount(usage?.input_tokens), output = tokenCount(usage?.output_tokens);
  const hit = tokenCount(usage?.input_tokens_details?.cached_tokens);
  if (input === null || output === null || hit === null || hit > input) return undefined;
  const reasoning = tokenCount(usage?.output_tokens_details?.reasoning_tokens);
  return { inputTokens: input - hit, outputTokens: output, cacheReadTokens: hit, cacheWriteTokens: 0,
    totalTokens: input + output, ...(reasoning === null ? {} : { reasoningTokens: reasoning }) };
}

/** Last actual, non-diagnostic request only; never fall back to an earlier known request. */
export function lastRequestUsage(generation) {
  const attempt = generation.attempts?.findLast(item => item.purpose !== 'diagnostic');
  if (attempt) return { input: tokenCount(attempt.meters?.input), output: tokenCount(attempt.meters?.output),
    cachedInput: tokenCount(attempt.meters?.cachedInput), requestId: attempt.requestId ?? null,
    attemptId: attempt.id ?? null, basis: 'last-provider-attempt' };
  if (generation.attempts?.length) return { input: null, output: null, cachedInput: null,
    requestId: null, attemptId: null, basis: 'no-generation-attempt' };
  return { input: tokenCount(generation.response?.usage?.input_tokens), output: tokenCount(generation.response?.usage?.output_tokens),
    cachedInput: tokenCount(generation.response?.usage?.input_tokens_details?.cached_tokens),
    requestId: null, attemptId: null, basis: 'response-usage' };
}

/** The most recent native terminal's request anchor, never its retry sum. */
export function nativeEventRequestUsage(event) {
  if (!event) return null;
  const data = event.data ?? {};
  const stream = data.stream ?? [];
  const terminal = stream.findLast(item => item.type === 'chunk' && item.chunk.type === 'finish')?.chunk;
  const receipt = terminal?.replayState?.response ?? data.message?.source?.replayState?.response;
  if (receipt) {
    const observed = Object.hasOwn(receipt, 'lastRequestUsage') ? receipt.lastRequestUsage
      : receipt.attempts?.length ? lastRequestUsage({ attempts: receipt.attempts }) : null;
    return { nativeSeq: event.seq, ...(observed ? structuredClone(observed) : { input: null, output: null,
      cachedInput: null, requestId: null, attemptId: null, basis: 'provider-request-unobserved' }) };
  }
  const usage = data.usage ?? stream.findLast(item => item.type === 'chunk' && item.chunk.type === 'usage')?.chunk.usage;
  const meters = nativeUsageMeters(usage);
  return { nativeSeq: event.seq, input: meters.input, output: meters.output, cachedInput: meters.cachedInput,
    requestId: terminal?.reason?.failure?.requestId ?? null, attemptId: null, basis: 'native-terminal-usage' };
}

/** A deterministic transport-only vocabulary. Native history and call IDs stay unchanged. */
export function toolNameCodec(names) {
  const originals = [...new Set(names)];
  const valid = name => typeof name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(name);
  const reserved = new Set(originals.filter(valid));
  const forward = new Map(), reverse = new Map();
  for (const name of originals.sort()) {
    if (typeof name !== 'string' || !name) throw new Error('Provider function name must be a nonempty string.');
    let wire = name;
    if (!valid(name)) {
      let salt = 0;
      do { wire = 'cortico_' + createHash('sha256').update(name + (salt ? '\0' + salt : '')).digest('hex').slice(0, 48); salt++; }
      while (reserved.has(wire));
      reserved.add(wire);
    }
    forward.set(name, wire); reverse.set(wire, name);
  }
  return Object.freeze({ encode: name => forward.get(name) ?? name, decode: name => reverse.get(name) ?? name });
}

export function providerFinishReason(response, hasCalls) {
  if (response.status === 'completed') return { kind: hasCalls ? 'tool-calls' : 'stop' };
  if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') return { kind: 'max-tokens' };
  const detail = response.incomplete_details?.reason;
  return { kind: 'error', failure: { code: detail === 'content_filter' ? 'CONTENT_FILTER' : 'PROVIDER_INCOMPLETE',
    message: detail === 'content_filter' ? 'Provider stopped this response because of content filtering.'
      : 'Provider returned an incomplete response without a confirmed output-token limit.' } };
}
