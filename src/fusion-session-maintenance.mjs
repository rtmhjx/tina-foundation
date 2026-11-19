import { decodeWorldInput } from './fusion-input-delivery.mjs';

function maintenanceError(code, text, cause) {
  return Object.assign(new Error(text, cause ? { cause } : undefined), { code });
}

/** Translate native World-read receipts into Cortico's standard event-frame
 * view for Persona handoff policies. This changes a temporary snapshot only.
 * The native authoritative request/log and WebUI projection remain unchanged.
 */
export function prepareHandoffSnapshot(records, nativeSession) {
  const snapshot = structuredClone(records);
  const pulls = new Map();
  for (const entry of snapshot) {
    const source = nativeSession?.eventAt(entry.context.nativeSeq)?.data;
    const plugin = (source?.message ?? source)?.source?.plugin;
    if (['cortico-native-maintenance', 'cortico-native-handoff'].includes(plugin)) entry.context.ephemeral = true;
    const input = decodeWorldInput(source?.message ?? source);
    if (input && entry.item.type === 'message' && entry.item.role === 'user') {
      // Legacy Personas consume the existing event-frame view. This temporary
      // projection drops transport wording, while context.native keeps the
      // complete authoritative event and its unchanged sequence/provenance.
      entry.item.content = [{ type: 'input_text', text: input.text }];
      entry.context.frame = { events: [{ cursor: input.cursor, ts: input.ts, type: input.type,
        source: input.source, start: 0, chars: input.text.length,
        ...(Array.isArray(input.tags) ? { tags: input.tags } : {}) }] };
    }
    if (entry.item.type === 'function_call' && ['cortico_world_events', 'cortico_world_read'].includes(entry.item.name)) {
      pulls.set(entry.item.call_id, entry);
    }
    if (entry.item.type !== 'function_call_output' || !pulls.has(entry.item.call_id)) continue;
    let value;
    try { value = JSON.parse(entry.item.output); } catch { continue; }
    const events = Array.isArray(value?.events) ? value.events : Number.isSafeInteger(value?.cursor) ? [value] : undefined;
    if (!events) continue;
    const references = [];
    let text = '';
    for (const event of events) {
      if (typeof event?.text !== 'string') continue;
      if (text) text += '\n';
      references.push({ cursor: event.cursor, ts: event.ts, type: event.type, source: event.source,
        start: text.length, chars: event.text.length, ...(event.tags ? { tags: event.tags } : {}) });
      text += event.text;
    }
    pulls.get(entry.item.call_id).item.name = 'external_event_frame';
    entry.item.output = text;
    entry.context.frame = { events: references };
  }
  return snapshot;
}

/** A retained tail must select complete existing native nodes without editing
 * or reordering their content. Other Persona representations need an explicit
 * import/summary extension rather than a fabricated assistant execution.
 */
export function nativeTailSelection(snapshot, tail) {
  if (!Array.isArray(tail)) throw maintenanceError('HANDOFF_TAIL_UNREPRESENTABLE', 'Persona onHandoff must return tail=[]/null or existing native records.');
  const originals = new Map(snapshot.map(record => [record.item.id, record]));
  const selected = new Set();
  const ids = new Set();
  let last = -1;
  for (const record of tail) {
    const original = originals.get(record?.item?.id);
    const index = snapshot.indexOf(original);
    if (!original || ids.has(original.item.id) || index <= last
      || !Number.isSafeInteger(original.context.nativeSeq)
      || JSON.stringify(original.item) !== JSON.stringify(record.item)
      || original.item.role === 'system') {
      throw maintenanceError('HANDOFF_TAIL_UNREPRESENTABLE', 'Retain unchanged native item IDs in their original order, or return tail=null for Core compaction. Synthetic tail import requires an explicit native summary extension.');
    }
    ids.add(original.item.id);
    selected.add(original.context.nativeSeq);
    last = index;
  }
  for (const record of snapshot) if (selected.has(record.context.nativeSeq) && !ids.has(record.item.id)) {
    throw maintenanceError('HANDOFF_TAIL_UNREPRESENTABLE', 'A retained native node contains several records; retain all of its records together.');
  }
  return [...selected];
}

/**
 * Clear only the derived native conversation surface. Native trace, Worlds,
 * archives, settings and Memory are untouched. The plugin-authored marker cites
 * every shadowed surface node, so the original SDK can replay and validate it.
 *
 * System messages are execution records requiring an open native step. This
 * idle operation deliberately preserves the system head rather than forging a
 * system/message event with an old turn/step.
 */
