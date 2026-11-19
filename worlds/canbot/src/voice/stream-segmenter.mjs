// Reuse the upstream VAD and packer. An ASR result is a chunk-level preview,
// not a claim of token-level streaming or a verified end of the speaker's turn.
import { randomUUID } from 'node:crypto';
import { Segmenter, Packer, SEGMENT_DEFAULTS, rmsDb } from './upstream/package/src/segmenter.ts';

// Cortico's external event frame currently forwards event.text, not event.meta.
// Keep these observations visible to the model without promoting the ASR text
// to a trusted instruction. JSON also preserves quotes and line breaks in ASR.
function observationText({ streamId, turnId, boundary, snapshot, transcript, part = 1, parts = 1 }) {
  return 'CANBOT_AUDIO_OBSERVATION ' + JSON.stringify({ streamId, turnId, boundary,
    speechRevision: snapshot.speechRevision, observedQuietMs: snapshot.observedQuietMs,
    vadState: snapshot.vadState, part, parts, transcript });
}

export class LiveSpeechBatcher {
  constructor({ strategy, threshold, silenceMs = 1500, streamId = randomUUID(), transcribe, deliver,
    onFailure = () => {}, maxPending = 4, clock = () => performance.now() } = {}) {
    if (!['characters', 'duration_ms'].includes(strategy) || !Number.isInteger(threshold)
        || (strategy === 'characters' && (threshold < 1 || threshold > 10000))
        || (strategy === 'duration_ms' && (threshold < 3000 || threshold > 60000))
        || !Number.isInteger(silenceMs) || silenceMs < 100 || silenceMs > 30000
        || typeof streamId !== 'string' || streamId.length < 1
        || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 16
        || ![transcribe, deliver, onFailure, clock].every(v => typeof v === 'function')) throw Error('batch_configuration_invalid');
    Object.assign(this, { strategy, threshold, silenceMs, streamId, transcribe, deliver, onFailure, maxPending, clock });
    // Analyze long speech in short, disjoint chunks for visible progress.
    // The user-selected threshold still controls model-facing batch boundaries.
    const maxUtteranceMs = 3000;
    this.segmenter = new Segmenter({ ...SEGMENT_DEFAULTS, silenceMs, dispatchSilenceMs: Math.min(500, silenceMs), maxUtteranceMs,
      minSpeechMs: Math.min(SEGMENT_DEFAULTS.minSpeechMs, maxUtteranceMs),
      minUtteranceMs: Math.min(SEGMENT_DEFAULTS.minUtteranceMs, maxUtteranceMs) }, 20);
    this.packer = new Packer({ joinGapMs: 0, maxHoldMs: 60000, minChars: 1 });
    this.maxUtteranceMs = maxUtteranceMs;
    this.queue = []; this.worker = null; this.pieces = []; this.turnId = null;
    this.failed = false; this.closed = false; this.stopping = false; this.delivered = 0;
    this.tailPadding16kSamples = 0; this.fedFrames = 0; this.lastFrameAt = null;
    this.quietMs = 0; this.loud = false; this.speechRevision = 0; this.previewSequence = 0; this.waiters = new Set();
  }

  feed(frame) {
    if (this.failed || this.closed || this.stopping) throw Error('batcher_closed');
    if (!(frame instanceof Int16Array) || frame.length !== 320) throw Error('frame_must_be_20ms_at_16khz');
    this.fedFrames += frame.length; this.lastFrameAt = this.clock();
    const utterances = this.segmenter.push(frame), loud = this.segmenter.level >= SEGMENT_DEFAULTS.thresholdDb;
    const onset = loud && !this.loud;
    this.loud = loud; this.quietMs = loud ? 0 : this.quietMs + 20;
    if (onset) { this.speechRevision++; this.notifyWaiters('activity_detected'); }
    for (const utt of utterances) this.enqueue(utt);
    if ((this.packer.pending || this.turnId) && this.isSettled()) this.kick();
  }

  isSettled() {
    return !this.segmenter.active && this.segmenter.settleRemainingMs === 0 && this.quietMs >= this.silenceMs;
  }

  safeThroughMs() {
    // Audio remains available until both previews and the corresponding pause
    // observation have durable event receipts; a crash cannot erase the only
    // copy of text still held in the packer.
    if (this.failed || this.worker || this.queue.length || this.packer.pending || this.pieces.length || this.turnId
        || this.segmenter.active || this.segmenter.settleRemainingMs > 0) return null;
    return Math.max(0, this.fedFrames * 1000 / 16000 - SEGMENT_DEFAULTS.preRollMs);
  }

