import { createHash } from 'node:crypto';
import { fixPairing, validatePairing } from '../upstream/cortico/src/core/truncate.ts';
import { nativeMessages } from './fusion-provider.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = code => Object.assign(new Error(code), { code });

function checkItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw failure('SESSION_HEAD_INVALID_ITEM');
  if (item.type === 'message') {
    if (!['user', 'assistant', 'system', 'developer'].includes(item.role)
      || (typeof item.content !== 'string' && !Array.isArray(item.content))) throw failure('SESSION_HEAD_INVALID_MESSAGE');
  } else if (item.type === 'function_call') {
    if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name
      || typeof item.arguments !== 'string') throw failure('SESSION_HEAD_INVALID_CALL');
  } else if (item.type === 'function_call_output') {
    if (typeof item.call_id !== 'string' || !item.call_id
      || (typeof item.output !== 'string' && !Array.isArray(item.output))) throw failure('SESSION_HEAD_INVALID_RESULT');
  } else if (item.type === 'reasoning') {
    if (!Array.isArray(item.content) && !Array.isArray(item.summary)) throw failure('SESSION_HEAD_INVALID_REASONING');
  } else throw failure('SESSION_HEAD_UNSUPPORTED_ITEM');
}

/** One normalized, request-only Persona view shared by native assembly and UI. */
export function normalizePersonaSessionHead(getHead, log, { namespace = 'persona' } = {}) {
  try {
    const items = getHead?.() ?? [];
    if (!Array.isArray(items)) throw failure('SESSION_HEAD_INVALID_RETURN');
    const kept = [];
    let dropped = 0;
    for (const raw of items) {
      // Discard privileged roles before considering their body. Even malformed
      // system/developer entries cannot enter this lower-authority interface.
      if (raw?.type === 'message' && ['system', 'developer'].includes(raw.role)) { dropped++; continue; }
      checkItem(raw);
      kept.push({ version: 2, item: structuredClone(raw), context: { head: true } });
    }
    if (dropped) log?.warn('Privileged roles were omitted from the Persona session head.', { dropped });
    const paired = fixPairing(kept);
    if (validatePairing(paired).length) throw failure('SESSION_HEAD_INVALID_PAIRING');
    return paired.map((entry, index) => {
      const { id: _id, ...raw } = entry.item;
      // Example call ids occupy their own deterministic namespace so they do
      // not collide with real calls later retained in the native surface.
      const semantic = 'call_id' in raw ? { ...raw, call_id: 'head_call_' + digest([namespace, raw.call_id]) } : raw;
      return { version: 2, item: { ...semantic, id: 'head_' + digest([index, semantic]) }, context: { head: true } };
    });
  } catch (error) {
    // Hook failures and malformed examples isolate this optional provider.
    // Error text can include private Persona material and is not logged.
    log?.warn('Persona session head is unavailable for this request.', {
      code: typeof error?.code === 'string' ? error.code : 'SESSION_HEAD_READ_FAILED',
    });
    return [];
  }
}

/** Attach one Persona-owned, request-only contribution to native assembly. */
export async function mountFusionSessionHead(ctx, { sessionId, ownerId, getHead, log } = {}) {
  if (typeof sessionId !== 'string' || !sessionId || typeof ownerId !== 'string' || !ownerId
    || typeof getHead !== 'function') throw new Error('A Persona session head requires session identity, owner and a reader.');
  const native = await ctx.loader.import('@deepseek-ai/dsh-llm');
  const loop = ctx.get('agentLoop');
  if (typeof loop?.registerRequestHead !== 'function') throw failure('NATIVE_SESSION_HEAD_UNAVAILABLE');
  const id = 'cortico-session-head/' + ownerId;
  let disposed = false;
  const records = () => disposed ? [] : normalizePersonaSessionHead(getHead, log, { namespace: id });
  const unregister = loop.registerRequestHead({
    id, sessionId,
    currentRevision: () => digest(records()),
    async provide({ signal, preparedCall }) {
      signal.throwIfAborted();
      const head = records();
      const revision = digest(head);
      try {
        // Persona examples have no provider replay provenance. Encrypted
        // reasoning cannot be converted into an invented native response.
        if (head.some(entry => entry.item.type === 'reasoning' && entry.item.encrypted_content)) {
          throw failure('SESSION_HEAD_ENCRYPTED_REASONING');
        }
        const messages = await nativeMessages(ctx, {}, { context: head, signal }, {}, preparedCall ?? {}, {
          messageSource: () => ({ kind: 'plugin', plugin: id }),
          messageId: (input, index) => 'cortico-head-' + digest([id, index, input]),
        }, native);
        signal.throwIfAborted();
        return { messages, revision };
      } catch (error) {
        signal.throwIfAborted();
        throw Object.assign(new native.LlmError('The Persona session head cannot be represented by this native model configuration.',
          'NATIVE_SESSION_HEAD_UNSUPPORTED', { cause: error }), {
          featureCode: typeof error?.code === 'string' ? error.code : 'SESSION_HEAD_CONVERSION_FAILED',
        });
      }
    },
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unregister();
  };
  ctx.effect(() => dispose);
  return Object.freeze({ id, records, dispose });
}
