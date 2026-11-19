import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadChannel } from '../src/head-channel.mjs';
import { CanbotWorld } from '../src/world.mjs';
import { CANBOT_DEFAULTS } from '../src/config.mjs';

const TOKEN = 'a'.repeat(64), INSTANCE = '11111111-1111-4111-8111-111111111111';
const MEDIA = '33333333-3333-4333-8333-333333333333';
const CAPABILITY = { minDurationMs: 3000, maxDurationMs: 10000, defaultDurationMs: 3000, supportsCue: true };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture({ capability = CAPABILITY, lostPost = false, poll, download } = {}) {
  const calls = [], bytes = Buffer.alloc(44); bytes.write('RIFF'); bytes.write('WAVE', 8);
  let now = 0, sequence = 0, pollCount = 0, downloadCount = 0;
  const f = { capability, calls, posts: () => calls.filter(c => c.method === 'POST') };
  f.channel = new HeadChannel({ avatarBaseUrl: 'http://127.0.0.1:1', mediaBaseUrl: 'http://127.0.0.1:1',
    deviceId: 'cue-fixture', bindHost: '127.0.0.1', bindPort: 0, avatarToken: () => TOKEN, mediaToken: () => TOKEN,
    clock: () => now, fetchImpl: async (url, options) => {
      if (options.signal.aborted) throw new Error('fixture_aborted');
      const body = options.body && JSON.parse(options.body);
      calls.push({ path: url.pathname, method: options.method, body });
      if (url.pathname === '/v1/status') return Response.json({ schemaVersion: 'canbot.diagnostics.v2', foreground: true,
        instanceId: INSTANCE, lastSequence: sequence, ...(f.capability === null ? {} : { microphoneCapture: f.capability }) });
      if (options.method === 'POST') {
        sequence = body.sequence;
        if (lostPost) throw new Error('response_lost_after_acceptance');
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (url.pathname.startsWith('/v1/operations/')) {
        const step = await poll?.(++pollCount, options.signal);
        if (step?.now !== undefined) now = step.now;
        if (step?.settled === false) return Response.json({ state: 'running', settled: false });
        return Response.json({ operationId: url.pathname.split('/').at(-1), state: 'complete', settled: true,
          result: { media: { id: MEDIA, mime: 'audio/wav', bytes: bytes.length } } });
      }
      if (url.pathname === `/v1/media/${MEDIA}`) {
        await download?.(++downloadCount);
        return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
      }
      throw new Error('unexpected_fixture_request');
    } });
  return f;
}
const noTone = f => assert.equal(f.calls.some(c => c.path === '/v1/tone'), false);

test('cue defaults false and false is omitted from legacy MIC request bodies', async () => {
  for (const cue of [undefined, false]) {
    const f = fixture({ capability: null }); await f.channel.capture('microphone', undefined, undefined, cue);
    assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].body.durationMs, 3000);
    assert.equal(Object.hasOwn(f.posts()[0].body, 'cue'), false); noTone(f);
  }
});

test('supported cue uses one MIC operation; cue and extended-duration capabilities are independent', async () => {
  for (const [capability, requested, expected] of [[CAPABILITY, undefined, 6000], [CAPABILITY, 10000, 10000], [{ supportsCue: true }, undefined, 3000]]) {
    const f = fixture({ capability }); await f.channel.capture('microphone', undefined, requested, true);
    assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].path, '/v1/microphone');
    assert.equal(f.posts()[0].body.cue, true); assert.equal(f.posts()[0].body.durationMs, expected); noTone(f);
  }
});

test('unadvertised or non-boolean cue capability is unsupported before any POST', async () => {
  for (const capability of [null, {}, { ...CAPABILITY, supportsCue: false }, { ...CAPABILITY, supportsCue: 'true' }, { ...CAPABILITY, supportsCue: 1 }, { ...CAPABILITY, supportsCue: null }]) {
    const f = fixture({ capability });
    await assert.rejects(f.channel.capture('microphone', undefined, undefined, true), /microphone_cue_unsupported/);
    assert.equal(f.posts().length, 0); noTone(f);
  }
});

test('cue requires a strict boolean before any request', async () => {
  for (const cue of [null, 0, 1, 'true', 'false', {}, []]) {
    const f = fixture(); await assert.rejects(f.channel.capture('microphone', undefined, undefined, cue), /microphone_cue_invalid/);
    assert.equal(f.calls.length, 0);
  }
});

