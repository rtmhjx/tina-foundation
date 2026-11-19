import { randomUUID } from 'node:crypto';
import { ExclusiveMediaAdapter } from './exclusive-adapter.mjs';
import { guardedCapture } from './guarded-head.mjs';

// Single owner for both World calls and an external playback IPC endpoint.
// Unknown outcomes intentionally retain exclusive intent until reconciliation.
export class MediaCoordinator {
  constructor({ listener, journal, head, guardFactory, audioExecutor }) {
    Object.assign(this, { listener, journal, head, guardFactory, audioExecutor });
  }
  async run(kind, descriptor, executeOnce, signal, requestId = randomUUID()) {
    await this.listener.beginExclusive();
    let result;
    try {
      const adapter = new ExclusiveMediaAdapter({ listener: this.listener, journal: this.journal, executeOnce });
      result = await adapter.run({ requestId, kind, descriptor, signal });
      if (result.arbitration.state === 'completed' || (result.arbitration.state === 'rejected'
        && result.arbitration.reason === 'device_unavailable' && result.arbitration.playbackSent === false)) await this.listener.endExclusive();
      return result;
    } catch (error) {
      // Caller cannot prove whether a durable reservation or a device effect
      // occurred; retain the exclusion latch for inspection/reconciliation.
      throw error;
    }
  }
  capture(kind, signal, durationMs, cue = false) {
    const descriptor = JSON.stringify({ kind, durationMs: durationMs ?? null, cue });
    return this.run(kind, descriptor, () => guardedCapture({ head: this.head, guardFactory: this.guardFactory, kind, signal, durationMs, cue }), signal);
  }
  audio(snapshot, signal, requestId) {
    if (!snapshot || typeof snapshot.sha256 !== 'string' || !Number.isInteger(snapshot.volume) || typeof this.audioExecutor !== 'function') throw Error('audio_snapshot_invalid');
    return this.run('audio', JSON.stringify({ sha256: snapshot.sha256, volume: snapshot.volume }), () => this.audioExecutor(snapshot, signal), signal, requestId);
  }
  receipt(requestId) { return this.journal.read(requestId); }
}
