import { randomUUID } from 'node:crypto';

/**
 * Contract adapter for Android microphone-stream; inject authenticated transport,
 * a held cross-process guard/journal, and a StreamSpool. No recording starts here
 * until start() is explicitly called. `guard` must hold playback.lock, durably
 * reserve before POST, and retain the latch on any unknown outcome.
 */
export class StreamClient {
  constructor({ transport, guard, spoolFactory, clock = () => performance.now(), onChunk = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (![transport?.request, guard?.reserve, guard?.settle, spoolFactory, clock, onChunk, sleep].every(f => typeof f === 'function')) throw Error('stream_ports_required');
    Object.assign(this, { transport, guard, spoolFactory, clock, onChunk, sleep });
    this.operation = null; this.spool = null; this.leaseSequence = 0; this.lastLease = 0;
    this.stopRequested = false; this.stopSubmitted = false; this.lastDeviceStatus = null; this.lastStatusAt = null; this.finished = false;
    this.postSubmitted = false; this.postDone = null; this.stopPromise = null; this.cancelledBeforeSubmit = false;
  }
  async start({ chunkMs = 1000, mode, silenceMs = 1500, operationId = randomUUID() }) {
    if (this.operation || ![1000, 2000, 3000].includes(chunkMs)) throw Error('stream_start_invalid');
    const device = await this.transport.request('/v1/status');
    if (this.stopRequested) { this.cancelledBeforeSubmit = true; throw Error('stream_cancelled_before_submit'); }
    if (device.schemaVersion !== 'canbot.diagnostics.v2' || device.foreground !== true
        || typeof device.instanceId !== 'string' || !Number.isSafeInteger(device.lastSequence)
        || device.activeOperation != null || device.microphoneCapture?.supportsStream !== true) throw Error('stream_device_not_ready');
    const operation = { operationId, instanceId: device.instanceId, sequence: device.lastSequence + 1, kind: 'microphone_stream' };
    await this.guard.reserve(operation); this.operation = operation;
    if (this.stopRequested) {
      await this.guard.settle(operation.operationId, 'rejected'); this.cancelledBeforeSubmit = true; throw Error('stream_cancelled_before_submit');
    }
    const body = { operationId: operation.operationId, instanceId: operation.instanceId, sequence: operation.sequence, chunkMs };
    this.postSubmitted = true;
    this.postDone = this.transport.request('/v1/microphone-stream', { method: 'POST', body }).catch(() => {});
    await this.postDone; // Query this same ID only; never POST it again.
    if (this.stopRequested) await this.stop();
    try {
      this.lastLease = this.clock(); let state;
      for (let i = 0; i < 50; i++) {
        state = await this.readStatus();
        if ([8000, 16000].includes(state.sampleRate)) break;
        if (state.settled || state.state === 'failed') throw Error('stream_start_failed');
        if (!this.stopRequested && this.clock() - this.lastLease >= 5000) await this.renew();
        await this.sleep(100);
      }
      if (![8000, 16000].includes(state?.sampleRate)) throw Error('stream_sample_rate_unknown');
      this.spool = await this.spoolFactory({ streamId: operation.operationId, mode, silenceMs, sampleRate: state.sampleRate,
        ack: seq => this.ack(seq) });
      await this.spool.init(); this.lastLease = this.clock();
      return this.status();
    } catch (error) {
      if (this.lastDeviceStatus?.settled !== true) await this.stop();
      throw error;
    }
  }
  path() { return `/v1/microphone-stream/${this.operation.operationId}`; }
  async readStatus() {
    const s = await this.transport.request(this.path());
    if (s.operationId !== this.operation.operationId || s.instanceId !== this.operation.instanceId) throw Error('stream_identity_mismatch');
    // Preserve an authenticated, identity-checked failure snapshot before
    // raising; never show an older gap:false after device reports a gap.
    this.lastDeviceStatus = s; this.lastStatusAt = this.clock();
    // Android uses null for no gap; missing gap is not equivalent to no gap.
    if (!Object.hasOwn(s, 'gap') || s.gap !== null) throw Error('stream_gap_or_unknown');
    return s;
  }
  async ack(sequence) {
    const body = { instanceId: this.operation.instanceId, throughSequence: sequence };
    try { await this.transport.request(this.path() + '/ack', { method: 'POST', body }); }
    catch { await this.transport.request(this.path() + '/ack', { method: 'POST', body }); } // exact idempotent ACK
  }
  async renew() {
    const body = { instanceId: this.operation.instanceId, leaseSequence: ++this.leaseSequence };
    try { await this.transport.request(this.path() + '/lease', { method: 'POST', body }); }
    catch { await this.transport.request(this.path() + '/lease', { method: 'POST', body }); } // same sequence, never extend twice
    this.lastLease = this.clock();
  }
  async stop() {
    this.stopRequested = true;
    if (!this.operation || !this.postSubmitted) return this.status();
    if (this.stopPromise) { await this.stopPromise; return this.status(); }
    this.stopSubmitted = true;
    this.stopPromise = (async () => {
      if (this.postDone) await this.postDone;
      try { await this.transport.request(this.path() + '/stop', { method: 'POST', body: { instanceId: this.operation.instanceId } }); }
      catch { /* GET later; a request is not settlement. */ }
    })();
    await this.stopPromise;
    return this.status();
  }
  status() {
    return { streamId: this.operation?.operationId ?? null, stopRequested: this.stopRequested,
      deviceStopConfirmed: this.finished, softwareStopConfirmed: this.finished,
      hardwareReleaseConfirmed: false,
      deviceHardwareContinuityVerified: false,
      observationAgeMs: this.lastStatusAt === null ? null : Math.max(0, this.clock() - this.lastStatusAt),
      deviceState: this.lastDeviceStatus?.state ?? 'unknown',
      capture: { lastSequence: this.spool ? this.spool.firstSequence + this.spool.chunks.length - 1 : 0,
        persistedThroughSequence: this.spool ? this.spool.firstSequence + this.spool.chunks.length - 1 : 0, ackThroughSequence: this.lastDeviceStatus?.lastAckSequence ?? 0,
        settled: this.lastDeviceStatus?.settled ?? false, tailState: this.lastDeviceStatus?.tailState ?? 'unknown',
        finalSequence: this.lastDeviceStatus?.finalSequence ?? (this.lastDeviceStatus?.finalEmpty === true ? 0 : null), finalProduced: this.lastDeviceStatus?.finalProduced ?? false,
        finalEmpty: this.lastDeviceStatus?.finalEmpty ?? false, tailBoundaryUnknown: this.lastDeviceStatus?.tailBoundaryUnknown ?? null,
        gap: this.lastDeviceStatus && this.lastStatusAt !== null && (this.finished || this.clock() - this.lastStatusAt <= 2500)
          && Object.hasOwn(this.lastDeviceStatus, 'gap') ? this.lastDeviceStatus.gap !== null : null,
        lastObservedGap: this.lastDeviceStatus?.gap ?? null },
      sampleRate: this.lastDeviceStatus?.sampleRate ?? null };
  }
  async tick() {
    try { return await this.tickOnce(); }
    catch (error) {
      // Failed verification, overload or a lost lease must request one stop;
      // the persistent guard stays reserved until verified finalization.
      if (this.spool && this.lastDeviceStatus?.gap) {
        try { await this.spool.recordDeviceFault(this.lastDeviceStatus); } catch { /* keep unknown latch */ }
      }
      if (this.operation && !this.stopSubmitted && this.lastDeviceStatus?.settled !== true) await this.stop();
      throw error;
    }
  }
  async tickOnce() {
    if (!this.operation || !this.spool || this.finished) throw Error('stream_not_running');
    let state = await this.readStatus();
    if (state.sampleRate !== this.spool.sampleRate || state.channels !== 1 || state.bitsPerSample !== 16
      || !Array.isArray(state.chunks) || !Number.isSafeInteger(state.lastAckSequence)) throw Error('stream_status_invalid');
    if (!this.stopRequested && this.clock() - this.lastLease >= 5000) await this.renew();
    for (const item of [...state.chunks].sort((a, b) => a.sequence - b.sequence)) {
      if (item.sequence <= state.lastAckSequence) continue;
      const wav = await this.transport.request(this.path() + '/chunks/' + item.sequence, { binary: true });
      if (!Number.isSafeInteger(item.bytes) || item.bytes !== wav.length) throw Error('stream_chunk_length_mismatch');
      const r = await this.spool.ingest({ ...item, wav });
      if (!r.duplicate) await this.onChunk({ ...item, wav, sampleRate: state.sampleRate });
      if (r.shouldStop && !this.stopRequested) await this.stop();
    }
    state = await this.readStatus();
    if (state.settled === true) {
      const finalSequence = state.finalSequence === null && state.finalEmpty === true ? 0 : state.finalSequence;
      // A final block may arrive after the first snapshot while chunks are
      // being consumed.  Do not mistake that normal race for a missing tail;
      // the next tick must download, persist and ACK it before finish.
      if (Number.isSafeInteger(finalSequence) && state.lastAckSequence < finalSequence) {
        if (!Array.isArray(state.chunks) || !state.chunks.some(x => x.sequence === state.lastAckSequence + 1))
          throw Error('stream_tail_missing');
        return this.status();
      }
      if (!['flushed', 'empty', 'flushed_read_unknown', 'empty_read_unknown'].includes(state.tailState) || (!state.finalProduced && !state.finalEmpty)
        || typeof state.tailBoundaryUnknown !== 'boolean' || state.tailBoundaryUnknown !== state.tailState.endsWith('_read_unknown')
        || !Number.isSafeInteger(finalSequence) || state.lastAckSequence < finalSequence) throw Error('stream_tail_unknown');
      const result = await this.spool.finish({ settled: true, finalSequence, finalEmpty: state.finalEmpty, tailState: state.tailState });
      this.finished = true;
      return { ...this.status(), finalized: result };
    }
    return this.status();
  }
}
