import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiarizationClient } from '../src/diarization.mjs';

const TOKEN = 'a'.repeat(64);
const HANDLE = 'log:0123456789abcdef0123.wav';
function wav(frames = 16000, rate = 16000) {
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  return bytes;
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function receipt(id, bytes, state = 'complete') {
  return { schema_version: 'canbot.diarization-sidecar-job.v1', request_id: id, state,
    replay_permitted: false, input: { sha256: hash(bytes), frames: (bytes.length - 44) / 2,
      duration_seconds: (bytes.length - 44) / 32000, sample_rate_hz: 16000, channels: 1, sample_width_bytes: 2 },
    ...(state === 'complete' ? { diarization: { speaker_scope: 'this_recording_only',
      speaker_identity_assigned: false, accuracy_accepted: false, overlap_preserved: true,
      transcription_performed: false, separated_waveforms_produced: false,
      speaker_count: 2, speaker_labels: ['anonymous_01', 'anonymous_02'],
      segments: [{ start: 0.1, end: 0.7, track: '0', speaker: 'anonymous_01' },
        { start: 0.1, end: 0.7, track: '1', speaker: 'anonymous_02' },
        { start: 0.5, end: 0.9, track: '2', speaker: 'anonymous_01' }] } } : {}) };
}
function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
async function fixture(t, fetchImpl, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'canbot-diarization-test-'));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, TOKEN + '\n', { mode: 0o600 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { client: createDiarizationClient({ tokenFile, fetchImpl,
    timeoutMs: 2000, requestTimeoutMs: 1000, pollIntervalMs: 1, ...options }), tokenFile };
}

test('one POST, GET completion, anonymous overlap and duplicate intervals preserved', async t => {
  const bytes = wav(), id = randomUUID(), requests = [];
  const { client } = await fixture(t, async (url, options) => {
    requests.push({ method: options.method, path: url.pathname });
    assert.equal(url.origin, 'http://127.0.0.1:8053');
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(options.redirect, 'error');
    if (options.method === 'POST') {
      assert.equal(options.headers['X-Request-ID'], id);
      assert.equal(options.headers['Content-Length'], String(bytes.length));
      assert.deepEqual(options.body, bytes);
      return response(receipt(id, bytes, 'running'), 202);
    }
    return response(receipt(id, bytes));
  });
  const result = await client.analyze({ audioHandle: HANDLE, audioBytes: bytes, requestId: id });
  assert.equal(result.state, 'complete'); assert.equal(result.postAttempts, 1);
  assert.equal(result.inputSha256, hash(bytes)); assert.equal(result.segments.length, 3);
  assert.deepEqual(result.segments.slice(0, 2).map(s => [s.start, s.end]), [[0.1, 0.7], [0.1, 0.7]]);
  assert.equal(result.receipt.diarization.speaker_identity_assigned, false);
  assert.deepEqual(requests.map(r => r.method), ['POST', 'GET']);
});

test('lost POST reply is recovered by GET without replay', async t => {
  const bytes = wav(), id = randomUUID(); let posts = 0, gets = 0;
  const { client } = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') { posts++; throw new Error('private ' + TOKEN); }
    gets++; return response(receipt(id, bytes));
  });
  const result = await client.analyze({ audioHandle: HANDLE, audioBytes: bytes, requestId: id });
  assert.equal(result.state, 'complete'); assert.equal(posts, 1); assert.equal(gets, 1);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('same UUID within client only GETs on subsequent analyze; conflicting bytes rejected', async t => {
  const bytes = wav(), id = randomUUID(); let posts = 0;
  const { client } = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') posts++;
    return response(receipt(id, bytes));
  });
  await client.analyze({ audioHandle: HANDLE, audioBytes: bytes, requestId: id });
  const result = await client.analyze({ audioHandle: HANDLE, audioBytes: bytes, requestId: id });
  assert.equal(result.postAttempts, 0); assert.equal(posts, 1);
  const changed = Buffer.from(bytes); changed[45] = 1;
  await assert.rejects(client.analyze({ audioHandle: HANDLE, audioBytes: changed, requestId: id }), /request_id_conflict/);
  assert.equal(posts, 1);
});

