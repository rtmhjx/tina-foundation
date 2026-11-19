import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AnalysisJournal, parseAnalysisWav, resolveLogAudio, readSidecarToken,
  sha256, sidecarURL, directLoopbackFetch } from '../src/audio-analysis.mjs';
import { createSeparationClient } from '../src/separation.mjs';
import { CanbotWorld } from '../src/world.mjs';
import { CANBOT_DEFAULTS } from '../src/config.mjs';

const ID = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222';
const HANDLE = 'log:3b6b8236b3c56333f0ad.wav', TOKEN = 'a'.repeat(64);
function wav(seconds = 1) {
  const frames = Math.round(seconds * 16000), bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  return bytes;
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'canbot-separation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token'), journalDir = join(directory, 'journal');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const calls = [], bytes = wav();
  const f = { directory, tokenFile, journalDir, calls, bytes, posts: () => calls.filter(c => c.method === 'POST') };
  f.job = (state = 'complete', extra = {}) => ({ schema_version: 'canbot.separation-sidecar-job.v1', request_id: ID, state,
    input: { sha256: sha256(bytes), frames: 16000, sample_rate_hz: 16000 }, options: { transcribe: false, language: 'auto' },
    separation: { state: state === 'partial' ? 'complete' : state, artifacts: Object.fromEntries(['anonymous_1.wav', 'anonymous_2.wav'].map(file => [file, { sha256: sha256(bytes), frames: 16000 }])) },
    audio_urls: Object.fromEntries(['anonymous_1.wav', 'anonymous_2.wav'].map(file => [file, `/v1/separations/${ID}/audio/${file}`])),
    asr: { requested: false, state: 'not_requested', items: [] }, ...extra });
  f.fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.Host, '127.0.0.1:8051'); assert.equal(init.headers.Origin, undefined);
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.Expect, undefined);
    const call = { path: url.pathname + url.search, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const custom = await options.onRequest?.(url, init, f);
    if (custom) return custom;
    if (init.method === 'POST') {
      const saved = JSON.parse(await readFile(join(journalDir, `separation-${ID}.json`), 'utf8'));
      assert.equal(saved.audioSha256, sha256(bytes)); assert.equal(saved.state, 'outcome_unknown');
      assert.equal(init.headers['Content-Length'], String(bytes.length));
      assert.deepEqual(init.body, bytes);
      return Response.json(f.job('running'), { status: 202 });
    }
    if (url.pathname.endsWith('.wav')) return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
    return Response.json(f.job());
  };
  f.client = createSeparationClient({ baseURL: 'http://127.0.0.1:8051', tokenFile, journalDir, fetchImpl: f.fetchImpl,
    wait: async () => {}, ...options.client });
  f.analyze = args => f.client.analyze({ audioHandle: HANDLE, audioBytes: bytes, requestId: ID, ...args });
  return f;
}

test('WAV validates complete PCM payload and inclusive half-second/ten-second boundaries without mutation', () => {
  for (const seconds of [0.5, 1, 10]) { const bytes = wav(seconds), parsed = parseAnalysisWav(bytes);
    assert.equal(parsed.seconds, seconds); parsed.bytes[44] = 1; assert.equal(bytes[44], 0); }
  for (const seconds of [0.4999375, 10.0000625]) assert.throws(() => parseAnalysisWav(wav(seconds)), /duration/);
  for (const mutate of [b => b.writeUInt32LE(b.length, 4), b => b.writeUInt16LE(2, 22),
    b => b.writeUInt32LE(8000, 24), b => b.writeUInt16LE(8, 34), b => b.writeUInt32LE(18, 16)]) {
    const bytes = wav(); mutate(bytes); assert.throws(() => parseAnalysisWav(bytes), /wav/);
  }
  assert.throws(() => parseAnalysisWav(Buffer.alloc(400000)), /wav/);
});