  snapshot() {
    const ageMs = this.lastFrameAt === null ? null : Math.max(0, Math.round(this.clock() - this.lastFrameAt));
    const fresh = ageMs !== null && ageMs <= 2500 && !this.stopping && !this.closed && !this.failed;
    return { streamId: this.streamId, speechRevision: this.speechRevision,
      vadState: !fresh ? 'unknown' : this.loud || this.segmenter.active ? 'activity' : 'quiet',
      observedQuietMs: fresh && !this.loud ? this.quietMs : null, lastFrameAgeMs: ageMs,
      processing: !!this.worker || this.queue.length > 0, captureStopping: this.stopping || this.closed,
      // This is an energy threshold over received frames, not proof of who is
      // speaking, semantic completion, or acoustic continuity.
      observation: 'energy_vad_received_frames_only' };
  }

  notifyWaiters(reason) { for (const wake of [...this.waiters]) wake(reason); }
  cancelWaits() { this.notifyWaiters('capture_stopping'); }

  async wait({ expectedSpeechRevision, waitMs, signal } = {}) {
    if (!Number.isSafeInteger(expectedSpeechRevision) || expectedSpeechRevision < 0
        || !Number.isInteger(waitMs) || waitMs < 200 || waitMs > 5000) throw Error('speech_wait_arguments_invalid');
    const initial = this.snapshot();
    if (signal?.aborted) return { ...initial, reason: 'cancelled' };
    if (initial.speechRevision !== expectedSpeechRevision) return { ...initial, reason: 'revision_changed' };
    if (initial.vadState !== 'quiet') return { ...initial, reason: 'not_proven_quiet' };
    return new Promise(resolve => {
      let finished = false, timer;
      const finish = reason => {
        if (finished) return; finished = true; clearTimeout(timer);
        this.waiters.delete(finish); signal?.removeEventListener('abort', aborted);
        resolve({ ...this.snapshot(), reason });
      };
      const aborted = () => finish('cancelled');
      this.waiters.add(finish); signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => finish('elapsed'), waitMs);
    });
  }

  enqueue(utterance) {
    if (this.failed || this.closed || this.stopping) throw Error('batcher_closed');
    // A forced split leaves Segmenter in its speaking state. If speech ends
    // exactly at that split, its next output can be pure trailing silence;
    // do not ask ASR to hallucinate a phrase from that empty tail.
    let voicedFrames = 0;
    for (let at = 0; at + 320 <= utterance.pcm.length; at += 320)
      if (rmsDb(utterance.pcm.subarray(at, at + 320)) >= SEGMENT_DEFAULTS.thresholdDb) voicedFrames++;
    if (voicedFrames === 0) return;
    // When ASR is slower than speech, coalesce only queued slices that
    // overlap or touch in the original sample timeline. This preserves real
    // samples (including pre-roll) and never fabricates an intervening gap.
    const previous = this.queue.at(-1);
    if (previous) {
      const offset = (utterance.startMs - previous.startMs) * 16;
      const length = Math.max(previous.pcm.length, offset + utterance.pcm.length);
      if (Number.isSafeInteger(offset) && offset >= 0 && offset <= previous.pcm.length && length <= 48000) {
        const pcm = new Int16Array(length); pcm.set(previous.pcm); pcm.set(utterance.pcm, offset);
        this.queue[this.queue.length - 1] = { pcm, startMs: previous.startMs, durationMs: length / 16,
          forced: previous.forced || utterance.forced };
        return;
      }
    }
    if (this.queue.length + (this.worker ? 1 : 0) >= this.maxPending) {
      this.failed = true; this.cancelWaits(); this.onFailure('asr_queue_overflow'); throw Error('asr_queue_overflow');
    }
    this.queue.push(utterance); this.kick();
  }

  kick() {
    if (!this.worker && !this.failed) this.worker = this.drain();
  }

  async drain() {
    try {
      while (!this.failed) {
        const utt = this.queue.shift();
        if (utt) {
          const text = await this.transcribe(utt.pcm);
          if (typeof text !== 'string' || text.length > 10000) throw Error('transcription_invalid');
          if (!text.trim()) continue;
          if (!this.turnId) this.turnId = randomUUID();
          const characters = Array.from(text.trim());
          const parts = this.strategy === 'characters'
            ? Array.from({ length: Math.ceil(characters.length / this.threshold) }, (_, i) => characters.slice(i * this.threshold, (i + 1) * this.threshold).join(''))
            : [text.trim()];
          for (let i = 0; i < parts.length; i++) {
            await this.deliver({ type: 'canbot.speech.partial', source: 'canbot', senderKey: 'canbot:microphone', origin: 'external', text: parts[i],
              ts: new Date().toISOString(), meta: { streamId: this.streamId, turnId: this.turnId, preview: true, previewSequence: ++this.previewSequence,
                part: i + 1, parts: parts.length, startMs: utt.startMs, durationMs: utt.durationMs,
                forced: utt.forced, identityVerified: false } }, { deliver: false });
          }
          if (this.strategy === 'duration_ms' && this.pieces.length
              && utt.startMs + utt.durationMs - this.pieces[0].startMs > this.threshold) await this.flush('in_progress');
          this.packer.add(text.trim(), this.fedFrames * 1000 / 16000);
          this.pieces.push({ text: text.trim(), startMs: utt.startMs, durationMs: utt.durationMs });
          // Bound continuously held text. A forced chunk remains provisional and
          // piggybacks on a later wake instead of asking the model to reply.
          const heldChars = this.pieces.reduce((n, piece) => n + Array.from(piece.text).length, 0);
          const heldMs = utt.startMs + utt.durationMs - this.pieces[0].startMs;
          if ((this.strategy === 'characters' && heldChars >= this.threshold)
              || (this.strategy === 'duration_ms' && heldMs >= this.threshold)
              || heldChars >= 10000) await this.flush('in_progress');
          continue;
        }
        if ((this.packer.pending || this.turnId) && (this.stopping || this.isSettled())) {
          const boundary = this.stopping ? (this.stopReason === 'playback_pause' ? 'playback_interrupted' : 'capture_stopped') : 'pause_candidate';
          if (this.packer.pending) await this.flush(boundary);
          else await this.flushBoundary(boundary);
          continue;
        }
        break;
      }
    } catch {
      this.failed = true; this.cancelWaits(); this.onFailure('asr_or_delivery_failed');
    } finally { this.worker = null; }
  }

  async flush(boundary) {
    const combined = this.packer.take();
    if (!combined) return;
    const pieces = this.pieces; this.pieces = [];
    const characters = Array.from(combined), parts = this.strategy === 'characters'
      ? Array.from({ length: Math.ceil(characters.length / this.threshold) }, (_, i) => characters.slice(i * this.threshold, (i + 1) * this.threshold).join(''))
      : [combined];
    const turnId = this.turnId, snapshot = this.snapshot();
    if (boundary !== 'in_progress') this.turnId = null;
    for (let i = 0; i < parts.length; i++) {
      const trigger = ['in_progress', 'playback_interrupted'].includes(boundary) || i + 1 < parts.length ? 'piggyback' : 'flush';
      const text = observationText({ streamId: this.streamId, turnId, boundary, snapshot,
        transcript: parts[i], part: i + 1, parts: parts.length });
      await this.deliver({ type: 'canbot.speech', source: 'canbot', senderKey: 'canbot:microphone', origin: 'external', text,
        ts: new Date().toISOString(), meta: { streamId: this.streamId, turnId, captureMode: 'continuous_device_stream',
          boundary, speechRevision: snapshot.speechRevision, observedQuietMs: snapshot.observedQuietMs,
          vadState: snapshot.vadState, strategy: this.strategy, threshold: this.threshold,
          effectiveMaxUtteranceMs: this.maxUtteranceMs, part: i + 1, parts: parts.length,
          durationMs: pieces.reduce((n, piece) => n + piece.durationMs, 0), identityVerified: false,
          sessionTailPadding16kSamples: this.tailPadding16kSamples } }, { trigger });
      this.delivered++;
    }
  }

  async flushBoundary(boundary) {
    const turnId = this.turnId, snapshot = this.snapshot(); this.turnId = null;
    await this.deliver({ type: 'canbot.speech.pause', source: 'canbot', senderKey: 'canbot:microphone', origin: 'external',
      text: observationText({ streamId: this.streamId, turnId, boundary, snapshot, transcript: null }),
      ts: new Date().toISOString(), meta: { streamId: this.streamId, turnId, boundary,
        speechRevision: snapshot.speechRevision, observedQuietMs: snapshot.observedQuietMs,
        vadState: snapshot.vadState, identityVerified: false } }, { trigger: boundary === 'playback_interrupted' ? 'piggyback' : 'flush' });
  }

  async stop(reason = 'requested') {
    if (this.closed || this.stopping) throw Error('batcher_closed');
    const tail = this.segmenter.flush();
    if (tail) this.enqueue(tail);
    this.stopReason = reason; this.stopping = true; this.cancelWaits();
    if (this.packer.pending || this.queue.length || this.turnId) this.kick();
    while (this.worker) await this.worker;
    if (this.failed) throw Error('batcher_failed');
    this.closed = true;
  }
}
