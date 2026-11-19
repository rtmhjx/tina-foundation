import { createHash } from 'node:crypto';
import { createHostPresentation, HOST_INPUT, HOST_INPUT_SETTLED, HOST_WORLD_SPEECH, HOST_ROUTE_LEASE } from './host-projection.mjs';

function error(code, message) { return Object.assign(new Error(message ?? code), { code }); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function inputIdentity(sessionId, request) {
  return 'host-input:' + digest({ sessionId, requestId: request.requestId });
}

/** Own exactly one native Session's prompt and presentation extension points.
 * The activation gate is acquired before app construction; no second AgentLoop is created.
 */
export async function mountHostRouting(ctx, { sessionId, onInput } = {}) {
  const controller = ctx.sessionController;
  if (controller?.hostRoutingVersion !== 1 || typeof controller.registerPromptRoute !== 'function' ||
      typeof controller.registerHistoryPresentation !== 'function') {
    throw error('HOST_ROUTING_UNSUPPORTED', 'The host needs the reviewed session routing source extension v1.');
  }
  if (typeof onInput !== 'function') throw error('HOST_INPUT_HANDLER_REQUIRED');
  const session = ctx.sessions?.get(sessionId) ?? ctx.agents?.get(sessionId)?.session;
  if (!session || typeof session.snapshotEvents !== 'function' || typeof session.appendExternal !== 'function' || session.externalEventVersion !== 1) {
    throw error('HOST_SESSION_NOT_FOUND', 'The selected existing native Session is unavailable.');
  }
  const cutoff = Number(session.seq);
  const leaseId = 'host-route:' + digest({ sessionId, cutoff, time: Date.now() });
  const flush = async () => {
    if (typeof ctx.sessions.flush === 'function') {
      if (!await ctx.sessions.flush(session)) throw error('HOST_DURABILITY_FAILED');
    } else if (typeof ctx.parallel === 'function') await ctx.parallel('session/flush', session);
    else throw error('HOST_DURABILITY_UNSUPPORTED');
  };
  const priorInputs = new Map();
  const settled = new Set();
  const speechIds = new Map();
  for (const row of session.snapshotEvents()) {
    if (row.type === HOST_INPUT) priorInputs.set(row.data.requestId, row.data);
    if (row.type === HOST_INPUT_SETTLED) settled.add(row.data.eventId);
    if (row.type === HOST_WORLD_SPEECH) speechIds.set(row.data.id, row.data);
  }
  let state = 'held';
  let ingressClosed = false;
  let accepted = 0;
  let duplicates = 0;
  let resolveActivation;
  let rejectActivation;
  const activation = new Promise((resolve, reject) => { resolveActivation = resolve; rejectActivation = reject; });
  // Startup may fail before a prompt arrives; the held gate must never create an unhandled rejection.
  activation.catch(() => {});
  const inflight = new Set();
  const inputInflight = new Set();
  let inputTail = Promise.resolve();
  let speechTail = Promise.resolve();
  const unsettledSpeech = new Set();
  const presentation = createHostPresentation({ session, cutoff });

  async function deliver(call) {
    if (ingressClosed || state === 'disposing' || state === 'disposed') throw error('HOST_ROUTE_DISPOSING');
    await activation;
    if (ingressClosed || state !== 'active') throw error('HOST_ROUTE_DISPOSING');
    const { request, message, agent } = call;
    if (String(agent.session.id) !== String(sessionId)) throw error('HOST_ROUTE_SESSION_MISMATCH');
    if (typeof request.requestId !== 'string' || !request.requestId) throw error('HOST_REQUEST_ID_REQUIRED');
    const bodyHash = digest({ content: request.content, mode: request.mode ?? 'followup',
      clientTimeZone: request.clientTimeZone });
    const old = priorInputs.get(request.requestId);
    if (old) {
      if (old.bodyHash !== bodyHash) throw error('HOST_REQUEST_CONFLICT', 'A request id was reused with different content.');
      if (!settled.has(old.eventId)) throw error('HOST_INPUT_UNSETTLED',
        'A durable input has no settlement receipt; review its World delivery before retrying.');
      duplicates++;
      return;
    }
    const eventId = inputIdentity(sessionId, request);
    const payload = { eventId, requestId: request.requestId, sessionId,
      content: structuredClone(message.content), message: structuredClone(message),
      mode: request.mode ?? 'followup',
      ...(request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone }) };
    const recorded = { ...payload, bodyHash };
    session.appendExternal(HOST_INPUT, recorded);
    priorInputs.set(request.requestId, recorded);
    await flush();
    // A failed callback is deliberately not marked settled or replayed automatically.
    await onInput(payload);
    session.appendExternal(HOST_INPUT_SETTLED, { sessionId, eventId, requestId: request.requestId });
    await flush();
    settled.add(eventId);
    accepted++;
  }

  function route(call) {
    if (ingressClosed || state === 'disposing' || state === 'disposed') return Promise.reject(error('HOST_ROUTE_DISPOSING'));
    const pending = inputTail.then(() => deliver(call));
    inputTail = pending.catch(() => {});
    inflight.add(pending);
    inputInflight.add(pending);
    pending.then(() => { inflight.delete(pending); inputInflight.delete(pending); },
      () => { inflight.delete(pending); inputInflight.delete(pending); });
    return pending;
  }

  let unroute;
  let unpresent;
  try {
    unroute = controller.registerPromptRoute(sessionId, route);
    unpresent = controller.registerHistoryPresentation(sessionId, presentation);
    session.appendExternal(HOST_ROUTE_LEASE, { leaseId, sessionId, state: 'opened', cutoff });
  } catch (cause) {
    unpresent?.();
    unroute?.();
    rejectActivation(cause);
    throw cause;
  }
  let disposal;
  const handle = {
    sessionId,
    projection: presentation,
    activate() {
      if (state === 'active') return;
      if (ingressClosed || state !== 'held') throw error('HOST_ROUTE_DISPOSING');
      state = 'active';
      resolveActivation();
    },
    sendSpeech({ id, text, worldId = 'host-chat', provenance = {} } = {}) {
      if (state !== 'active') return Promise.reject(error('HOST_ROUTE_NOT_ACTIVE'));
      const pending = speechTail.then(async () => {
        if (typeof text !== 'string' || !text.trim()) throw error('HOST_SPEECH_EMPTY');
        if (id !== undefined && (typeof id !== 'string' || !id)) throw error('HOST_SPEECH_ID_INVALID');
        if (typeof worldId !== 'string' || !worldId) throw error('HOST_SPEECH_WORLD_INVALID');
        const identity = id ?? 'world-speech:' + digest({ sessionId, worldId, seq: session.seq, text });
        const data = { id: identity, sessionId, worldId, text, origin: 'world-action', provenance: structuredClone(provenance) };
        const old = speechIds.get(identity);
        if (old) {
          if (digest(old) !== digest(data)) throw error('HOST_SPEECH_CONFLICT');
          if (unsettledSpeech.has(identity)) throw error('HOST_SPEECH_UNSETTLED');
          return { id: identity, duplicate: true };
        }
        const row = session.appendExternal(HOST_WORLD_SPEECH, data);
        speechIds.set(identity, data);
        unsettledSpeech.add(identity);
        await flush();
        unsettledSpeech.delete(identity);
        return { id: identity, seq: row?.seq ?? Number(session.seq) - 1, duplicate: false };
      });
      speechTail = pending.catch(() => {});
      inflight.add(pending);
      pending.then(() => inflight.delete(pending), () => inflight.delete(pending));
      return pending;
    },
    snapshot() {
      return { state, ingress: ingressClosed ? 'closed' : 'open', sessionId, cutoff, accepted, duplicates, inflight: inflight.size,
        pending: [...priorInputs.values()].filter(row => !settled.has(row.eventId)).map(row => ({
          eventId: row.eventId, requestId: row.requestId })),
        speechCount: speechIds.size };
    },
    readInternal(seq) { return session.snapshotEvents()[seq]; },
    async prepareDispose() {
      ingressClosed = true;
      if (state === 'held') rejectActivation(error('HOST_ROUTE_STARTUP_ABORTED'));
      await Promise.allSettled([...inputInflight]);
    },
    dispose() {
      if (disposal) return disposal;
      ingressClosed = true;
      state = 'disposing';
      rejectActivation(error('HOST_ROUTE_STARTUP_ABORTED'));
      disposal = (async () => {
        await Promise.allSettled([...inflight]);
        session.appendExternal(HOST_ROUTE_LEASE, { leaseId, sessionId, state: 'closed', cutoff });
        try { await flush(); }
        finally {
          await unpresent?.();
          await unroute?.();
          state = 'disposed';
        }
      })();
      return disposal;
    },
  };
  return handle;
}
