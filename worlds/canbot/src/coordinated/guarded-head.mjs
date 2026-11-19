// Candidate entry point for the existing HeadChannel.captureOnce implementation.
// A separate guard is held before status and reserved immediately before POST.
// This module does not open a connection until guardedCapture is called.
export async function guardedCapture({ head, guardFactory, kind, signal, durationMs, cue = false }) {
  if (!head || typeof head.captureOnce !== 'function' || typeof head.request !== 'function' || typeof guardFactory !== 'function') throw Error('guarded_capture_ports_required');
  if (!['tone', 'microphone', 'photo', 'video'].includes(kind)) throw Error('media_kind_invalid');
  const guard = guardFactory(); let operation = null;
  const proxy = Object.create(head);
  proxy.request = async (channel, path, options = {}) => {
    if (channel === 'media' && path === `/v1/${kind}` && options.method === 'POST') {
      if (operation) throw Error('duplicate_media_submission');
      const b = options.body;
      if (!b || typeof b.operationId !== 'string' || typeof b.instanceId !== 'string' || !Number.isSafeInteger(b.sequence)) throw Error('media_identity_invalid');
      operation = { operationId: b.operationId, instanceId: b.instanceId, sequence: b.sequence, kind };
      await guard.reserve(operation); // durable latch before the only POST
    }
    return head.request(channel, path, options);
  };
  try {
    await guard.lock();
    const value = await head.captureOnce.call(proxy, kind, signal, durationMs, cue);
    const r = value?.receipt;
    if (!operation || r?.operationId !== operation.operationId || r?.sequence !== operation.sequence || r?.kind !== kind || r?.settled !== true || r?.state !== 'complete') throw Error('media_receipt_unconfirmed');
    const live = await head.request('media', '/v1/status', { signal });
    if (live.instanceId !== operation.instanceId || live.activeOperation !== null) throw Error('media_generation_or_settlement_unknown');
    await guard.settle(operation.operationId, 'completed');
    // Settlement acknowledgement precedes child exit and flock release.
    if (typeof guard.waitReleased !== 'function' || await guard.waitReleased() !== true) throw Error('guard_release_unknown');
    return { state: 'completed', settled: true, guardReleased: true, value };
  } catch (error) {
    guard.releaseUnknown?.();
    throw error;
  }
}
