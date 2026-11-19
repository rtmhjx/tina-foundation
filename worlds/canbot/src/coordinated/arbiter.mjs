import { performance } from 'node:perf_hooks';

class Unknown extends Error { constructor(phase, reason) { super(reason); this.phase = phase; } }
function waitBounded(fn, ms, signal, phase) {
  if (signal?.aborted) return Promise.reject(new Unknown(phase, 'cancelled_before_outcome'));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Unknown(phase, 'timeout_outcome_unknown')), ms);
    const abort = () => finish(new Unknown(phase, 'cancelled_outcome_unknown'));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(fn).then(v => finish(null, v), () => finish(new Unknown(phase, 'port_outcome_unknown')));
  });
}
const validSnapshot = s => s && typeof s.intentEnabled === 'boolean' && ['continuous', 'silence_stop', 'press_stop'].includes(s.mode)
  && Number.isSafeInteger(s.intentRevision) && s.intentRevision >= 0 && typeof s.connected === 'boolean'
  && ['active', 'idle', 'unknown'].includes(s.listening) && (s.sessionId === null || typeof s.sessionId === 'string');
const validFinalization = (r, sessionId) => r?.sessionId === sessionId && r.settled === true && r.deviceStopConfirmed === true && r.guardReleased === true
  && r.finalTailPersisted === true && r.finalAcked === true && r.gap === false && typeof r.tailBoundaryUnknown === 'boolean';

/** One owner process; actual ports must enforce session/revision CAS and hold the shared device lock. */
export class PlaybackArbiter {
  constructor({ listener, playback, journal, clock = () => performance.now(), limits = {} }) {
    if (![listener?.snapshot, listener?.pauseForPlayback, listener?.waitSettled, listener?.resumeIfUnchanged,
      playback?.playOnce, journal?.reserve, journal?.write, journal?.clearActive, clock].every(f => typeof f === 'function')) throw Error('arbiter_ports_required');
    this.listener = listener; this.playback = playback; this.journal = journal; this.clock = clock; this.busy = false;
    this.limits = { snapshotMs: 5000, pauseMs: 5000, settleMs: 30000, playbackMs: 60000, resumeMs: 5000, ...limits };
    if (Object.values(this.limits).some(n => !Number.isInteger(n) || n < 1 || n > 60000)) throw Error('arbiter_limits_invalid');
  }
  async play({ requestId, payloadHash, signal }) {
    if (this.busy) return { state: 'rejected', reason: 'arbiter_busy', playbackSent: false };
    this.busy = true; let record, phase = 'reserve', paused = null, pauseAt = null, tailBoundaryUnknown = null, initial;
    try {
      const reserved = await this.journal.reserve(requestId, payloadHash);
      record = reserved.record;
      if (!reserved.created) return record.state === 'completed' || record.state === 'rejected' ? record
        : { ...record, state: 'unknown', reason: 'previous_outcome_unresolved', playbackSent: null };
      const mark = async (next, extra = {}) => { phase = next; record = { ...record, ...extra, state: 'pending', phase: next }; await this.journal.write(record); };
      await mark('snapshot');
      initial = await waitBounded(() => this.listener.snapshot(), this.limits.snapshotMs, signal, phase);
      if (!validSnapshot(initial) || initial.listening === 'unknown') throw new Unknown(phase, 'listener_state_unknown');
      // With a proven idle listener, an unavailable device is an explicit
      // refusal before any pause or device/playback submission.
      if (initial.listening === 'idle' && initial.connected === false
          && initial.guardReleased === true && initial.deviceStopConfirmed === true
          && initial.finalTailPersisted === true && initial.finalAcked === true) {
        record = { ...record, state: 'rejected', phase: 'complete', reason: 'device_unavailable', playbackSent: false };
        await this.journal.write(record); await this.journal.clearActive(requestId); return record;
      }
      if (initial.listening === 'active') {
        if (!initial.sessionId) throw new Unknown(phase, 'session_identity_unknown');
        await mark('pause_requested', { sessionId: initial.sessionId, intentRevision: initial.intentRevision });
        const result = await waitBounded(() => this.listener.pauseForPlayback({ sessionId: initial.sessionId, intentRevision: initial.intentRevision }), this.limits.pauseMs, signal, phase);
        if (result?.accepted !== true) throw new Unknown(phase, 'pause_outcome_unknown');
        paused = true;
        await mark('awaiting_settlement');
        const proof = await waitBounded(() => this.listener.waitSettled({ sessionId: initial.sessionId }), this.limits.settleMs, signal, phase);
        if (!validFinalization(proof, initial.sessionId)) throw new Unknown(phase, 'capture_settlement_unproven');
        pauseAt = this.clock(); tailBoundaryUnknown = proof.tailBoundaryUnknown;
      } else { paused = false; if (initial.guardReleased !== true || initial.deviceStopConfirmed !== true || initial.finalTailPersisted !== true || initial.finalAcked !== true) {
        throw new Unknown(phase, 'idle_safety_unproven');
      } }
      await mark('playback_requested', { paused, tailBoundaryUnknown });
      const played = await waitBounded(() => this.playback.playOnce({ requestId, payloadHash }), this.limits.playbackMs, signal, phase);
      if (!['completed', 'not_started'].includes(played?.state)) throw new Unknown(phase, 'playback_outcome_unknown');
      const playbackState = played.state;
      await mark('playback_finished', { playbackState });
      let resumeState = 'not_requested', gap = null;
      if (paused) {
        const end = this.clock();
        gap = { reason: 'playback_pause', startAfterSoftwareSettlementMs: pauseAt, endBeforeResumeAttemptMs: end,
          elapsedFromSettlementToResumeCheckMs: Math.max(0, end - pauseAt), actualAcousticGapMs: null,
          tailBoundaryUnknown, hardwareContinuityVerified: false };
        const current = await waitBounded(() => this.listener.snapshot(), this.limits.snapshotMs, signal, 'resume_preflight');
        if (!validSnapshot(current)) throw new Unknown('resume_preflight', 'listener_state_unknown');
        if (current.intentEnabled && current.mode === initial.mode && ['continuous', 'press_stop'].includes(current.mode)
            && current.connected && current.intentRevision === initial.intentRevision) {
          await mark('resume_requested', { playbackState, gap });
          const resumed = await waitBounded(() => this.listener.resumeIfUnchanged({ expectedIntentRevision: initial.intentRevision,
            previousSessionId: initial.sessionId, cause: 'playback_pause' }), this.limits.resumeMs, signal, phase);
          if (!['resumed', 'not_resumed'].includes(resumed?.state)) throw new Unknown(phase, 'resume_outcome_unknown');
          resumeState = resumed.state;
        } else resumeState = 'intent_changed_or_offline';
      }
      record = { ...record, state: 'completed', phase: 'complete', playbackState, resumeState, gap,
        playbackSent: playbackState === 'completed', hardwareReleaseConfirmed: false };
      await this.journal.write(record); await this.journal.clearActive(requestId); return record;
    } catch (error) {
      if (!record) throw error;
      record = { ...record, state: 'unknown', phase: error instanceof Unknown ? error.phase : phase,
        reason: error instanceof Unknown ? error.message : 'journal_or_internal_outcome_unknown',
        playbackSent: record.playbackState === 'completed' ? true : record.playbackState === 'not_started' ? false
          : ['playback_requested', 'playback_finished', 'resume_requested'].includes(phase) ? null : false,
        automaticRetry: false, resumeState: 'unknown', paused };
      try { await this.journal.write(record); } catch { /* Original intent remains durable; do not repeat effects. */ }
      return record;
    } finally { this.busy = false; }
  }
}
