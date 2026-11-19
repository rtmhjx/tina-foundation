/** A terminal abort/error is a failed acceptance, never an endlessly pending turn. */
export function phaseTurnTerminal(events, startSeq) {
  const ends = events.filter(event => event.seq > startSeq && event.type === 'turn/end');
  const failed = ends.find(event => event.data.reason?.kind !== 'completed');
  if (failed) throw Object.assign(new Error('Native acceptance turn ended with ' + (failed.data.reason?.kind ?? 'unknown') + '.'), {
    code: 'ACCEPTANCE_NATIVE_TERMINAL', nativeSeq: failed.seq, reason: failed.data.reason?.kind ?? 'unknown',
  });
  return ends.at(-1) ?? null;
}