test('only existing log WAV handles resolve; no file/URL/mem fallback or MIME downgrade', async () => {
  const calls = [], host = { blob: handle => { calls.push(handle); return { bytes: wav(), mime: 'audio/wav' }; } };
  for (const handle of ['mem:test.wav', 'C:/secret.wav', 'http://127.0.0.1/test.wav', 'log:../a.wav', 'log:file.mp3']) {
    await assert.rejects(resolveLogAudio(host, handle), /handle_required/);
  }
  assert.equal(calls.length, 0); assert.equal((await resolveLogAudio(host, HANDLE)).seconds, 1);
  await assert.rejects(resolveLogAudio({ blob: () => ({ bytes: wav(), mime: 'video/mp4' }) }, HANDLE), /unavailable/);
  await assert.rejects(resolveLogAudio({ blob: () => { throw new Error('private-path'); } }, HANDLE), error => !error.message.includes('private-path'));
});

test('base URL accepts only exact IPv4 loopback origin with no credentials, path, query or fragment', () => {
  assert.equal(sidecarURL('http://127.0.0.1:8051', 8051).port, '8051');
  for (const url of ['http://localhost:8051', 'http://[::1]:8051', 'http://10.0.0.3:8051', 'https://127.0.0.1:8051',
    'http://127.0.0.1:8053', 'http://secret@127.0.0.1:8051', 'http://127.0.0.1:8051/a', 'http://127.0.0.1:8051/?key=x']) {
    assert.throws(() => sidecarURL(url, 8051), /loopback/);
  }
});

test('credential file is read on demand and failures do not expose contents or paths', async t => {
  const f = await fixture(t); assert.equal(await readSidecarToken(f.tokenFile), TOKEN);
  await writeFile(f.tokenFile, 'private-secret-not-a-token');
  await assert.rejects(readSidecarToken(f.tokenFile), error => error.message === 'analysis_private_token_unavailable');
  await assert.rejects(f.analyze(), /private_token/); assert.equal(f.calls.length, 0);
});

test('single POST is recorded first; terminal tracks are hash/frame verified and original remains unchanged', async t => {
  const f = await fixture(t), before = Buffer.from(f.bytes), result = await f.analyze();
  assert.equal(f.posts().length, 1); assert.equal(result.state, 'complete'); assert.equal(result.blobs.length, 2);
  assert.equal(result.input.audioHandle, HANDLE); assert.equal(result.input.originalPreserved, true);
  assert.equal(result.separation.speakerIdentityAssigned, false); assert.equal(result.separation.accuracyAccepted, false);
  assert.equal(result.separation.actualSpeakerCount, 'unknown'); assert.deepEqual(f.bytes, before);
  assert(!JSON.stringify(result).includes(TOKEN)); assert(!JSON.stringify(result).includes(f.tokenFile));
  assert(f.calls.every(c => c.path.startsWith('/v1/separations')));
});

test('same request ID after client restart sends GET only; new ID cannot replay unsettled same audio', async t => {
  const f = await fixture(t, { onRequest: url => url.pathname.endsWith(ID) ? Response.json({}, { status: 404 }) : undefined });
  const first = await f.analyze(); assert.equal(first.state, 'unknown');
  const again = createSeparationClient({ baseURL: 'http://127.0.0.1:8051', tokenFile: f.tokenFile,
    journalDir: f.journalDir, fetchImpl: f.fetchImpl, wait: async () => {} });
  assert.equal((await again.analyze({ audioHandle: HANDLE, audioBytes: f.bytes, requestId: ID })).state, 'unknown');
  assert.equal(f.posts().length, 1);
  await assert.rejects(f.analyze({ requestId: ID2 }), /unsettled_audio_use_original_request_id/);
  await assert.rejects(f.analyze({ language: 'zh' }), /request_id_conflict/); assert.equal(f.posts().length, 1);
});

test('lost POST response is recovered only by original-ID GET, never another POST', async t => {
  const f = await fixture(t, { onRequest: (_url, init) => { if (init.method === 'POST') throw new Error('lost token private detail'); } });
  const result = await f.analyze(); assert.equal(result.state, 'complete'); assert.equal(f.posts().length, 1);
  assert.equal(f.calls.filter(c => c.method === 'GET' && c.path.endsWith(ID)).length, 1);
});