test('photo/video/tone cannot request a cue; false keeps their existing request contracts', async () => {
  for (const [kind, duration] of [['photo', undefined], ['video', 3000], ['tone', 500]]) {
    const f = fixture(); await assert.rejects(f.channel.capture(kind, undefined, undefined, true), /cue_only_supported_for_microphone/);
    assert.equal(f.calls.length, 0);
    await f.channel.capture(kind, undefined, undefined, false);
    assert.equal(f.posts()[0].body.durationMs, duration); assert.equal(Object.hasOwn(f.posts()[0].body, 'cue'), false);
  }
});

test('lost cued MIC response only polls the same ID and never falls back to a separate beep', async () => {
  const f = fixture({ lostPost: true }); await f.channel.capture('microphone', undefined, 10000, true);
  assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].body.cue, true); noTone(f);
  assert.equal(f.calls.find(c => c.path.startsWith('/v1/operations/')).path, '/v1/operations/' + f.posts()[0].body.operationId);
});

test('unknown cued result does not retry or poison the queue; next uncued capture does not inherit cue', async () => {
  const f = fixture({ poll: n => n === 1 ? { now: 18000, settled: false } : { settled: true } });
  const first = f.channel.capture('microphone', undefined, 10000, true);
  const failed = assert.rejects(first, error => error.message === 'media_not_complete' && error.details.retryAutomatically === false);
  const next = f.channel.capture('microphone', undefined, 3000, false);
  await failed; await next;
  assert.equal(f.posts().length, 2); assert.equal(f.posts()[0].body.cue, true);
  assert.equal(Object.hasOwn(f.posts()[1].body, 'cue'), false);
  assert.notEqual(f.posts()[0].body.operationId, f.posts()[1].body.operationId); noTone(f);
});

test('mediaQueue holds the next status/POST until first download finishes, then refreshes sequence', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ download: async n => { if (n === 1) { started.resolve(); await release.promise; } } });
  const first = f.channel.capture('microphone', undefined, 6000, true);
  const next = f.channel.capture('microphone', undefined, 6000, false);
  await started.promise;
  assert.equal(f.calls.filter(c => c.path === '/v1/status').length, 1); assert.equal(f.posts().length, 1);
  release.resolve(); await first; await next;
  assert.equal(f.calls.filter(c => c.path === '/v1/status').length, 2);
  assert.deepEqual(f.posts().map(c => c.body.sequence), [1, 2]); noTone(f);
});

test('queued cued capture rechecks capability and unsupported failure does not block later legacy capture', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ download: async n => { if (n === 1) { started.resolve(); await release.promise; } } });
  const first = f.channel.capture('microphone', undefined, undefined, true);
  const second = f.channel.capture('microphone', undefined, undefined, true);
  const rejected = assert.rejects(second, /microphone_cue_unsupported/);
  await started.promise; f.capability = null; release.resolve(); await first; await rejected;
  assert.equal(f.posts().length, 1);
  await f.channel.capture('microphone');
  assert.equal(f.posts().length, 2); assert.equal(f.posts()[1].body.durationMs, 3000);
  assert.equal(Object.hasOwn(f.posts()[1].body, 'cue'), false); noTone(f);
});

test('cancellation during cued MIC observation stays unknown with one POST and no tone fallback', async () => {
  const controller = new AbortController();
  const f = fixture({ poll: (_n, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('fixture_cancelled')), { once: true });
    queueMicrotask(() => controller.abort());
  }) });
  await assert.rejects(f.channel.capture('microphone', controller.signal, 10000, true), error => error.message === 'media_outcome_unknown' && error.details.retryAutomatically === false);
  assert.equal(f.posts().length, 1); assert.equal(f.calls.filter(c => c.path.startsWith('/v1/operations/')).length, 1); noTone(f);
});

test('World cue tool schema and handler preserve boolean intent without inventing a separate tone call', async () => {
  const f = fixture(), world = new CanbotWorld({ cfg: { ...CANBOT_DEFAULTS, headEnabled: true }, avatarToken: () => TOKEN, mediaToken: () => TOKEN });
  world.head = f.channel; world.lifecycle = new AbortController();
  const tool = world.tools().find(t => t.name === 'canbot_capture');
  const result = await tool.handler({ kind: 'microphone', durationMs: 6000, cue: true }, {});
  assert.notEqual(result.failed, true); assert.equal(f.posts()[0].body.cue, true); assert.equal(result.blobs[0].mime, 'audio/wav');
  for (const args of [{ kind: 'video', cue: true }, { kind: 'microphone', cue: 'true' }]) assert.equal((await tool.handler(args, {})).failed, true);
  assert.equal(tool.parameters.properties.cue.type, 'boolean'); assert.equal(tool.parameters.properties.cue.default, false);
  assert.equal(f.posts().length, 1); noTone(f); world.lifecycle.abort();
});
