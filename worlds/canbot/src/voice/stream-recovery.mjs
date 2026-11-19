import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = async path => JSON.parse(await readFile(path, 'utf8'));

/** Recover only an already processed and durably confirmed stream. Does not
 * retranscribe, republish, issue a new recording or infer missing audio. */
export async function recoverCompletedStream({ head, stateDir, spoolRoot, guardFactory }) {
  let operation, manifest;
  try {
    operation = await json(join(stateDir, 'unsettled.json'));
    if (!UUID.test(operation.operationId ?? '') || !UUID.test(operation.instanceId ?? '') || operation.kind !== 'microphone_stream') return { recovered: false, reason: 'unsupported_or_invalid_latch' };
    const folder = join(spoolRoot, operation.operationId), outbox = join(folder, 'outbox');
    manifest = await json(join(folder, 'manifest.json'));
    const processing = await json(join(outbox, 'processing.json'));
    if (manifest.streamId !== operation.operationId || manifest.finished !== true || manifest.gap !== false
      || processing.streamId !== operation.operationId || processing.state !== 'complete'
      || manifest.finalState?.settled !== true || !Number.isSafeInteger(manifest.finalState.finalSequence)
      || manifest.ackedThrough < manifest.finalState.finalSequence) return { recovered: false, reason: 'processing_or_tail_unconfirmed' };
    for (const name of await readdir(outbox)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const event = await json(join(outbox, name));
      if (event.state !== 'confirmed' || (!Number.isSafeInteger(event.cursor) || event.cursor < 1)) return { recovered: false, reason: 'event_outcome_unknown' };
    }
  } catch { return { recovered: false, reason: 'recovery_data_unavailable' }; }
  const guard = guardFactory();
  try {
    await guard.recover(operation.operationId);
    const live = await head.request('media', '/v1/status');
    const stream = await head.request('media', `/v1/microphone-stream/${operation.operationId}`);
    const final = stream.finalSequence === null && stream.finalEmpty === true ? 0 : stream.finalSequence;
    if (live.instanceId !== operation.instanceId || live.activeOperation !== null || stream.instanceId !== operation.instanceId
      || stream.operationId !== operation.operationId || stream.settled !== true || stream.state !== 'complete' || stream.gap !== null
      || !['flushed', 'empty', 'flushed_read_unknown', 'empty_read_unknown'].includes(stream.tailState)
      || final !== manifest.finalState.finalSequence || stream.lastAckSequence < final) return { recovered: false, reason: 'device_outcome_unknown' };
    await guard.settle(operation.operationId, 'completed');
    if (typeof guard.waitReleased !== 'function' || !await guard.waitReleased()) return { recovered: false, reason: 'guard_release_unknown' };
    return { recovered: true, guardReleased: true, oldStreamId: operation.operationId, newInstanceId: operation.instanceId, tailBoundaryUnknown: stream.tailBoundaryUnknown === true,
      hardwareReleaseConfirmed: false, hardwareContinuityVerified: false };
  } catch { return { recovered: false, reason: 'device_or_guard_outcome_unknown' }; }
  finally { guard.releaseUnknown?.(); }
}

/** A changed authenticated Android instance and idle new media service are
 * evidence that the prior software generation has ended. Preserve old audio,
 * outbox and an unresolved quarantine record; never replay old events. */
export async function isolateInterruptedGeneration({ head, stateDir, guardFactory }) {
  let operation;
  try {
    operation = await json(join(stateDir, 'unsettled.json'));
    if (!UUID.test(operation.operationId ?? '') || !UUID.test(operation.instanceId ?? '') || operation.kind !== 'microphone_stream') return { isolated: false, reason: 'invalid_latch' };
  } catch { return { isolated: false, reason: 'recovery_data_unavailable' }; }
  const guard = guardFactory();
  try {
    await guard.recover(operation.operationId);
    const live = await head.request('media', '/v1/status');
    if (!UUID.test(live.instanceId ?? '') || live.instanceId === operation.instanceId || live.foreground !== true
      || live.activeOperation !== null || live.microphoneCapture?.supportsStream !== true) return { isolated: false, reason: 'new_generation_not_confirmed_idle' };
    await guard.quarantine(operation.operationId, live.instanceId);
    if (typeof guard.waitReleased !== 'function' || !await guard.waitReleased()) return { isolated: false, reason: 'guard_release_unknown' };
    return { isolated: true, guardReleased: true, newInstanceId: live.instanceId, oldStreamId: operation.operationId, status: 'interrupted_unresolved',
      tailBoundaryUnknown: true, eventDeliveryUnknown: true, hardwareReleaseConfirmed: false };
  } catch { return { isolated: false, reason: 'generation_or_guard_unknown' }; }
  finally { guard.releaseUnknown?.(); }
}