test('unregistered receipts send no HTTP; running stays running and partial retains anonymous WAVs', async t => {
  const f = await fixture(t);
  const missing = await f.client.receipt({ requestId: ID }); assert.equal(missing.code, 'analysis_request_not_registered'); assert.equal(f.calls.length, 0);
  const journal = new AnalysisJournal(f.journalDir, 'separation');
  await journal.reserve({ requestId: ID, audioHandle: HANDLE, sha256: sha256(f.bytes), options: { transcribe: false, language: 'auto' } });
  f.fetchImpl = async () => Response.json(f.job('running'));
  const running = createSeparationClient({ baseURL: 'http://127.0.0.1:8051', tokenFile: f.tokenFile, journalDir: f.journalDir, fetchImpl: f.fetchImpl });
  assert.equal((await running.receipt({ requestId: ID })).state, 'running');
  const partial = createSeparationClient({ baseURL: 'http://127.0.0.1:8051', tokenFile: f.tokenFile, journalDir: f.journalDir,
    fetchImpl: async url => url.pathname.endsWith('.wav') ? new Response(f.bytes, { headers: { 'Content-Type': 'audio/wav' } })
      : Response.json(f.job('partial', { asr: { requested: true, state: 'partial', items: [{ file: 'anonymous_1.wav', state: 'failed' }] } })) });
  const result = await partial.receipt({ requestId: ID, includeAudio: true });
  assert.equal(result.state, 'partial'); assert.equal(result.blobs.length, 2); assert.equal(result.asr.items[0].state, 'failed');
});

test('unknown/identity-mismatched receipts and malicious artifact URLs never cause a new POST or cross-origin fetch', async t => {
  for (const kind of ['unknown', 'hash', 'url', 'artifact']) {
    const f = await fixture(t, { onRequest: (url, init, f) => {
      if (init.method === 'POST') return Response.json(f.job('running'), { status: 202 });
      if (url.pathname.endsWith(ID)) {
        const job = f.job(kind === 'unknown' ? 'unknown' : 'complete');
        if (kind === 'hash') job.input.sha256 = 'f'.repeat(64);
        if (kind === 'url') job.audio_urls['anonymous_1.wav'] = 'http://example.invalid/private';
        if (kind === 'artifact') job.separation.artifacts['anonymous_1.wav'].sha256 = 'f'.repeat(64);
        return Response.json(job);
      }
    } });
    const result = await f.analyze(); assert.equal(result.state, 'unknown'); assert.equal(f.posts().length, 1);
    assert(f.calls.every(c => c.path.startsWith('/v1/separations')));
    if (kind === 'url') assert.equal(f.calls.some(c => c.path.endsWith('.wav')), false);
  }
});

test('cancellation stops waiting, preserves UUID, and never claims backend termination or sends STOP/DELETE', async t => {
  const abort = new AbortController();
  const f = await fixture(t, { onRequest: (url, init, f) => {
    if (url.pathname.endsWith(ID)) { abort.abort(); throw new Error('abort'); }
  } });
  const result = await f.analyze({ signal: abort.signal });
  assert.equal(result.code, 'waiting_cancelled'); assert.equal(result.requestId, ID); assert.equal(result.backendStopped, false);
  assert.equal(result.retryAutomatically, false); assert.equal(f.posts().length, 1);
  assert(f.calls.every(c => ['GET', 'POST'].includes(c.method)));
  assert.equal(JSON.parse(await readFile(join(f.journalDir, `separation-${ID}.json`))).state, 'outcome_unknown');
});

test('bounded separation observation deadline retains unknown and never resubmits a running job', async t => {
  let now = 0;
  const f = await fixture(t, { client: { clock: () => now, totalTimeoutMs: 100,
    wait: async () => { now += 101; } }, onRequest: (_url, _init, f) => Response.json(f.job('running'), { status: 202 }) });
  const result = await f.analyze(); assert.equal(result.state, 'unknown'); assert.equal(result.code, 'analysis_deadline');
  assert.equal(result.backendStopped, false); assert.equal(f.posts().length, 1);
});

