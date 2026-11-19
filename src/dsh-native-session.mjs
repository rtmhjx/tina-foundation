import { randomUUID } from 'node:crypto';

export const name = 'tina-dsh-native-session';
export const inject = ['sessionController', 'sessions', 'systemPrompt'];
const textOf = message => (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(value);
const failureCode = (error, fallback) => typeof error?.code === 'string'
  && /^[a-z\d/_-]{1,80}$/i.test(error.code) ? error.code : fallback;
const taskError = (code, identity) => Object.assign(new Error('Native DSH operation failed (' + code + ').'), { code, ...identity });
function notify(callback, value) { try { callback(value); } catch { /* An observer does not own execution. */ } }
function send(message) { if (process.connected) process.send(message, () => {}); }

/**
 * Native admission, public progress and terminal receipts. Observation signals
 * and timeouts only detach their observer. cancel() requests native cancellation,
 * while the actual turn/end event remains the terminal authority.
 */
export function createNativeSessionService(ctx, { workspaceDir, tinaMode, editablePersona, retainedOperations = 256 } = {}) {
  if (!Number.isSafeInteger(retainedOperations) || retainedOperations < 1) throw new Error('Invalid operation retention.');
  const operations = new Map();
  const listeners = new Set();
  let closed = false;
  const keyOf = ({ sessionId, requestId }) => sessionId + '\0' + requestId;
  const identityOf = op => ({ sessionId: op.sessionId, requestId: op.requestId,
    ...(op.turn === undefined ? {} : { turnId: op.turn }),
    ...(op.attemptId === undefined ? {} : { attemptId: op.attemptId }) });
  const snapshot = op => ({ ...identityOf(op), state: op.state, text: op.text,
    ...(op.code === undefined ? {} : { code: op.code }),
    ...(op.reason === undefined ? {} : { reason: op.reason }),
    ...(op.toolCallId === undefined ? {} : { toolCallId: op.toolCallId }) });
  function emit(op, event) {
    const frame = { ...identityOf(op), ...event };
    for (const entry of listeners) {
      if (entry.sessionId !== undefined && entry.sessionId !== op.sessionId) continue;
      if (entry.requestId !== undefined && entry.requestId !== op.requestId) continue;
      notify(entry.onEvent, frame);
    }
  }
  function state(op, value) {
    op.state = value;
    emit(op, { type: 'state', ...snapshot(op) });
  }
  function finish(op, result) {
    if (op.settling) return;
    op.settling = true;
    void Promise.resolve().then(async () => {
      if (result.turn !== undefined || op.messageId !== undefined) {
        try {
          const session = ctx.sessions.get(op.sessionId);
          if (!session || !await ctx.sessions.flush(session)) result = { ...result, code: 'DSH_RECEIPT_NOT_PERSISTED' };
        } catch { result = { ...result, code: 'DSH_RECEIPT_NOT_PERSISTED' }; }
      }
      op.code = result.code;
      op.reason = result.reason;
      state(op, result.code === undefined ? 'completed'
        : result.reason?.kind === 'aborted' || result.code === 'DSH_QUEUE_CANCELLED' ? 'cancelled'
          : result.code === 'DSH_STOPPED' || result.code === 'DSH_RECEIPT_NOT_PERSISTED' ? 'unknown' : 'failed');
      op.outcome.resolve({ sessionId: op.sessionId, requestId: op.requestId, text: op.text, ...result });
      const retained = [...operations.entries()].filter(([, entry]) => entry.sessionId === op.sessionId
        && ['completed', 'cancelled', 'failed', 'unknown'].includes(entry.state));
      for (const [key] of retained.slice(0, Math.max(0, retained.length - retainedOperations))) operations.delete(key);
    });
  }
  function applyEvent(op, event) {
    if (op.settling) return;
    const { data } = event;
    if (event.type === 'turn/start') op.currentTurn = data.turn;
    if (event.type === 'agent/inbox/spliced') {
      const message = data.inserted?.find(message => message.source?.kind === 'user' && message.source.rpcId === op.requestId);
      if (message) { op.messageId = message.id; state(op, 'queued'); }
    }
    if (event.type === 'user/message' && data.source?.kind === 'user' && data.source.rpcId === op.requestId) {
      if (textOf(data) !== op.prompt) return finish(op, { code: 'REQUEST_ID_CONFLICT' });
      op.turn = op.currentTurn;
      op.messageId = data.id;
      state(op, 'running');
    }
    if (op.turn === undefined || data.turn !== op.turn) return;
    if (event.type === 'assistant/message') {
      if (!data.interrupted) op.text = textOf(data.message);
      emit(op, { type: 'assistant', text: textOf(data.message), interrupted: data.interrupted === true,
        seq: event.seq, step: data.step });
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      op.toolCallId = data.callId ?? data.message?.callId ?? data.id;
      state(op, event.type === 'tool/call' ? 'tool-running' : op.cancelRequested ? 'cancel-requested' : 'running');
      emit(op, { type: event.type, data, seq: event.seq });
    }
    if (event.type === 'turn/end') {
      emit(op, { type: 'turn/end', reason: data.reason, seq: event.seq });
      finish(op, data.reason?.kind === 'completed' ? { turn: op.turn, reason: data.reason }
        : { turn: op.turn, reason: data.reason,
          code: failureCode(data.reason?.error, failureCode({ code: data.reason?.kind }, 'DSH_TURN_FAILED')) });
    }
  }
  if (tinaMode) ctx.systemPrompt.section({
    name: 'tina:interaction', order: 6000,
    text: (editablePersona ? '' : 'You are Tina. Converse naturally and keep role-play in the conversation. ')
      + 'Use real machine actions only for explicit authorized work requests. '
      + 'Keep native tool permissions and approvals in force, and distinguish completed actions from plans.',
  });
  ctx.on('session/event', (session, event) => {
    for (const op of operations.values()) if (op.sessionId === session.id) applyEvent(op, event);
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    for (const op of operations.values()) {
      if (op.sessionId !== agent.id || op.settling || op.turn === undefined) continue;
      if (frame.type === 'start' && frame.turn === op.turn) {
        op.attemptId = frame.attemptId; op.partialText = '';
        emit(op, { type: 'stream/start', step: frame.step, revision: frame.revision });
      }
      if (frame.attemptId !== op.attemptId) continue;
      if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
        op.partialText += frame.chunk.text;
        emit(op, { type: 'stream/delta', text: frame.chunk.text, revision: frame.revision, index: frame.index });
      }
      if (frame.type === 'end') emit(op, { type: 'stream/end', outcome: frame.outcome, revision: frame.revision });
    }
  });
  function observe({ sessionId, requestId, onEvent, signal, replay = true } = {}) {
    if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function.');
    signal?.throwIfAborted();
    const entry = { sessionId, requestId, onEvent };
    const unsubscribe = () => { listeners.delete(entry); signal?.removeEventListener('abort', unsubscribe); };
    listeners.add(entry);
    signal?.addEventListener('abort', unsubscribe, { once: true });
    if (replay) for (const op of operations.values()) {
      if (sessionId !== undefined && sessionId !== op.sessionId) continue;
      if (requestId !== undefined && requestId !== op.requestId) continue;
      notify(onEvent, { type: 'state', ...snapshot(op), partialText: op.partialText ?? '' });
    }
    return unsubscribe;
  }
  function operation(input) {
    if (closed) throw taskError('DSH_STOPPED');
    input.signal?.throwIfAborted();
    const { sessionId, requestId = randomUUID(), text, content, mode = 'queue' } = input;
    if (!validId(sessionId) || !validId(requestId)) throw new Error('Invalid DSH session or request identity.');
    const blocks = content ?? [{ type: 'text', text }];
    if (!Array.isArray(blocks) || !blocks.length || blocks.some(block => !block || typeof block.type !== 'string'
      || (block.type === 'text' && typeof block.text !== 'string'))) throw new Error('Invalid DSH prompt content.');
    const prompt = textOf({ content: blocks });
    if (prompt.length > 65_536 || (!prompt.trim() && blocks.every(block => block.type === 'text'))) {
      throw new Error('Invalid DSH prompt content.');
    }
    if (mode !== 'queue' && mode !== 'steer') throw new Error('Invalid DSH delivery mode.');
    const identity = JSON.stringify({ content: blocks, mode });
    const key = keyOf({ sessionId, requestId });
    let op = operations.get(key);
    if (op) {
      if (op.identity !== identity) throw taskError('REQUEST_ID_CONFLICT', { sessionId, requestId });
      return op;
    }
    op = { sessionId, requestId, prompt, identity, state: 'admitting', text: '', settling: false,
      outcome: Promise.withResolvers() };
    operations.set(key, op);
    op.admission = Promise.resolve().then(async () => {
      await ctx.sessionController.create({ sessionId, cwd: workspaceDir });
      for (const event of ctx.sessions.get(sessionId)?.snapshotEvents() ?? []) applyEvent(op, event);
      if (!op.settling && op.turn === undefined && op.messageId === undefined) {
        await ctx.sessionController.prompt({ sessionId, requestId, mode, content: blocks }, new AbortController().signal);
      }
      if (!op.settling && op.state === 'admitting') state(op, 'queued');
      return { sessionId, requestId, accepted: true };
    }).catch(error => { finish(op, { code: failureCode(error, 'DSH_ADMISSION_FAILED') }); throw error; });
    void op.admission.catch(() => {});
    return op;
  }
  function status({ sessionId, requestId } = {}) {
    if (requestId !== undefined) {
      const op = operations.get(keyOf({ sessionId, requestId }));
      return op && { ...snapshot(op), partialText: op.partialText ?? '' };
    }
    return [...operations.values()].filter(op => sessionId === undefined || sessionId === op.sessionId)
      .map(op => ({ ...snapshot(op), partialText: op.partialText ?? '' }));
  }
  async function wait({ sessionId, requestId, signal, timeoutMs } = {}) {
    signal?.throwIfAborted();
    const op = operations.get(keyOf({ sessionId, requestId }));
    if (!op) throw taskError('REQUEST_NOT_FOUND', { sessionId, requestId });
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new Error('Invalid DSH observation timeout.');
    const result = await new Promise((resolve, reject) => {
      let timer;
      const finishWait = (error, value) => {
        clearTimeout(timer); signal?.removeEventListener('abort', detached);
        if (error) reject(error); else resolve(value);
      };
      const detached = () => finishWait(signal.reason ?? taskError('DSH_OBSERVER_DETACHED'));
      signal?.addEventListener('abort', detached, { once: true });
      if (signal?.aborted) detached();
      if (timeoutMs !== undefined) timer = setTimeout(() => finishWait(taskError('DSH_OBSERVATION_TIMEOUT',
        { sessionId, requestId, executionContinues: !op.settling })), timeoutMs);
      void op.outcome.promise.then(value => finishWait(undefined, value));
    });
    if (result.code) throw Object.assign(taskError(result.code, { sessionId, requestId }), { result });
    return { sessionId, requestId, turn: result.turn, text: result.text };
  }
  async function sendText(input) {
    input.signal?.throwIfAborted();
    const op = operation(input);
    const unsubscribe = observe({ sessionId: op.sessionId, requestId: op.requestId, replay: false, signal: input.signal,
      onEvent(frame) {
        if (frame.type === 'stream/delta' && typeof input.onDelta === 'function') input.onDelta(frame.text, frame);
        if (typeof input.onEvent === 'function') input.onEvent(frame);
      } });
    try { return await wait({ sessionId: op.sessionId, requestId: op.requestId, signal: input.signal, timeoutMs: input.timeoutMs }); }
    finally { unsubscribe(); }
  }
  async function cancel({ sessionId, requestId } = {}) {
    if (!validId(sessionId)) throw new Error('Invalid DSH session identity.');
    const op = requestId === undefined ? undefined : operations.get(keyOf({ sessionId, requestId }));
    if (requestId !== undefined && !op) throw taskError('REQUEST_NOT_FOUND', { sessionId, requestId });
    if (op?.settling) return { accepted: true, terminal: true, ...snapshot(op) };
    if (op) await op.admission;
    if (op?.settling) return { accepted: true, terminal: true, ...snapshot(op) };
    if (op && op.turn === undefined) {
      if (!op.messageId) throw taskError('DSH_QUEUE_NOT_OBSERVED', { sessionId, requestId });
      await ctx.sessionController.updateQueue({ sessionId, itemId: op.messageId, action: { kind: 'remove' } });
      finish(op, { code: 'DSH_QUEUE_CANCELLED' });
    } else {
      await ctx.sessionController.cancel({ sessionId });
      for (const active of operations.values()) if (active.sessionId === sessionId && !active.settling && active.turn !== undefined) {
        active.cancelRequested = true; state(active, 'cancel-requested');
      }
    }
    return { accepted: true, terminal: false, sessionId, ...(requestId === undefined ? {} : { requestId }) };
  }
  ctx.effect(() => () => {
    closed = true;
    for (const op of operations.values()) if (!op.settling) finish(op, { code: 'DSH_STOPPED' });
    listeners.clear();
  });
  return Object.freeze({ sendText, submit: input => operation(input).admission,
    observe, subscribe: onEvent => observe({ onEvent }), status, wait, cancel });
}

export function apply(ctx, config) {
  const service = createNativeSessionService(ctx, config);
  if (config.embedded) { ctx.provide('tinaDshSession', service); return; }
  ctx.effect(() => {
    const onMessage = message => {
      if (message?.type !== 'tina-dsh:prompt') return;
      const { id, stream } = message;
      void service.sendText({ ...message,
        ...(stream && { onDelta: text => send({ type: 'tina-dsh:delta', id, text }) }),
      }).then(result => send({ type: 'tina-dsh:result', id, ...result }),
        error => send({ type: 'tina-dsh:result', id, code: failureCode(error, 'DSH_ADMISSION_FAILED') }));
    };
    process.on('message', onMessage);
    return () => process.off('message', onMessage);
  });
  send({ type: 'tina-dsh:session-ready' });
}
