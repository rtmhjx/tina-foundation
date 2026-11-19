import { createHash } from 'node:crypto';
import { PlaybackArbiter } from './arbiter.mjs';

// Prototype only: executeOnce MUST acquire the real, cross-process media guard,
// reserve the device operation, post at most once and prove settlement before
// returning. Neither an in-process queue nor this adapter provides that guard.
export class ExclusiveMediaAdapter {
  constructor({ listener, journal, executeOnce, limits }) {
    if (typeof executeOnce !== 'function') throw Error('exclusive_executor_required');
    this.listener = listener; this.journal = journal; this.executeOnce = executeOnce; this.limits = limits;
  }

  async run({ requestId, kind, descriptor, signal }) {
    if (!['audio', 'tone', 'microphone', 'photo', 'video'].includes(kind)) throw Error('media_kind_invalid');
    if (typeof descriptor !== 'string' || descriptor.length < 1 || descriptor.length > 4096) throw Error('media_descriptor_invalid');
    const payloadHash = createHash('sha256').update('canbot-exclusive-v1\0').update(kind).update('\0').update(descriptor).digest('hex');
    let response;
    const arbiter = new PlaybackArbiter({ listener: this.listener, journal: this.journal, limits: this.limits,
      playback: { playOnce: async id => {
        if (id.requestId !== requestId || id.payloadHash !== payloadHash) throw Error('identity_mismatch');
        const result = await this.executeOnce({ requestId, kind, descriptor, payloadHash });
        if (result?.state === 'completed' && result.settled === true && result.guardReleased === true) {
          response = result.value; return { state: 'completed' };
        }
        if (result?.state === 'not_started' && result.guardReleased === true) return { state: 'not_started' };
        return { state: 'unknown' };
      } } });
    const arbitration = await arbiter.play({ requestId, payloadHash, signal });
    // Original media is intentionally not placed into the journal. A replayed
    // durable receipt cannot recreate its blob; it must never invoke the device.
    const available = response !== undefined;
    return { arbitration, resultAvailable: available, ...(available ? { result: response } : {}) };
  }
}