test('strict boolean/language/UUID inputs reject before private upload and concurrent same-ID calls cannot POST twice', async t => {
  const f = await fixture(t);
  for (const args of [{ transcribe: 'true' }, { transcribe: null }, { language: 'ja' }, { requestId: '../old' }]) {
    await assert.rejects(f.analyze(args), /arguments_invalid/);
  }
  assert.equal(f.calls.length, 0);
  await Promise.allSettled([f.analyze(), f.analyze()]); assert.equal(f.posts().length, 1);
});

test('disk directory sync is required before submission and after settle; stale reservation locks remain for manual recovery', async t => {
  const f = await fixture(t), syncs = [];
  const journal = new AnalysisJournal(f.journalDir, 'separation', { syncDirectory: async path => syncs.push(path) });
  await journal.reserve({ requestId: ID, audioHandle: HANDLE, sha256: sha256(f.bytes), options: {} });
  await journal.settle(ID, 'complete'); assert.deepEqual(syncs, [f.journalDir, f.journalDir]);
  await writeFile(join(f.journalDir, '.reservation.lock'), 'retained', { mode: 0o600 });
  await assert.rejects(journal.reserve({ requestId: ID2, audioHandle: HANDLE, sha256: sha256(f.bytes), options: {} }), /journal_unavailable/);
  assert.equal(await readFile(join(f.journalDir, '.reservation.lock'), 'utf8'), 'retained');
  const broken = new AnalysisJournal(join(f.directory, 'broken'), 'separation', { syncDirectory: async () => { throw new Error('disk unavailable'); } });
  await assert.rejects(broken.reserve({ requestId: ID, audioHandle: HANDLE, sha256: sha256(f.bytes), options: {} }), /journal_unavailable/);
  assert.equal(f.calls.length, 0);
});

test('direct transport ignores global fetch and HTTP proxy variables; sends known length without chunked/Origin', async t => {
  const server = createServer((req, res) => {
    assert.equal(req.headers['content-length'], '3'); assert.equal(req.headers['transfer-encoding'], undefined);
    assert.equal(req.headers.origin, undefined); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await directLoopbackFetch(new URL(`http://127.0.0.1:${server.address().port}/`), {
    method: 'POST', headers: { 'Content-Length': '3' }, body: Buffer.from('wav'), signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200);
});

test('direct transport deadline aborts a stalled response body instead of publishing a late success', async t => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(directLoopbackFetch(new URL(`http://127.0.0.1:${server.address().port}/`), {
    headers: {}, signal: AbortSignal.timeout(100), method: 'GET' }));
});

test('World tool is optional, requires explicit existing blob, and returns track attachments without device calls', async t => {
  const f = await fixture(t), hostCalls = [];
  const world = new CanbotWorld({ cfg: { ...CANBOT_DEFAULTS, separationEnabled: true } });
  world.lifecycle = new AbortController(); world.separation = f.client;
  world.host = { blob: handle => { hostCalls.push(handle); return { mime: 'audio/wav', bytes: f.bytes }; } };
  const tool = world.tools().find(t => t.name === 'canbot_separate_audio');
  assert(tool.interruptible); const result = await tool.handler({ audio: HANDLE, requestId: ID }, {});
  assert.equal(result.failed, undefined); assert.equal(result.blobs.length, 2); assert.deepEqual(hostCalls, [HANDLE]);
  for (const args of [{ audio: HANDLE, requestId: ID, raw: true }, { audio: 'mem:a.wav', requestId: ID }]) {
    assert.equal((await tool.handler(args, {})).failed, true);
  }
  assert.equal(f.posts().length, 1); assert.equal(new CanbotWorld({ cfg: { ...CANBOT_DEFAULTS } }).tools().some(t => t.name === tool.name), false);
  world.lifecycle.abort();
});
