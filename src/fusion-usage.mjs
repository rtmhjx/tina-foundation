import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { nativeUsageMeters } from './fusion-provider-facts.mjs';

const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Native terminal attempt events are the authority; this module only projects them. */
export function createFusionUsageProjection({ sessionId, decl, tracker, usageLog, messagesRef = () => [] }) {
  // Existing receipts are immutable. Upgrading a derived projection may improve
  // unknown coverage or routing, but it cannot rewrite a bill under the same ID.
  const persisted = new Map((usageLog?.readAll?.() ?? []).filter(row => row.attempt?.meters.native?.sessionId === sessionId)
    .map(row => [row.recordId ?? row.attempt.id, row.attempt]));
  const compatibility = { preservedLedgerRows: 0, legacyProjectionRows: 0 };
  const track = tracker?.open(decl.id, decl.label, { id: decl.id, messagesRef });
  const seen = new Set();
  const ordinals = new Map();
  const pending = new Map();
  const steps = new Map();
  const compactions = new Map();
  const totals = { calls: 0, uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    unknownUsageCalls: 0, unknownCacheCalls: 0, providerAttempts: 0 };
  let route = {}, closed = false, cursor = -1;
  const unregisterReplay = usageLog?.registerReplaySource('native-agent/' + sessionId, {
    cursor: () => cursor,
    sequenceOf: record => {
      const native = record.attempt?.meters.native;
      return native?.sessionId === sessionId && Number.isSafeInteger(native.eventSeq) ? native.eventSeq : undefined;
    },
  });
  function record(source, ending) {
    const { event, provider, model, started, ordinal, purpose = 'main', outcome: sourceOutcome } = source;
    const data = event.data;
    const stream = data.stream ?? [];
    const raw = data.usage ?? stream.findLast(item => item.type === 'chunk' && item.chunk.type === 'usage')?.chunk.usage;
    const terminal = stream.findLast(item => item.type === 'chunk' && item.chunk.type === 'finish')?.chunk;
    const finish = terminal?.reason;
    const receipt = terminal?.replayState?.response ?? data.replayState?.response ?? data.message?.source?.replayState?.response;
    const providerAttempts = receipt?.attempts ?? [];
    if (event.type === 'assistant/attempt' && !finish && !ending) {
      pending.set(event.seq, source); return;
    }
    const outcome = sourceOutcome ?? (data.interrupted || finish?.kind === 'aborted' || (event.type === 'assistant/attempt' && !finish && ending === 'aborted')
      ? 'aborted' : event.type === 'assistant/attempt' ? 'failed' : finish?.kind === 'max-tokens' ? 'incomplete' : 'completed');
    const converted = nativeUsageMeters(raw);
    const counted = { uncachedInputTokens: numeric(raw?.inputTokens), outputTokens: converted.output,
      cacheReadTokens: converted.cachedInput, cacheWriteTokens: converted.details.cacheWrite.quantity };
    let observedCounts = { ...counted };
    const identity = 'native-agent:' + digest([sessionId, event.seq]);
    const attempt = {
      id: identity, generationId: purpose === 'compaction' ? 'native-compaction:' + digest([sessionId, data.compactionId])
        : 'native-step:' + digest([sessionId, data.turn, data.step]), ordinal,
      origin: { instance: provider, module: 'native-dsh', model, compatibilityDomain: 'native-dsh/' + provider + '/' + model },
      // The durable step boundary is available after restart; transient process
      // attempt counters and clocks are deliberately not billing identities.
      startedAt: new Date(started).toISOString(), elapsedMs: Math.max(0, event.time - started),
      requestId: finish?.failure?.requestId ?? null, responseId: null, outcome,
      status: finish?.failure?.status ?? null, serviceTier: null,
      meters: { ...converted,
        details: { 'native-cache-write': { quantity: counted.cacheWriteTokens, unit: 'tokens' } },
        native: { eventType: event.type, eventSeq: event.seq, sessionId, turn: data.turn, step: data.step, usage: raw ?? null,
          ...(purpose === 'compaction' ? { purpose, compactionId: data.compactionId,
            ...(data.llmStreamCoverage ? { dispatchCoverage: data.llmStreamCoverage } : {}) } : {}),
          elapsedBasis: 'durable-step-start-to-terminal-event' } },
      // Native token usage does not provide an immutable quote. Empty charges
      // preserve the existing ledger's explicit unpriced/unknown semantics.
      charges: [],
    };
    if (providerAttempts.length) {
      // Preserve the existing event-derived ledger identity on upgrade/replay.
      // One native request can include several upstream attempts; financial
      // counters aggregate them while the context anchor remains separate.
      const observed = providerAttempts.map(row => {
        const meters = { ...row.meters };
        const input = numeric(meters.input), hit = numeric(meters.cachedInput), miss = numeric(meters.uncachedInput);
        if (input !== null && hit !== null && miss === null) meters.uncachedInput = numeric(input - hit);
        if (input !== null && miss !== null && hit === null) meters.cachedInput = numeric(input - miss);
        return meters;
      });
      const sum = key => observed.every(meters => numeric(meters[key]) !== null)
        ? observed.reduce((total, meters) => total + meters[key], 0) : null;
      for (const key of ['input', 'output', 'total', 'cachedInput', 'uncachedInput', 'reasoning']) attempt.meters[key] = sum(key);
      attempt.charges = providerAttempts.flatMap(row => row.charges ?? []);
      attempt.meters.native.providerAttempts = structuredClone(providerAttempts);
      attempt.meters.native.lastRequestUsage = structuredClone(receipt.lastRequestUsage ?? null);
      attempt.requestId = providerAttempts.at(-1)?.requestId ?? attempt.requestId;
      attempt.responseId = receipt.responseId ?? providerAttempts.at(-1)?.responseId ?? null;
      attempt.status = providerAttempts.at(-1)?.status ?? attempt.status;
      const writes = providerAttempts.map(row => row.meters?.details?.cacheWrite === undefined ? 0
        : numeric(row.meters.details.cacheWrite.quantity));
      const misses = observed.map((meters, index) => numeric(meters.uncachedInput) !== null && writes[index] !== null
        ? numeric(meters.uncachedInput - writes[index]) : null);
      counted.uncachedInputTokens = misses.every(value => value !== null) ? misses.reduce((sum, value) => sum + value, 0) : null;
      counted.cacheWriteTokens = writes.every(value => value !== null) ? writes.reduce((sum, value) => sum + value, 0) : null;
      counted.outputTokens = attempt.meters.output;
      counted.cacheReadTokens = attempt.meters.cachedInput;
      const knownSum = values => values.reduce((sum, value) => sum + (numeric(value) ?? 0), 0);
      observedCounts = { uncachedInputTokens: knownSum(misses), cacheWriteTokens: knownSum(writes),
        outputTokens: knownSum(observed.map(meters => meters.output)), cacheReadTokens: knownSum(observed.map(meters => meters.cachedInput)) };
      // The complete aggregate can be unknown while individual attempts still
      // have observations. Keep this explicit lower bound separate from it.
      attempt.meters.native.observedUsage = { ...observedCounts, basis: 'sum-of-known-provider-attempt-meters' };
      attempt.meters.details['native-cache-write'].quantity = counted.cacheWriteTokens;
      totals.providerAttempts += providerAttempts.length;
    }
    attempt.meters.native.disjointUsage = { ...counted };
    const historical = persisted.get(identity);
    if (historical) {
      const old = historical.meters?.native;
      const same = old?.sessionId === sessionId && old.eventSeq === event.seq && old.eventType === event.type
        && old.turn === data.turn && old.step === data.step
        && isDeepStrictEqual(old.usage ?? null, raw ?? null)
        && historical.generationId === attempt.generationId && historical.ordinal === ordinal
        && historical.startedAt === attempt.startedAt && historical.elapsedMs === attempt.elapsedMs
        && historical.outcome === attempt.outcome;
      if (!same) throw Object.assign(new Error('An immutable usage receipt conflicts with its durable native source event.'),
        { code: 'NATIVE_USAGE_SOURCE_CONFLICT' });
      compatibility.preservedLedgerRows++;
      if (!old.disjointUsage) compatibility.legacyProjectionRows++;
      track?.recordAttempts([historical]);
    } else track?.recordAttempts([attempt]);
    totals.calls++;
    // All totals use the same ledger facts. Nullable per-event coverage remains
    // available alongside these sums of observed values.
    for (const key of Object.keys(counted)) totals[key] += observedCounts[key] ?? 0;
    if (attempt.meters.input === null || attempt.meters.output === null) totals.unknownUsageCalls++;
    if (counted.cacheReadTokens === null || counted.cacheWriteTokens === null) totals.unknownCacheCalls++;
    pending.delete(event.seq);
  }
  function accept(event) {
    if (closed || seen.has(event.seq)) return;
    seen.add(event.seq);
    cursor = Math.max(cursor, event.seq);
    if (event.type === 'request/header' || event.type === 'request/context') {
      const config = event.data.header?.config ?? event.data.config ?? event.data;
      if (config.provider) route.provider = config.provider;
      if (config.model) route.model = config.model;
    }
    if (event.type === 'step/start') steps.set(event.data.turn + ':' + event.data.step, event.time);
    if (event.type === 'compaction/start') compactions.set(event.data.compactionId, { started: event.time, billed: false });
    if (event.type === 'compaction/summary' || event.type === 'compaction/end') {
      const data = event.data;
      const state = compactions.get(data.compactionId) ?? { started: event.time, billed: false };
      // A supplied/manual summary is not a model call. A failed model call may
      // have no usage: retain its unknown coverage instead of inventing zero.
      const hasModelCall = data.llmStreamCoverage !== 'not-dispatched'
        && (data.llmStreamCall === true || data.llmStreamCoverage === 'unknown' || data.usage !== undefined || data.replayState !== undefined);
      if (!state.billed && hasModelCall) {
        record({ event, ordinal: 1, started: state.started, purpose: 'compaction',
          outcome: event.type === 'compaction/end' ? (data.aborted ? 'aborted' : 'failed') : 'completed',
          provider: data.provider ?? route.provider ?? 'unknown-native-provider',
          model: data.model ?? route.model ?? 'unknown-native-model' });
        state.billed = true;
      }
      if (event.type === 'compaction/end') compactions.delete(data.compactionId);
      else compactions.set(data.compactionId, state);
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const key = event.data.turn + ':' + event.data.step;
      const ordinal = (ordinals.get(key) ?? 0) + 1; ordinals.set(key, ordinal);
      const source = event.data.message?.source ?? {};
      record({ event, ordinal, started: steps.get(key) ?? event.time,
        provider: source.provider ?? route.provider ?? 'unknown-native-provider',
        model: source.model ?? route.model ?? 'unknown-native-model' });
    }
    if (event.type === 'turn/end') for (const source of [...pending.values()]) {
      if (source.event.data.turn === event.data.turn) record(source, event.data.reason?.kind ?? 'error');
    }
  }
  return {
    accept,
    replay(events) { for (const event of events) accept(event); },
    close(events) {
      for (const event of events) accept(event);
      // A durable attempt without a terminal turn is retained as unresolved,
      // rather than inventing a cancellation or success for a crashed driver.
      closed = true; track?.close(); unregisterReplay?.();
    },
    inspect: () => ({ projectedEvents: seen.size, unresolvedAttempts: pending.size, totals: { ...totals }, compatibility: { ...compatibility } }),
  };
}
