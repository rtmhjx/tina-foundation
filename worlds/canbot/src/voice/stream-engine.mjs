import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stat, readFile, readdir } from 'node:fs/promises';
import { StreamGuard } from './stream-guard.mjs';
import { StreamClient } from './stream-client.mjs';
import { StreamSpool, pcmOf } from './stream-spool.mjs';
import { LiveSpeechBatcher } from './stream-segmenter.mjs';
import { EventOutbox } from './event-outbox.mjs';
import { recoverCompletedStream, isolateInterruptedGeneration } from './stream-recovery.mjs';

function wav16(pcm) {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], 44 + i * 2);
  return out;
}
function resample(pcm, rate) {
  const out = new Int16Array(pcm.length / 2 * (rate === 8000 ? 2 : 1));
  for (let i = 0; i < pcm.length / 2; i++) {
    const sample = pcm.readInt16LE(i * 2);
    if (rate === 8000) { out[i * 2] = sample; out[i * 2 + 1] = sample; } else out[i] = sample;
  }
  return out;
}

/** Injectable integration engine; constructing it does not start mic or network. */
export class StreamEngine {
  constructor({ head, host, stt, stateDir, spoolRoot, guardFactory = () => new StreamGuard({ stateDir }),
    clock = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!head || typeof head.request !== 'function' || !host || typeof host.pushEvent !== 'function'
      || typeof stt !== 'function' || !stateDir || !spoolRoot) throw Error('engine_ports_required');
    Object.assign(this, { head, host, stt, stateDir, spoolRoot, guardFactory, clock, sleep });
    this.state = 'idle'; this.phase = 'idle'; this.sessionId = null; this.captureMode = 'unknown'; this.lastError = null;
    this.client = null; this.runner = null; this.batcher = null; this.audioRemainder = new Int16Array(0); this.previousSession = null; this.stopReason = null;
  }
  status() {
    const live = this.client?.status();
    return { state: this.state, phase: this.phase, sessionId: this.sessionId, captureMode: this.captureMode,
      microphone: this.state === 'running' && live?.sampleRate && live.deviceState === 'recording' && live.observationAgeMs <= 2500 ? 'active'
        : this.state === 'idle' || this.state === 'stopped' ? 'idle' : 'unknown',
      deviceStopConfirmed: live?.deviceStopConfirmed ?? this.state === 'idle',
      hardwareReleaseConfirmed: false, deviceHardwareContinuityVerified: false,
      lastError: this.lastError, previousSession: this.previousSession,
      capture: live?.capture ?? { lastSequence: 0, settled: this.state === 'idle', gap: null } };
  }
  async recoveryReady() {
    let recoveryEvidence = null;
    try {
      await stat(join(this.stateDir, 'unsettled.json'));
      const r = await recoverCompletedStream({ head: this.head, stateDir: this.stateDir, spoolRoot: this.spoolRoot, guardFactory: this.guardFactory });
      if (r.recovered) recoveryEvidence = r;
      else {
        const isolated = await isolateInterruptedGeneration({ head: this.head, stateDir: this.stateDir, guardFactory: this.guardFactory });
        if (!isolated.isolated) return { safeToStart: false, reason: isolated.reason };
        recoveryEvidence = isolated; this.previousSession = isolated;
      }
    }
    catch (error) { if (error.code !== 'ENOENT') return { safeToStart: false }; }
    try {
      const unresolved = (await readdir(this.stateDir)).filter(name => /^quarantine-[0-9a-f-]{36}\.json$/.test(name)).length;
      if (unresolved) this.previousSession = { status: 'interrupted_unresolved', unresolvedCount: unresolved,
        tailBoundaryUnknown: true, eventDeliveryUnknown: true, hardwareReleaseConfirmed: false };
    } catch (error) { if (error.code !== 'ENOENT') return { safeToStart: false }; }
    try {
      const s = await this.head.request('media', '/v1/status');
      const ready = s.foreground === true && s.activeOperation === null && s.microphoneCapture?.supportsStream === true;
      if (!ready) return { safeToStart: false, reason: 'device_not_ready' };
      if (this.state === 'failed') {
        // An old failed in-memory operation can be cleared only after its exact
        // latch has been durably settled or quarantined, the guard owner exited,
        // and the same authenticated fresh device generation is still idle.
        if (!recoveryEvidence || recoveryEvidence.guardReleased !== true
          || recoveryEvidence.oldStreamId !== this.sessionId || recoveryEvidence.newInstanceId !== s.instanceId)
          return { safeToStart: false, reason: 'failed_session_unresolved' };
        this.state = 'idle'; this.phase = 'idle'; this.sessionId = null; this.client = null;
        this.captureMode = 'unknown'; this.lastError = null; this.audioRemainder = new Int16Array(0);
      }
      return { safeToStart: true };
    } catch { return { safeToStart: false }; }
  }
  async start(config) {
    if (!['idle', 'stopped'].includes(this.state)) throw Error('engine_busy');
    this.state = 'starting'; this.phase = 'starting'; this.lastError = null; this.captureMode = 'unknown';
    this.sessionId = randomUUID(); this.stopReason = null;
    this.audioRemainder = new Int16Array(0);
    const guard = this.guardFactory();
    const transport = { request: async (path, options = {}) => {
      const response = await this.head.request('media', path, options);
      return options.binary ? response.bytes : response;
    } };
    this.batcher = config.mode === 'continuous' ? new LiveSpeechBatcher({ ...config.batch, silenceMs: config.silenceMs, streamId: this.sessionId, clock: this.clock,
      transcribe: pcm => this.stt(wav16(pcm)), deliver: (event, options) => this.outbox.push(event, options),
      onFailure: () => { void this.client?.stop(); } }) : null;
    const client = new StreamClient({ transport, guard, clock: this.clock, sleep: this.sleep,
      spoolFactory: async options => new StreamSpool({ ...options, folder: join(this.spoolRoot, options.streamId) }),
      onChunk: async ({ wav, sampleRate }) => {
        if (this.batcher) {
          this.feed(pcmOf(wav, sampleRate).pcm, sampleRate);
          const safeMs = this.batcher.safeThroughMs();
          if (safeMs !== null) await client.spool.pruneThrough(Math.floor(safeMs * sampleRate / 1000));
        }
      } });
    this.client = client;
    // Publish the session identity before any network operation completes.  The
    // runner is deliberately detached from the control request, so stop can
    // interrupt a slow Android startup without scheduling a second POST.
    const sessionId = this.sessionId;
    this.runner = this.startAndRun(config, client, guard, sessionId);
    return this.status();
  }
  async startAndRun(config, client, guard, sessionId) {
    try {
      await client.start({ mode: config.mode, silenceMs: config.silenceMs, operationId: sessionId });
      this.outbox = new EventOutbox({ folder: join(client.spool.folder, 'outbox'), host: this.host });
      this.captureMode = 'continuous_stream';
      if (this.state !== 'stopping') { this.state = 'running'; this.phase = 'recording'; }
      await this.run(config);
    } catch (error) {
      if (client.cancelledBeforeSubmit) {
        this.state = 'idle'; this.phase = 'idle'; this.sessionId = null; this.client = null;
        return;
      }
      guard.releaseUnknown?.(); this.state = 'failed'; this.phase = 'failed';
      this.lastError = 'stream_start_or_outcome_unknown';
    }
  }
  feed(pcm, rate) {
    const incoming = resample(pcm, rate), all = new Int16Array(this.audioRemainder.length + incoming.length);
    all.set(this.audioRemainder); all.set(incoming, this.audioRemainder.length); let i = 0;
    for (; i + 320 <= all.length; i += 320) this.batcher.feed(all.subarray(i, i + 320));
    this.audioRemainder = all.slice(i);
  }
  async requestStop(reason = 'requested') {
    if (!this.client || !['running', 'starting', 'stopping'].includes(this.state)) throw Error('session_not_running');
    if (this.state !== 'stopping') this.stopReason = reason;
    this.state = 'stopping'; this.phase = 'stopping'; this.batcher?.cancelWaits(); await this.client.stop(); return this.status();
  }
  async run(config) {
    try {
      while (!this.client.finished) {
        await this.client.tick();
        if (!this.client.finished) await this.sleep(500);
      }
      if (this.batcher) {
        if (this.audioRemainder.length) {
          const tail = new Int16Array(320); tail.set(this.audioRemainder);
          this.batcher.tailPadding16kSamples = 320 - this.audioRemainder.length;
          this.audioRemainder = new Int16Array(0); this.batcher.feed(tail);
        }
        await this.batcher.stop(this.stopReason ?? 'requested');
      }
      else await this.transcribeFinal();
      await this.outbox.markProcessingComplete(this.sessionId);
      // Keep the durable latch through ASR and event confirmation. A crash or
      // ambiguous event outcome must prevent automatic restart/retransmission.
      await this.client.guard.settle(this.client.operation.operationId, 'completed');
      this.state = 'stopped'; this.phase = 'stopped';
    } catch {
      this.client?.guard.releaseUnknown?.(); this.state = 'failed'; this.phase = 'failed';
      this.lastError = this.client?.lastDeviceStatus?.gap ? 'device_gap_detected' : 'stream_or_processing_outcome_unknown';
    }
  }
  async transcribeFinal() {
    this.phase = 'transcribing'; const pieces = []; let pcm = [];
    const flush = async () => {
      if (!pcm.length) return;
      const words = await this.stt(wav16(Int16Array.from(pcm)));
      if (typeof words !== 'string') throw Error('stt_invalid'); if (words.trim()) pieces.push(words.trim()); pcm = [];
    };
    for (const item of this.client.spool.chunks) {
      const wav = await readFile(join(this.client.spool.folder, item.file));
      const samples = resample(pcmOf(wav, this.client.spool.sampleRate).pcm, this.client.spool.sampleRate);
      for (const value of samples) { pcm.push(value); if (pcm.length === 160000) await flush(); }
    }
    await flush();
    if (pieces.length) await this.outbox.push({ type: 'canbot.speech', origin: 'external', source: 'canbot', senderKey: 'canbot:microphone',
      ts: new Date().toISOString(), text: pieces.join(' '), meta: { streamId: this.sessionId, identityVerified: false,
        captureMode: 'continuous_device_stream', delivery: 'after_stop', hardwareContinuityVerified: false,
        tailBoundaryUnknown: this.client.lastDeviceStatus?.tailBoundaryUnknown ?? null } });
  }
}
