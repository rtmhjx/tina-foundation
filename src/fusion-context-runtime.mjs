import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createFusionContextMaintenance, createSqliteContextMaintenanceStore, contextSourceSnapshotDigest } from './fusion-context-maintenance.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code });
const seq = node => typeof node === 'number' ? node : node?.seq;
const surface = session => session.surface.nodes.map(seq);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DEFAULT_SUMMARY_INSTRUCTION = '保留身份与关系、场景和情绪的连续性、说话习惯、用户明确的边界和待办；区分事实、推断与不确定之处，并保留原文语言。';

/** Convert only the Agent's actual request-planning payload, never a rebuilt preview. */
export async function createNativeContextSnapshot({ payload, getRecords, stageBudgetTokens = 64000, thresholdRatio = 0.85 }) {
  const { agent, request, requestHeader, requestContext, generation, surfaceSeqs, revalidate, signal } = payload ?? {};
  signal?.throwIfAborted();
  const session = agent?.session;
  if (!session || !request || !Object.isFrozen(request) || !requestHeader?.config || !Array.isArray(request.messages)
    || request.provider !== requestHeader.config.provider || request.model !== requestHeader.config.model
    || request.sessionId !== session.id || generation !== session.surface.replaceGeneration
    || !equal(surfaceSeqs, surface(session)) || typeof revalidate !== 'function' || revalidate() !== true
    || !isDeepStrictEqual(request.tools ?? [], requestHeader.tools ?? [])) {
    throw fault('CONTEXT_PREVIEW_UNAVAILABLE', 'The live immutable request preview is missing or stale');
  }
  const head = requestContext?.requestHead;
  const messages = session.deriveMessages();
  if (head) {
    if (!Array.isArray(head.messages) || head.sessionId !== session.id) throw fault('CONTEXT_PREVIEW_UNAVAILABLE', 'Invalid request head');
    let at = 0; while (messages[at]?.role === 'system') at++;
    messages.splice(at, 0, ...head.messages);
  }
  if (!isDeepStrictEqual(messages, request.messages)) throw fault('CONTEXT_PREVIEW_UNAVAILABLE', 'Request messages differ from the native surface and head');
  // request head is priced once by tokenMeter.measure together with its
  // usage anchor; do not add it a second time here.
  const additionalTokens = 0;
  const outputReserveTokens = requestHeader.config.maxTokens ?? 0;
  if (!Number.isSafeInteger(outputReserveTokens) || outputReserveTokens < 0) throw fault('CONTEXT_PREVIEW_UNAVAILABLE', 'Invalid output reservation');
  const records = await getRecords();
  if (revalidate() !== true || generation !== session.surface.replaceGeneration || !equal(surfaceSeqs, surface(session)))
    throw fault('CONTEXT_SNAPSHOT_STALE', 'Request changed during snapshot preparation');
  const digest = createHash('sha256').update(JSON.stringify({ requestHeader, requestContext, surfaceSeqs,
    messages: request.messages, outputReserveTokens, stageBudgetTokens, thresholdRatio })).digest('hex');
  return { sessionId: session.id, generation, records, digest, surfaceSeqs: [...surfaceSeqs],
    provider: request.provider, model: request.model, requestHeader, requestContext, additionalTokens, outputReserveTokens,
    stageBudgetTokens, thresholdRatio, revalidate };
}

