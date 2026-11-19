import { setTimeout as delay } from 'node:timers/promises';
import { AnalysisError, AnalysisJournal, AUDIO_HANDLE, UUID, parseAnalysisWav, readSidecarToken,
  sha256, sidecarURL, directLoopbackFetch } from './audio-analysis.mjs';

const TERMINAL = new Set(['complete', 'partial', 'failed', 'unknown']);
const FILES = ['anonymous_1.wav', 'anonymous_2.wav'];
const SAFE_STATES = new Set(['running', ...TERMINAL]);
const unknown = (requestId, code, extra = {}) => ({ requestId, state: 'unknown', outcome: 'outcome_unknown',
  code, retryAutomatically: false, backendStopped: false, ...extra });

export function createSeparationClient({ baseURL, tokenFile, journalDir, fetchImpl = directLoopbackFetch,
  clock = () => Date.now(), wait = (ms, signal) => delay(ms, undefined, { signal }),
  totalTimeoutMs = 128000, requestTimeoutMs = 5000, pollIntervalMs = 500 }) {
  const base = sidecarURL(baseURL, 8051), journal = new AnalysisJournal(journalDir, 'separation');
  if (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 128000
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 5000) {
    throw new AnalysisError('analysis_timeout_invalid');
  }
  async function request(path, { signal, method = 'GET', body, requestId } = {}) {
    const token = await readSidecarToken(tokenFile);
    const headers = { Host: '127.0.0.1:8051', Accept: 'application/json', Authorization: `Bearer ${token}` };
    if (body) Object.assign(headers, { 'Content-Type': 'audio/wav', 'Content-Length': String(body.length), 'X-Request-ID': requestId });
    return fetchImpl(new URL(path, base), { method, headers, body, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs) });
  }
  async function json(response) {
    // Bounded by directLoopbackFetch as well; also protect injected transports.
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new AnalysisError('analysis_receipt_invalid');
    try { return JSON.parse(text); } catch { throw new AnalysisError('analysis_receipt_invalid'); }
  }
  function validate(receipt, requestId, expected) {
    if (receipt?.schema_version !== 'canbot.separation-sidecar-job.v1' || receipt.request_id !== requestId
      || !SAFE_STATES.has(receipt.state) || !/^[0-9a-f]{64}$/.test(receipt.input?.sha256 ?? '')
      || !Number.isInteger(receipt.input.frames) || receipt.input.frames < 8000 || receipt.input.frames > 160000
      || receipt.input.sample_rate_hz !== 16000 || typeof receipt.options?.transcribe !== 'boolean'
      || !['auto', 'zh', 'en'].includes(receipt.options?.language)
      || (expected && (receipt.input.sha256 !== expected.audioSha256
        || receipt.options?.transcribe !== expected.options.transcribe || receipt.options?.language !== expected.options.language))) {
      throw new AnalysisError('analysis_receipt_identity_mismatch');
    }
    return receipt;
  }
  function safeReceipt(receipt, audioHandle) {
    const input = receipt.input;
    const items = Array.isArray(receipt.asr?.items) ? receipt.asr.items : [];
    if (items.length > 3 || items.some(item => !['original.wav', ...FILES].includes(item.file)
      || (item.text !== undefined && (typeof item.text !== 'string' || item.text.length > 20000)))) {
      throw new AnalysisError('analysis_receipt_invalid');
    }
    return { requestId: receipt.request_id, state: receipt.state, input: {
      audioHandle: audioHandle ?? null, sha256: input.sha256, frames: input.frames,
      sampleRateHz: input.sample_rate_hz, originalPreserved: true,
    }, separation: { state: receipt.separation?.state ?? 'unknown', anonymous: true,
      speakerIdentityAssigned: false, accuracyAccepted: false, speakerScope: 'this_recording_only',
      // A numerical completion is not a claim that there were exactly two people.
      actualSpeakerCount: 'unknown' },
    asr: { requested: receipt.asr?.requested === true, state: receipt.asr?.state ?? 'unknown',
      language: receipt.asr?.language ?? null, model: receipt.asr?.model ?? null,
      items: items.map(item => ({ file: item.file, state: item.state, text: item.text ?? null,
        detectedLanguage: item.detected_language ?? null, seconds: item.seconds ?? null })) },
    retryAutomatically: false, backendStopped: false };
  }
  async function finish(receipt, expected, signal, includeAudio) {
    const result = safeReceipt(receipt, expected?.audioHandle);
    await journal.settle(receipt.request_id, receipt.state);
    if (!includeAudio || receipt.separation?.state !== 'complete') return result;
    const blobs = [];
    for (const file of FILES) {
      const path = `/v1/separations/${receipt.request_id}/audio/${file}`;
      const artifact = receipt.separation.artifacts?.[file];
      if (receipt.audio_urls?.[file] !== path || !/^[0-9a-f]{64}$/.test(artifact?.sha256 ?? '')) {
        throw new AnalysisError('analysis_artifact_receipt_invalid');
      }
      const response = await request(path, { signal });
      if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'audio/wav') {
        throw new AnalysisError('analysis_artifact_download_failed');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const wav = parseAnalysisWav(bytes);
      if (sha256(bytes) !== artifact.sha256 || wav.frames !== artifact.frames
        || wav.frames !== receipt.input.frames) throw new AnalysisError('analysis_artifact_identity_mismatch');
      blobs.push({ bytes, mime: 'audio/wav', name: `${receipt.request_id}-${file}`,
        fallbackText: `Explicit robot recording ${expected?.audioHandle ?? '(original retained)'}; anonymous separation track ${file}; SHA256 ${artifact.sha256}. No speaker identity or accuracy is established.` });
    }
    return { ...result, blobs };
  }
  async function receipt({ requestId, signal, includeAudio = false }) {
    if (!UUID.test(requestId ?? '') || typeof includeAudio !== 'boolean') throw new AnalysisError('analysis_arguments_invalid');
    const expected = await journal.read(requestId);
    if (!expected) return unknown(requestId, 'analysis_request_not_registered');
    try {
      const response = await request(`/v1/separations/${requestId}`, { signal });
      if (!response.ok) return unknown(requestId, response.status === 404 ? 'analysis_receipt_not_found' : 'analysis_receipt_unavailable');
      return await finish(validate(await json(response), requestId, expected), expected, signal, includeAudio);
    } catch { return unknown(requestId, signal?.aborted ? 'waiting_cancelled' : 'analysis_receipt_unavailable'); }
  }
  async function analyze({ audioHandle, audioBytes, requestId, transcribe = false, language = 'auto', signal }) {
    if (!AUDIO_HANDLE.test(audioHandle ?? '') || !UUID.test(requestId ?? '')
      || typeof transcribe !== 'boolean' || !['auto', 'zh', 'en'].includes(language)) throw new AnalysisError('analysis_arguments_invalid');
    if (signal?.aborted) return unknown(requestId, 'waiting_cancelled', { submitted: false });
    const wav = parseAnalysisWav(audioBytes), options = { transcribe, language };
    // Read credentials before reservation; failure cannot leak a token/file path or send audio.
    await readSidecarToken(tokenFile);
    const { prior, reserved } = await journal.reserve({ requestId, audioHandle, sha256: wav.sha256, options });
    const deadline = clock() + totalTimeoutMs;
    const timer = AbortSignal.timeout(totalTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;
    let received;
    try {
      if (reserved) {
        try {
          const response = await request(`/v1/separations?transcribe=${transcribe}&language=${language}`,
            { method: 'POST', body: wav.bytes, requestId, signal: combined });
          if ([200, 202].includes(response.status)) received = validate(await json(response), requestId, prior);
          else if ([400, 401, 403, 409, 411, 413, 415, 422, 507].includes(response.status)) {
            await journal.settle(requestId, 'rejected');
            return { requestId, state: 'rejected', code: `analysis_http_${response.status}`, retryAutomatically: false };
          }
        } catch { /* lost/invalid reply: never POST again, only query the recorded UUID */ }
      }
      for (;;) {
        if (combined.aborted || clock() >= deadline) return unknown(requestId, signal?.aborted ? 'waiting_cancelled' : 'analysis_deadline');
        if (received && TERMINAL.has(received.state)) return await finish(received, prior, combined, true);
        const response = await request(`/v1/separations/${requestId}`, { signal: combined });
        if (response.status === 404) return unknown(requestId, 'analysis_receipt_not_found');
        if (response.ok) received = validate(await json(response), requestId, prior);
        if (received && TERMINAL.has(received.state)) return await finish(received, prior, combined, true);
        await wait(pollIntervalMs, combined);
      }
    } catch { return unknown(requestId, signal?.aborted ? 'waiting_cancelled' : 'analysis_observation_failed'); }
  }
  return { analyze, receipt, status: async ({ signal } = {}) => {
    try { const response = await request('/v1/status', { signal });
      if (!response.ok) throw new Error('unavailable');
      const data = await json(response);
      return { available: true, busy: data.busy === true, explicitRequestsOnly: true, maxDurationSeconds: 10 };
    } catch { return { available: false, code: 'analysis_status_unavailable' }; }
  } };
}