export async function clearNativeSession(ctx, {
  sessionId, signal, retainedSeqs = [], reason = 'clear',
  markerText = 'The operator cleared the active conversation context. Earlier conversation trace, archived World events and persistent Memory remain preserved. Continue from new World events.',
} = {}) {
  signal?.throwIfAborted();
  const agent = ctx.agents.get(sessionId);
  if (!agent) throw maintenanceError('NATIVE_SESSION_UNAVAILABLE', 'Native session is unavailable.');
  if (agent.status !== 'idle') throw maintenanceError('NATIVE_SESSION_BUSY', 'Wait for the current native task to finish before clearing the conversation.');
  const { createUserMessage } = await ctx.loader.import('@deepseek-ai/dsh-llm');
  signal?.throwIfAborted();
  try {
    return await agent.runMaintenance(async nativeSignal => {
      const taskSignal = signal ? AbortSignal.any([signal, nativeSignal]) : nativeSignal;
      taskSignal.throwIfAborted();
      const session = agent.session;
      const nodes = [...session.surface.nodes];
      if (nodes.length === 0) {
        if (!await ctx.sessions.flush(session)) throw maintenanceError('NATIVE_MAINTENANCE_PERSISTENCE', 'Native session persistence was not confirmed.');
        return { cleared: true, markerSeq: null, shadowedSeqs: [], preservedSystemSeq: null, tracePreserved: true };
      }
      const head = nodes.length ? session.eventAt(nodes[0]) : undefined;
      if (head?.type !== 'system/message') {
        throw maintenanceError('NATIVE_SYSTEM_HEAD_MISSING', 'The native session has no leading system head; inspect its surface before clearing it.');
      }
      const preservedSystem = head?.type === 'system/message' ? head.seq : undefined;
      const tail = preservedSystem === undefined ? nodes : nodes.slice(1);
      const retained = new Set(retainedSeqs);
      if (retained.size !== retainedSeqs.length || retainedSeqs.some(seq => !tail.includes(seq))
        || retainedSeqs.some((seq, index) => index > 0 && tail.indexOf(seq) <= tail.indexOf(retainedSeqs[index - 1]))) {
        throw maintenanceError('HANDOFF_TAIL_UNREPRESENTABLE', 'Retained native nodes must be existing surface nodes in their original order.');
      }
      const calls = new Set();
      const results = new Set();
      for (const seq of retainedSeqs) {
        const event = session.eventAt(seq);
        if (event.type === 'system/message') throw maintenanceError('HANDOFF_TAIL_UNREPRESENTABLE', 'A Persona tail cannot retain a system node as conversation content.');
        for (const block of event.data.message?.content ?? event.data.content ?? []) {
          if (block.type === 'tool-call') calls.add(block.id ?? block.toolCallId);
          if (block.type === 'tool-result') results.add(block.toolCallId);
        }
      }
      if ([...calls].some(id => !results.has(id)) || [...results].some(id => !calls.has(id))) {
        throw maintenanceError('HANDOFF_TOOL_PAIRING', 'Retain complete native tool call/result pairs or return tail=null for Core compaction.');
      }
      const ranges = [];
      for (const seq of tail) {
        if (retained.has(seq)) continue;
        const previous = ranges.at(-1);
        const previousIndex = previous?.length ? tail.indexOf(previous.at(-1)) : -2;
        if (previous && previousIndex + 1 === tail.indexOf(seq)) previous.push(seq);
        else ranges.push([seq]);
      }
      const markerSeqs = [];
      const shadowedSeqs = ranges.flat();
      if (!tail.length) ranges.push([]);
      for (const range of ranges) {
        const marker = createUserMessage({
          source: { kind: 'plugin', plugin: reason === 'handoff' ? 'cortico-native-handoff' : 'cortico-native-maintenance' },
          content: [{ type: 'text', text: markerText }],
        });
        const placement = range.length
          ? { surfaceOp: { op: 'replace', startSeq: range[0], endSeq: range.at(-1) }, sourceEventSeqs: range }
          : { surfaceOp: 'append' };
        markerSeqs.push(session.append('user/message', marker, placement).seq);
      }
      if (!await ctx.sessions.flush(session)) {
        throw maintenanceError('NATIVE_MAINTENANCE_PERSISTENCE', 'Conversation surface changed, but native persistence was not confirmed. Inspect its state before retrying.');
      }
      return {
        cleared: retained.size === 0, markerSeq: markerSeqs.at(-1) ?? null, markerSeqs, shadowedSeqs, retainedSeqs,
        preservedSystemSeq: preservedSystem ?? null, tracePreserved: true,
      };
    });
  } catch (error) {
    if (error?.code) throw error;
    if (agent.status !== 'idle' || /already has active work/.test(error?.message ?? '')) {
      throw maintenanceError('NATIVE_SESSION_BUSY', 'The native session became busy before maintenance could start.', error);
    }
    throw error;
  }
}