/** Confirm the original native compaction bracket and its actual replacement. */
function nativeTrace(session, plan) {
  if (!plan?.compactionId || !Array.isArray(plan.coveredNativeSeqs)) return null;
  const events = session.snapshotEvents();
  const start = events.find(e => e.type === 'compaction/start' && e.data?.compactionId === plan.compactionId);
  const summary = events.find(e => e.type === 'compaction/summary' && e.data?.compactionId === plan.compactionId);
  const end = events.find(e => e.type === 'compaction/end' && e.data?.compactionId === plan.compactionId);
  if (!start || !summary || !end || end.data?.error || !equal(summary.data?.shadowedSeqs, plan.coveredNativeSeqs)) return null;
  const marker = events.find(e => e.type === 'user/message' && e.surfaceOp?.op === 'replace'
    && e.surfaceOp.startSeq === plan.coveredNativeSeqs[0]
    && e.surfaceOp.endSeq === plan.coveredNativeSeqs.at(-1)
    && Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.includes(start.seq)
    && e.sourceEventSeqs.includes(summary.seq)
    && plan.coveredNativeSeqs.every(id => e.sourceEventSeqs.includes(id)));
  if (!marker || !(start.seq < summary.seq && summary.seq < marker.seq && marker.seq < end.seq)
    || !surface(session).includes(marker.seq)) return null;
  return { compactionId: plan.compactionId, startSeq: start.seq, summarySeq: summary.seq, markerSeq: marker.seq, endSeq: end.seq };
}

