import { performance } from 'node:perf_hooks';
import { AUDIO_HANDLE, UUID, AnalysisError, parseAnalysisWav, readSidecarToken,
  sidecarURL, directLoopbackFetch } from './audio-analysis.mjs';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const STATES = new Set(['running', 'complete', 'unknown', 'failed']);
const error = code => new AnalysisError(code);

function requestId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw error('diarization_request_id_invalid');
  return value;
}

function nonnegative(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

function validateReceipt(value, id, expectedHash) {
  const input = value?.input;
  if (value?.schema_version !== 'canbot.diarization-sidecar-job.v1' || value.request_id !== id
    || !STATES.has(value.state) || !SHA256.test(input?.sha256 ?? '')
    || (expectedHash && input.sha256 !== expectedHash)
    || !Number.isInteger(input.frames) || input.frames < 3200 || input.frames > 1440000
    || input.duration_seconds !== input.frames / 16000 || input.sample_rate_hz !== 16000
    || input.channels !== 1 || input.sample_width_bytes !== 2 || value.replay_permitted !== false) {
    throw error('diarization_receipt_mismatch');
  }
  const receipt = { schema_version: value.schema_version, request_id: id, state: value.state,
    replay_permitted: false, input: { sha256: input.sha256, frames: input.frames,
      duration_seconds: input.duration_seconds, sample_rate_hz: 16000, channels: 1, sample_width_bytes: 2 } };
  if (value.state === 'complete') {
    const result = value.diarization;
    if (!result || result.speaker_scope !== 'this_recording_only' || result.speaker_identity_assigned !== false
      || result.accuracy_accepted !== false || result.overlap_preserved !== true
      || result.transcription_performed !== false || result.separated_waveforms_produced !== false
      || !Array.isArray(result.segments) || result.segments.length > 10000
      || !Array.isArray(result.speaker_labels) || !Number.isInteger(result.speaker_count)) {
      throw error('diarization_result_invalid');
    }
    const segments = result.segments.map(segment => {
      if (!nonnegative(segment?.start) || !nonnegative(segment?.end)
        || segment.start > segment.end || segment.end > input.duration_seconds + 0.02
        || typeof segment.track !== 'string' || segment.track.length > 80
        || typeof segment.speaker !== 'string' || !/^anonymous_[0-9]{2,6}$/.test(segment.speaker)) {
        throw error('diarization_segment_invalid');
      }
      // Each track remains independent. Never collapse same-interval or overlapping tracks.
      return { start: segment.start, end: segment.end, track: segment.track, speaker: segment.speaker };
    });
    const labels = [...new Set(segments.map(segment => segment.speaker))].sort();
    if (result.speaker_count !== labels.length || result.speaker_labels.length !== labels.length
      || [...result.speaker_labels].sort().some((label, i) => label !== labels[i])) {
      throw error('diarization_labels_mismatch');
    }
    receipt.diarization = { speaker_scope: 'this_recording_only', speaker_identity_assigned: false,
      accuracy_accepted: false, overlap_preserved: true, transcription_performed: false,
      separated_waveforms_produced: false, speaker_count: labels.length, speaker_labels: labels, segments };
  }
  return receipt;
}

// Race the entire request/body read, including test fetch implementations that ignore abort.
async function bounded(work, signal, timeoutMs) {
  if (signal?.aborted) throw error('diarization_cancelled');
  if (timeoutMs <= 0) throw error('diarization_timeout');
  const controller = new AbortController();
  let timer, abort;
  const stopped = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(error('diarization_cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(error('diarization_timeout')); }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}

async function responseJson(response, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') ?? '')) {
    throw error('diarization_response_invalid');
  }
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw error('diarization_response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw error('diarization_response_invalid');
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw error('diarization_response_too_large');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw error('diarization_response_invalid'); }
  } finally { signal?.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); }
}

/**
 * Transport only. The World resolves host.blob(log:) and persists its AnalysisJournal
 * reservation before analyze(). The journal remains authoritative across process restarts.
 * Mainline shared WAV policy is 0.5–10s; the independent 8053 service also supports longer files.
 * This constructor is pure: no token reads, filesystem mutation, or network requests.
 */
export function createDiarizationClient({ baseURL = 'http://127.0.0.1:8053', tokenFile,
  fetchImpl = directLoopbackFetch, timeoutMs = 188000, requestTimeoutMs = 5000, pollIntervalMs = 250 } = {}) {
  const base = sidecarURL(baseURL, 8053);
  if (typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 188000
    || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 5000
    || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 1000) {
    throw error('diarization_client_options_invalid');
  }
  const submitted = new Map(); // Bounded second defense only; never substitutes for the host journal.

  async function call(path, { method = 'GET', body, id, signal, deadline, token }) {
    token ??= await readSidecarToken(tokenFile);
    return bounded(async requestSignal => {
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body) Object.assign(headers, { 'Content-Type': 'audio/wav', 'Content-Length': String(body.length), 'X-Request-ID': id });
      const response = await fetchImpl(new URL(path, base), { method, headers, body,
        signal: requestSignal, redirect: 'error' });
      // Never expose untrusted error text, headers or body to the model.
      if (response.status !== 200 && response.status !== 202) {
        void response.body?.cancel().catch(() => {});
        throw error('diarization_http_' + response.status);
      }
      const value = await responseJson(response, requestSignal);
      if (signal?.aborted) throw error('diarization_cancelled');
      if (performance.now() >= deadline) throw error('diarization_timeout');
      return value;
    }, signal, Math.min(requestTimeoutMs, deadline - performance.now()));
  }

  function summary(receipt, postAttempts = 0) {
    return { requestId: receipt.request_id, inputSha256: receipt.input.sha256,
      state: receipt.state === 'unknown' ? 'outcome_unknown' : receipt.state,
      outcome: receipt.state === 'unknown' ? 'outcome_unknown' : receipt.state,
      postAttempts, retryAutomatically: false, receipt,
      ...(receipt.diarization ? { segments: receipt.diarization.segments } : {}) };
  }

  async function receipt({ requestId: id, expectedInputSha256, signal } = {}) {
    id = requestId(id);
    if (expectedInputSha256 !== undefined && !SHA256.test(expectedInputSha256)) throw error('diarization_input_hash_invalid');
    const value = await call('/v1/diarizations/' + id, { signal, deadline: performance.now() + requestTimeoutMs });
    return summary(validateReceipt(value, id, expectedInputSha256));
  }

  async function analyze({ audioHandle, audioBytes, requestId: id, signal } = {}) {
    id = requestId(id);
    if (typeof audioHandle !== 'string' || !AUDIO_HANDLE.test(audioHandle)) throw error('analysis_log_wav_handle_required');
    const audio = parseAnalysisWav(audioBytes);
    let prior = submitted.get(id);
    if (prior && prior !== audio.sha256) throw error('analysis_request_id_conflict');
    if (!prior && submitted.size >= 1024) throw error('diarization_client_capacity_reached');
    let postAttempts = 0;
    const unknown = code => ({ requestId: id, audioHandle, inputSha256: audio.sha256,
      state: 'outcome_unknown', outcome: 'outcome_unknown', code,
      postAttempts, retryAutomatically: false, serverCancellationConfirmed: false });
    if (signal?.aborted) return unknown('diarization_cancelled_before_submission');
    // Resolve the token before reserving an upload attempt; safe errors contain no private path/value.
    const token = await readSidecarToken(tokenFile);
    if (signal?.aborted) return unknown('diarization_cancelled_before_submission');
    // Token IO yielded: another analyze() may have reserved this UUID meanwhile.
    // Recheck and reserve synchronously, with no await between these operations.
    prior = submitted.get(id);
    if (prior && prior !== audio.sha256) throw error('analysis_request_id_conflict');
    if (!prior && submitted.size >= 1024) throw error('diarization_client_capacity_reached');
    if (!prior) submitted.set(id, audio.sha256);
    const deadline = performance.now() + timeoutMs;
    try {
      if (!prior) {
        postAttempts = 1;
        try {
          const value = await call('/v1/diarizations', { method: 'POST', body: audio.bytes,
            id, signal, deadline, token });
          const accepted = validateReceipt(value, id, audio.sha256);
          if (accepted.state !== 'running') return { audioHandle, ...summary(accepted, postAttempts) };
        } catch {
          // An upload reply may be lost after acceptance. Never POST again; query the original UUID only.
        }
      }
      for (;;) {
        if (signal?.aborted) return unknown('diarization_cancelled');
        if (performance.now() >= deadline) return unknown('diarization_timeout');
        try {
          const value = await call('/v1/diarizations/' + id, { signal, deadline, token });
          const current = validateReceipt(value, id, audio.sha256);
          if (current.state !== 'running') return { audioHandle, ...summary(current, postAttempts) };
        } catch (failure) {
          if (signal?.aborted) return unknown('diarization_cancelled');
          if (failure instanceof AnalysisError && /(?:receipt_mismatch|result_invalid|segment_invalid|labels_mismatch|response_invalid|response_too_large)$/.test(failure.message)) {
            return unknown(failure.message);
          }
          // GET transport errors/404 do not prove the POST failed; bounded polling is read-only.
        }
        await bounded(() => new Promise(resolve => setTimeout(resolve, pollIntervalMs)), signal,
          Math.min(pollIntervalMs + 20, Math.max(1, deadline - performance.now())));
      }
    } catch {
      return unknown(signal?.aborted ? 'diarization_cancelled' : 'diarization_timeout');
    }
  }

  async function status({ signal } = {}) {
    const value = await call('/v1/status', { signal, deadline: performance.now() + requestTimeoutMs });
    if (value?.service !== 'canbot-diarization-sidecar' || typeof value.busy !== 'boolean'
      || value.speaker_scope !== 'this_recording_only' || value.speaker_identity_assigned !== false
      || value.overlap_preserved !== true || value.always_listening !== false) throw error('diarization_status_invalid');
    return { service: value.service, busy: value.busy, speakerScope: value.speaker_scope,
      speakerIdentityAssigned: false, overlapPreserved: true, alwaysListening: false,
      maxDurationSeconds: value.max_duration_seconds, mainlineMaxDurationSeconds: 10,
      jobTimeoutSeconds: value.job_timeout_seconds };
  }

  return Object.freeze({ analyze, receipt, status });
}