test('GET 404 after ambiguous POST stays unknown and never POSTs again', async t => {
  let posts = 0;
  const { client } = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') { posts++; throw new Error(TOKEN); }
    return response({ error: { message: TOKEN } }, 404);
  }, { timeoutMs: 250, requestTimeoutMs: 100 });
  const result = await client.analyze({ audioHandle: HANDLE, audioBytes: wav(), requestId: randomUUID() });
  assert.equal(result.state, 'outcome_unknown'); assert.equal(posts, 1);
  assert.equal(result.retryAutomatically, false); assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('concurrent same UUID same bytes performs exactly one POST', async t => {
  const bytes = wav(), id = randomUUID(); let posts = 0, gets = 0;
  const { client } = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') posts++; else gets++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return response(receipt(id, bytes));
  });
  const args = { audioHandle: HANDLE, audioBytes: bytes, requestId: id };
  const results = await Promise.all([client.analyze(args), client.analyze(args)]);
  assert.equal(posts, 1); assert.equal(gets, 1);
  assert.deepEqual(results.map(r => r.postAttempts).sort(), [0, 1]);
  assert.ok(results.every(r => r.state === 'complete'));
});

test('concurrent same UUID different bytes rejects the losing reservation before HTTP', async t => {
  const first = wav(), second = Buffer.from(first), id = randomUUID(); second[44] = 1;
  let posts = 0, uploaded;
  const { client } = await fixture(t, async (_url, options) => {
    assert.equal(options.method, 'POST'); posts++; uploaded = Buffer.from(options.body);
    await new Promise(resolve => setTimeout(resolve, 10));
    return response(receipt(id, uploaded));
  });
  const results = await Promise.allSettled([first, second].map(bytes => client.analyze({
    audioHandle: HANDLE, audioBytes: bytes, requestId: id,
  })));
  assert.equal(posts, 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected');
  assert.equal(rejected.reason.message, 'analysis_request_id_conflict');
  assert.equal(results.find(r => r.status === 'fulfilled').value.inputSha256, hash(uploaded));
});

test('cancel before submission performs no HTTP request', async t => {
  let requests = 0; const controller = new AbortController(); controller.abort();
  const { client } = await fixture(t, async () => { requests++; throw new Error(); });
  const result = await client.analyze({ audioHandle: HANDLE, audioBytes: wav(), requestId: randomUUID(), signal: controller.signal });
  assert.equal(result.postAttempts, 0); assert.equal(requests, 0);
  assert.equal(result.state, 'outcome_unknown');
});

test('cancel during upload exits unknown, never implies backend cancellation', async t => {
  const controller = new AbortController(); let requests = 0;
  const { client } = await fixture(t, async () => {
    requests++; setTimeout(() => controller.abort(), 5);
    return new Promise(() => {}); // Deliberately ignore fetch abort to exercise absolute race.
  });
  const result = await client.analyze({ audioHandle: HANDLE, audioBytes: wav(), requestId: randomUUID(), signal: controller.signal });
  assert.equal(result.state, 'outcome_unknown'); assert.equal(requests, 1);
  assert.equal(result.serverCancellationConfirmed, false);
});

test('late completion after total deadline cannot become success', async t => {
  const bytes = wav(), id = randomUUID(); let posts = 0;
  const { client } = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') posts++;
    await new Promise(resolve => setTimeout(resolve, 300));
    return response(receipt(id, bytes));
  }, { timeoutMs: 100, requestTimeoutMs: 75 });
  const result = await client.analyze({ audioHandle: HANDLE, audioBytes: bytes, requestId: id });
  assert.equal(result.state, 'outcome_unknown'); assert.equal(posts, 1);
});

test('never ending response body hits total deadline', async t => {
  const { client } = await fixture(t, async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{'));
  } }), { headers: { 'content-type': 'application/json' } }), { timeoutMs: 100, requestTimeoutMs: 30 });
  const result = await client.analyze({ audioHandle: HANDLE, audioBytes: wav(), requestId: randomUUID() });
  assert.equal(result.state, 'outcome_unknown'); assert.equal(result.postAttempts, 1);
});

test('wrong UUID/hash, invalid segments and identity claims fail closed', async t => {
  for (const mutate of [r => { r.request_id = randomUUID(); }, r => { r.input.sha256 = '0'.repeat(64); },
    r => { r.diarization.segments[0].end = 2; }, r => { r.diarization.speaker_identity_assigned = true; },
    r => { r.diarization.speaker_count = 1; }]) {
    const bytes = wav(), id = randomUUID(); const value = receipt(id, bytes); mutate(value);
    const { client } = await fixture(t, async () => response(value));
    const result = await client.analyze({ audioHandle: HANDLE, audioBytes: bytes, requestId: id });
    assert.equal(result.state, 'outcome_unknown');
  }
});

