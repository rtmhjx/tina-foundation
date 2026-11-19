/** Existing 5810 local Whisper endpoint; no request until invoked with a WAV. */
export function createSttPort({ base = 'http://127.0.0.1:8042', model = 'Systran/faster-whisper-small',
  timeoutMs = 120000, fetchImpl = fetch } = {}) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '8042'
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw Error('stt_configuration_invalid');
  return async wav => {
    if (!(wav instanceof Uint8Array) || wav.length < 44 || wav.length > 1920044) throw Error('stt_wav_invalid');
    const body = new FormData(); body.append('file', new Blob([wav], { type: 'audio/wav' }), 'robot.wav');
    body.append('model', model); body.append('language', 'zh'); body.append('response_format', 'json');
    const response = await fetchImpl(new URL('/v1/audio/transcriptions', url), {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw Error('stt_failed');
    const raw = await response.text(); if (raw.length > 100000) throw Error('stt_response_too_large');
    const result = JSON.parse(raw);
    if (typeof result?.text !== 'string' || result.text.length > 10000) throw Error('stt_response_invalid');
    return result.text;
  };
}
