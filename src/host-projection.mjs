/** A derived view of the native log. Never edits native messages or model provenance. */
export const HOST_INPUT = 'cortico/host-input';
export const HOST_INPUT_SETTLED = 'cortico/host-input-settled';
export const HOST_WORLD_SPEECH = 'cortico/host-world-speech';
export const HOST_INTERNAL = 'cortico/host-internal';
export const HOST_ROUTE_LEASE = 'cortico/host-route-lease';

export function createHostPresentation({ session, cutoff }) {
  const privateTypes = new Set(['assistant/message', 'assistant/attempt', 'assistant/live-chunk']);
  const spans = [];
  let open;
  for (const row of session.snapshotEvents()) {
    if (row.type !== HOST_ROUTE_LEASE) continue;
    if (row.data.state === 'opened') {
      if (open !== undefined) spans.push([open, row.seq - 1]);
      open = row.data.cutoff;
    }
    if (row.data.state === 'closed' && open !== undefined) {
      spans.push([open, row.seq]);
      open = undefined;
    }
  }
  if (open !== undefined) spans.push([open, cutoff - 1]);
  function owned(seq) {
    return seq >= cutoff || spans.some(([start, end]) => seq >= start && seq <= end);
  }
  function event(input) {
    if (!owned(input.seq)) return input;
    if (input.type === HOST_INPUT) {
      return { ...input, type: 'user/message', data: structuredClone(input.data.message), surfaceOp: 'append' };
    }
    if (privateTypes.has(input.type)) {
      return { type: HOST_INTERNAL, seq: input.seq, time: input.time, ignorable: true,
        data: { nativeType: input.type, nativeSeq: input.seq, sessionId: session.id } };
    }
    return input;
  }
  return {
    event,
    stream: () => null,
    baseline: ({ revision }) => ({ revision }),
    snapshot: () => session.snapshotEvents().map(row => event(structuredClone(row))),
    read: seq => {
      const row = session.snapshotEvents()[seq];
      return row === undefined ? undefined : event(structuredClone(row));
    },
  };
}