test('server unknown/failed retained without fabrication or retry', async t => {
  for (const state of ['unknown', 'failed']) {
    const bytes = wav(), id = randomUUID(); let calls = 0;
    const { client } = await fixture(t, async () => { calls++; return response(receipt(id, bytes, state)); });
    const result = await client.analyze({ audioHandle: HANDLE, audioBytes: bytes, requestId: id });
    assert.equal(result.state, state === 'unknown' ? 'outcome_unknown' : 'failed');
    assert.equal(calls, 1); assert.equal(result.segments, undefined);
  }
});

test('receipt recovery does GET only and validates expected input SHA', async t => {
  const bytes = wav(), id = randomUUID(); const methods = [];
  const { client } = await fixture(t, async (_url, options) => { methods.push(options.method); return response(receipt(id, bytes)); });
  const result = await client.receipt({ requestId: id, expectedInputSha256: hash(bytes) });
  assert.equal(result.state, 'complete'); assert.equal(result.postAttempts, 0);
  await assert.rejects(client.receipt({ requestId: id, expectedInputSha256: '0'.repeat(64) }), /receipt_mismatch/);
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('non-log paths, invalid audio and over-10-second mainline input reject before HTTP', async t => {
  let requests = 0;
  const { client } = await fixture(t, async () => { requests++; throw new Error(); });
  for (const handle of ['mem:audio.wav', '/tmp/audio.wav', 'https://example.com/a.wav', 'log:../audio.wav']) {
    await assert.rejects(client.analyze({ audioHandle: handle, audioBytes: wav(), requestId: randomUUID() }), /log_wav/);
  }
  for (const bytes of [Buffer.from('bad'), wav(16000, 8000), wav(160001)]) {
    await assert.rejects(client.analyze({ audioHandle: HANDLE, audioBytes: bytes, requestId: randomUUID() }), /wav_/);
  }
  assert.equal(requests, 0);
});

test('only exact 127.0.0.1:8053 HTTP base permitted and construction has no IO', () => {
  for (const baseURL of ['http://localhost:8053', 'http://127.0.0.1:8051', 'http://10.0.0.3:8053',
    'https://127.0.0.1:8053', 'http://x:y@127.0.0.1:8053', 'http://127.0.0.1:8053/path', 'http://127.0.0.1:8053/?x=1']) {
    assert.throws(() => createDiarizationClient({ baseURL }), /loopback_url/);
  }
  assert.doesNotThrow(() => createDiarizationClient({ tokenFile: '/does/not/exist' }));
});

test('missing/malformed token fails before any POST and hides private paths', async t => {
  let requests = 0;
  const { client, tokenFile } = await fixture(t, async () => { requests++; throw new Error(); });
  await writeFile(tokenFile, 'invalid-private-secret');
  await assert.rejects(client.analyze({ audioHandle: HANDLE, audioBytes: wav(), requestId: randomUUID() }), error => {
    assert.equal(error.message, 'analysis_private_token_unavailable');
    assert.ok(!error.message.includes(tokenFile)); return true;
  });
  assert.equal(requests, 0);
});

test('insecure token permissions rejected on POSIX', { skip: process.platform === 'win32' }, async t => {
  const { client, tokenFile } = await fixture(t, async () => { throw new Error('must not call'); });
  await chmod(tokenFile, 0o644);
  await assert.rejects(client.analyze({ audioHandle: HANDLE, audioBytes: wav(), requestId: randomUUID() }), /private_token_unavailable/);
});

test('oversized or non-JSON response is unknown, never returned raw', async t => {
  for (const fake of [() => new Response('private ' + TOKEN, { headers: { 'content-type': 'text/plain' } }),
    () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })]) {
    const { client } = await fixture(t, async () => fake());
    const result = await client.analyze({ audioHandle: HANDLE, audioBytes: wav(), requestId: randomUUID() });
    assert.equal(result.state, 'outcome_unknown'); assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});

test('status exposes file-only capability and no arbitrary server data', async t => {
  const { client } = await fixture(t, async () => response({ service: 'canbot-diarization-sidecar', busy: false,
    speaker_scope: 'this_recording_only', speaker_identity_assigned: false, overlap_preserved: true,
    always_listening: false, max_duration_seconds: 90, job_timeout_seconds: 180, secret: TOKEN }));
  const value = await client.status();
  assert.equal(value.mainlineMaxDurationSeconds, 10); assert.equal(value.maxDurationSeconds, 90);
  assert.ok(!JSON.stringify(value).includes(TOKEN));
});