/** Mount one session only. No background model, other agent, or global override. */
export async function mountFusionContextMaintenance({ ctx, dsh, sessionId, stateDir, persona,
  getSnapshot, getRecords, stageBudgetTokens = 64000, thresholdRatio = 0.85,
  inputProtection, refreshPrefix, borrowedHost = false, log = console } = {}) {
  if (!ctx?.agents || !ctx?.sessions || !dsh?.importPackage || !sessionId || !stateDir
    || (typeof getSnapshot !== 'function' && typeof getRecords !== 'function') || typeof inputProtection !== 'function' || typeof refreshPrefix !== 'function') {
    throw new TypeError('Session, host, snapshot, input protection and prefix participants are required');
  }
  const agent = ctx.agents.get(sessionId);
  if (!agent?.session || agent.session.id !== sessionId) throw fault('CONTEXT_SESSION_UNAVAILABLE', 'The native target session is unavailable');
  const meter = agent.ctx?.get?.('tokenMeter') ?? ctx.get?.('tokenMeter') ?? ctx.tokenMeter;
  if (meter?.requestHeadAccountingVersion !== 1) {
    throw fault('CONTEXT_METER_OVERLAY_UNAVAILABLE', 'The head-aware native token meter is unavailable');
  }
  const module = await dsh.importPackage('@deepseek-ai/dsh-compaction-basic');
  if (typeof module.resolveFusionCompactionEngine !== 'function') throw fault('CONTEXT_OVERLAY_UNAVAILABLE', 'Scoped compaction resolver is unavailable');
  const engine = await module.resolveFusionCompactionEngine(agent, ctx);
  if (typeof module.registerFusionCompactionCoordinator !== 'function'
    || typeof module.BasicCompactionEngine !== 'function'
    || (!(engine instanceof module.BasicCompactionEngine) && engine?.fusionCompactionProtocol !== 1)
    || typeof engine.inspectFusionPressure !== 'function' || typeof engine.compactIfNeeded !== 'function'
    || typeof engine.compactNow !== 'function') {
    throw fault('CONTEXT_OVERLAY_UNAVAILABLE', 'The active native engine is not the coordinated compaction module');
  }
  await mkdir(stateDir, { recursive: true });
  const store = createSqliteContextMaintenanceStore(join(stateDir, 'fusion-context-maintenance.sqlite'));
  let closed = false;
  let closeTask;
  let busy = 0;
  const recoveries = new Set();
  const interceptions = new Set();
  let coordinator;
  let lastPlannedPayload;
  const session = agent.session;
  const nativeResults = new Map();
  const receiptFor = (row, evidence) => ({
    operationId: row.operationId, sessionId: row.sessionId, generation: row.generation,
    durable: true, method: 'native-compact',
    coverage: { snapshotDigest: row.sourceDigest, coveredNativeSeqs: row.plan.coveredNativeSeqs,
      protectedNativeSeqs: row.plan.protectedNativeSeqs, sourceComplete: true },
    evidence,
  });
  const native = {
    async verifySnapshot({ sessionId: target, snapshot, signal }) {
      signal?.throwIfAborted();
      if (target !== sessionId || snapshot?.sessionId !== sessionId
        || snapshot.generation !== session.surface.replaceGeneration || !equal(snapshot.surfaceSeqs, surface(session))) {
        throw fault('CONTEXT_SNAPSHOT_STALE', 'The snapshot does not match the native session and surface');
      }
      for (const entry of snapshot.records) {
        const origin = entry?.context?.native;
        const values = [origin?.event?.seq, origin?.seq, entry?.context?.nativeSeq].filter(value => value !== undefined);
        if (!values.length) continue;
        if (origin?.sessionId !== sessionId || !origin.event || !Number.isSafeInteger(values[0])
          || values.some(value => value !== values[0]) || !isDeepStrictEqual(origin.event, session.eventAt(values[0]))) {
          throw fault('CONTEXT_SOURCE_MISMATCH', 'A source snapshot does not match its native event');
        }
      }
      return true;
    },
    async commit({ operationId, sessionId: target, signal, snapshot, runNative, guardPlan, protectedNativeSeqs }) {
      if (target !== sessionId || typeof runNative !== 'function') throw fault('CONTEXT_NATIVE_UNAVAILABLE', 'Native compaction belongs to another session or is unavailable');
      signal?.throwIfAborted();
      const before = { generation: session.surface.replaceGeneration, nodes: surface(session) };
      let approvedCoverage;
      let result;
      try {
        result = await runNative(async plan => {
          const permit = await guardPlan(plan);
          approvedCoverage = permit.coverage;
          return permit;
        }, { additionalTokens: snapshot.additionalTokens, thresholdTokens: snapshot.thresholdTokens,
          requestHeader: snapshot.requestHeader, requestContext: snapshot.requestContext,
          target: { provider: snapshot.provider, model: snapshot.model }, protectedNativeSeqs,
          summaryInstruction: snapshot.summaryInstruction });
      } catch (error) {
        // This is the actual invocation returning, not a restart-time guess.
        // Only unchanged generation AND full surface plus a durable flush
        // prove this invocation did not replace the visible native surface.
        if (session.surface.replaceGeneration === before.generation && equal(surface(session), before.nodes)) {
          let durable = false;
          try { durable = await ctx.sessions.flush(session) === true; } catch {}
          if (durable && session.surface.replaceGeneration === before.generation && equal(surface(session), before.nodes)) {
            return { state: 'not-committed', mutated: false, error };
          }
        }
        throw error;
      }
      if (result === null) {
        if (session.surface.replaceGeneration !== before.generation || !equal(surface(session), before.nodes)) {
          throw fault('CONTEXT_COMMIT_UNKNOWN', 'Native no-op changed the surface');
        }
        return { state: 'not-needed', mutated: false };
      }
      const row = await store.lookup(sessionId, operationId);
      if (!row?.plan || !approvedCoverage || result.compactionId !== row.plan.compactionId
        || !equal(result.shadowedSeqs, row.plan.coveredNativeSeqs)) {
        throw fault('CONTEXT_COMMIT_UNKNOWN', 'Native result does not match the guarded plan');
      }
      const evidence = nativeTrace(session, row.plan);
      if (!evidence || !await ctx.sessions.flush(session)) throw fault('CONTEXT_COMMIT_UNKNOWN', 'Native replacement durability is unconfirmed');
      const receipt = receiptFor(row, evidence);
      if (!isDeepStrictEqual(receipt.coverage, approvedCoverage)) throw fault('CONTEXT_COMMIT_UNKNOWN', 'Guard coverage changed after authorization');
      nativeResults.set(operationId, result);
      return receipt;
    },
    async inspect({ sessionId: target, operationId, signal }) {
      signal?.throwIfAborted();
      if (target !== sessionId) return { state: 'unknown' };
      const row = await store.lookup(sessionId, operationId);
      const evidence = nativeTrace(session, row?.plan);
      // A denied/stale guard after the plan was durably recorded can be
      // reconciled only if its own error-closed lifecycle and the original
      // surface generation are all still observable and durable.
      if (!evidence && row?.plan?.compactionId && row.generation === session.surface.replaceGeneration) {
        const events = session.snapshotEvents();
        const start = events.find(e => e.type === 'compaction/start' && e.data?.compactionId === row.plan.compactionId);
        const end = events.find(e => e.type === 'compaction/end' && e.data?.compactionId === row.plan.compactionId);
        const marker = events.find(e => e.type === 'user/message' && e.surfaceOp?.op === 'replace'
          && Array.isArray(e.sourceEventSeqs) && start && e.sourceEventSeqs.includes(start.seq));
        if (start && end && end.seq > start.seq && end.data?.error && !marker && await ctx.sessions.flush(session)) {
          return { state: 'not-committed' };
        }
      }
      // An absent marker is not proof of non-commit. It may have been replaced,
      // or the process may have failed at a persistence boundary.
      if (!evidence || !await ctx.sessions.flush(session)) return { state: 'unknown' };
      return { state: 'committed', receipt: receiptFor(row, evidence) };
    },
  };
  coordinator = createFusionContextMaintenance({ store, participant: persona, native, inputProtection, refreshPrefix });
  let unregister;
  try {
    unregister = module.registerFusionCompactionCoordinator(session, {
      async interceptCompaction(call) {
        if (closed) throw fault('CONTEXT_MAINTENANCE_CLOSING', 'Context maintenance is closing');
        const finished = Promise.withResolvers();
        interceptions.add(finished.promise);
        busy++;
        try {
        await coordinator.beforeRequest({ sessionId, signal: call.signal });
        const generation = session.surface.replaceGeneration;
        let preview = call.requestPreview;
        if (call.trigger === 'context-overflow' && preview?.overflowPosition) {
          const position = preview.overflowPosition;
          const previous = lastPlannedPayload;
          preview = previous && previous.turn === position.turn && previous.step === position.step
            && previous.signal === call.signal && previous.agent === call.agent ? previous : undefined;
        }
        if (!preview || preview.agent !== agent || preview.generation !== generation || typeof preview.revalidate !== 'function'
          || preview.revalidate() !== true) throw fault('CONTEXT_PREVIEW_UNAVAILABLE', 'Native compaction needs a live request-planning preview');
        let snapshot = getSnapshot
          ? await getSnapshot({ agent: call.agent, sessionId, generation, trigger: call.trigger,
            boundary: call.boundary, requestPreview: preview, signal: call.signal })
          : await createNativeContextSnapshot({ payload: preview, getRecords, stageBudgetTokens, thresholdRatio });
        if (!snapshot || !Array.isArray(snapshot.records) || typeof snapshot.digest !== 'string' || !snapshot.digest
          || snapshot.sessionId !== sessionId || snapshot.generation !== generation
          || typeof snapshot.provider !== 'string' || !snapshot.provider || typeof snapshot.model !== 'string' || !snapshot.model
          || snapshot.requestHeader?.config?.provider !== snapshot.provider || snapshot.requestHeader?.config?.model !== snapshot.model
          || typeof snapshot.revalidate !== 'function' || snapshot.revalidate() !== true
          || !Number.isSafeInteger(snapshot.outputReserveTokens) || snapshot.outputReserveTokens < 0
          || session.surface.replaceGeneration !== generation
          || !Array.isArray(snapshot.surfaceSeqs) || snapshot.additionalTokens !== 0
          || snapshot.records.some(record => {
            const origin = record?.context?.native;
            const values = [origin?.event?.seq, origin?.seq, record?.context?.nativeSeq].filter(value => value !== undefined);
            return values.length && (origin?.sessionId !== sessionId
              || values.some(value => !Number.isSafeInteger(value) || value < 0 || value !== values[0]));
          })) {
          throw fault('CONTEXT_REQUEST_INVALID', 'A complete measured request snapshot is required');
        }
        await native.verifySnapshot({ sessionId, snapshot, signal: call.signal });
        const pressure = await engine.inspectFusionPressure(agent, snapshot.additionalTokens, call.signal,
          { provider: snapshot.provider, model: snapshot.model }, {
            outputReserveTokens: snapshot.outputReserveTokens, stageBudgetTokens: snapshot.stageBudgetTokens,
            thresholdRatio: snapshot.thresholdRatio, requestHeader: snapshot.requestHeader, requestContext: snapshot.requestContext,
          });
        if (call.trigger === 'pressure' && !pressure.needed) return null;
        const summaryInstruction = typeof persona.contextCompactionInstruction === 'function'
          ? await persona.contextCompactionInstruction({ sessionId, snapshot, signal: call.signal })
          : DEFAULT_SUMMARY_INSTRUCTION;
        if (typeof summaryInstruction !== 'string' || !summaryInstruction.trim()) throw fault('CONTEXT_SUMMARY_INSTRUCTION_INVALID', 'Persona compaction instruction must be nonempty text');
        if (snapshot.revalidate() !== true) throw fault('CONTEXT_SNAPSHOT_STALE', 'Request changed while preparing summary instruction');
        snapshot = { ...snapshot, summaryInstruction,
          digest: createHash('sha256').update(JSON.stringify([snapshot.digest, summaryInstruction])).digest('hex') };
        const operationId = randomUUID();
        try {
          const outcome = await coordinator.maintain({ sessionId, generation,
            operationId, reason: call.trigger, boundary: call.boundary,
            snapshot: { ...snapshot, thresholdTokens: pressure.thresholdTokens }, signal: call.signal, runNative: call.runNative });
          if (outcome.status === 'not-needed') return null;
          const result = nativeResults.get(operationId);
          if (outcome.status !== 'complete' || !result) throw fault('CONTEXT_COMMIT_UNKNOWN', 'Completed coordination lacks its native result');
          return result;
        } finally { nativeResults.delete(operationId); }
        } finally { busy--; interceptions.delete(finished.promise); finished.resolve(); }
      },
    });
  } catch (error) { store.close(); throw error; }
  // Participants and the native session are ready here. A failed or ambiguous
  // recovery leaves the persisted nonterminal row in place, so beforeRequest
  // continues to gate the next model call; callers can inspect or retry it.
  let startupRecovery;
  try { startupRecovery = await coordinator.reconcile({ sessionId }); }
  catch (error) {
    startupRecovery = { status: 'blocked', code: error?.code ?? 'CONTEXT_RECOVERY_FAILED' };
    log?.warn?.('Session context recovery remains blocked', { sessionId, code: startupRecovery.code });
  }
  return Object.freeze({
    sessionId, borrowedHost, startupRecovery,
    async planRequest(payload) {
      if (payload?.agent !== agent || !payload.signal || !Number.isSafeInteger(payload.turn) || !Number.isSafeInteger(payload.step)
        || typeof payload.revalidate !== 'function' || payload.revalidate() !== true) {
        lastPlannedPayload = undefined;
        throw fault('CONTEXT_PREVIEW_UNAVAILABLE', 'Planning payload belongs to another session or is stale');
      }
      lastPlannedPayload = payload;
      const before = session.surface.replaceGeneration;
      const result = await engine.compactIfNeeded(agent, 'pressure', payload.signal, payload);
      return { changed: session.surface.replaceGeneration !== before, result };
    },
    beforeRequest: options => coordinator.beforeRequest({ ...options, sessionId }),
    async reconcile(options) {
      if (closed) throw fault('CONTEXT_MAINTENANCE_CLOSING', 'Context maintenance is closing');
      busy++;
      const task = coordinator.reconcile({ ...options, sessionId });
      recoveries.add(task);
      try { return await task; } finally { recoveries.delete(task); busy--; }
    },
    isBusy: () => busy > 0,
    compactNow: signal => engine.compactNow(agent, signal),
    status: () => coordinator.status({ sessionId }),
    close() {
      if (closeTask) return closeTask;
      closed = true;
      lastPlannedPayload = undefined;
      closeTask = (async () => {
        const errors = [];
        try { await unregister(); } catch (error) { errors.push(error); }
        // Reconcile failures are delivered to their own callers; teardown only
        // joins those in-flight operations and must not report them twice.
        await Promise.allSettled([...interceptions, ...recoveries]);
        try { store.close(); } catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'Context maintenance cleanup failed.');
        log?.debug?.('Session context maintenance unmounted', { sessionId });
      })();
      return closeTask;
    },
  });
}
