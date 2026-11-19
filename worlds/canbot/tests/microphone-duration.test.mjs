import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadChannel } from '../src/head-channel.mjs';
import { CanbotWorld } from '../src/world.mjs';
import { CANBOT_DEFAULTS } from '../src/config.mjs';

const TOKEN = 'a'.repeat(64), INSTANCE = '11111111-1111-4111-8111-111111111111';
const MEDIA = '33333333-3333-4333-8333-333333333333';
const capability = { minDurationMs: 3000, maxDurationMs: 10000, defaultDurationMs: 3000,
  deadlineExtraMs: 3000, minOperationDeadlineMs: 8000, maxOperationDeadlineMs: 13000 };
function fixture({ advertised = capability, lostPost = false, rejectPost = false, poll } = {}) {
  const calls = [], bytes = Buffer.alloc(44); bytes.write('RIFF'); bytes.write('WAVE', 8);
  let now = 0, polls = 0;
  const channel = new HeadChannel({ avatarBaseUrl: 'http://127.0.0.1:1', mediaBaseUrl: 'http://127.0.0.1:1',
    deviceId: 'canbot-head', bindHost: '127.0.0.1', bindPort: 0,
    avatarToken: () => TOKEN, mediaToken: () => TOKEN, clock: () => now,
    fetchImpl: async (url, options) => {
      const sent = options.body && JSON.parse(options.body);
      calls.push({ path: url.pathname, method: options.method, body: sent });
      if (url.pathname === '/v1/status') return Response.json({ schemaVersion: 'canbot.diagnostics.v2', foreground: true,
        instanceId: INSTANCE, lastSequence: 2, ...(advertised === null ? {} : { microphoneCapture: advertised }) });
      if (options.method === 'POST') {
        if (lostPost) throw new Error('response_lost_after_acceptance');
        if (rejectPost) return Response.json({ error: 'fixture_rejected' }, { status: 409 });
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (url.pathname.startsWith('/v1/operations/')) {
        const result = poll?.(++polls);
        if (result?.now !== undefined) now = result.now;
        if (result?.settled === false) return Response.json({ settled: false, state: 'running' });
        return Response.json({ operationId: url.pathname.split('/').at(-1), state: 'complete', settled: true,
          result: { media: { id: MEDIA, mime: 'audio/wav', bytes: bytes.length } } });
      }
      if (url.pathname === `/v1/media/${MEDIA}`) return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
      throw new Error('unexpected fixture request');
    } });
  return { channel, calls, posts: () => calls.filter(c => c.method === 'POST') };
}

test('capable microphone defaults to 6000ms; explicit 3000/6000/10000 remain exact', async () => {
  for (const requested of [undefined, 3000, 6000, 10000]) {
    const f = fixture(); assert.equal(f.calls.length, 0, 'construction does not start recording');
    const result = await f.channel.capture('microphone', undefined, requested);
    assert.equal(f.posts().length, 1);
    assert.equal(f.posts()[0].body.durationMs, requested ?? 6000);
    assert.equal(f.posts()[0].body.sequence, 3);
    assert.equal(result.blobs[0].mime, 'audio/wav');
  }
});

test('missing or untrusted extended capability uses legacy 3000ms and rejects explicit longer windows before POST', async () => {
  for (const advertised of [null, {}, { ...capability, maxDurationMs: '10000' }, { minDurationMs: 3000, maxDurationMs: 10000 }]) {
    for (const duration of [undefined, 3000]) {
      const f = fixture({ advertised }); await f.channel.capture('microphone', undefined, duration);
      assert.equal(f.posts()[0].body.durationMs, 3000);
    }
    for (const duration of [6000, 10000]) {
      const f = fixture({ advertised });
      await assert.rejects(f.channel.capture('microphone', undefined, duration), error => error.message === 'microphone_duration_unsupported');
      assert.equal(f.posts().length, 0);
    }
  }
});

test('invalid microphone duration is rejected before any request, without coercion or clamping', async () => {
  for (const value of [2999, 10001, 3000.5, '6000', null, NaN, Infinity, true]) {
    const f = fixture(); await assert.rejects(f.channel.capture('microphone', undefined, value), /microphone_duration_invalid/);
    assert.equal(f.calls.length, 0);
  }
});

test('lost microphone POST reply is queried by the same ID; never shortened or resent', async () => {
  const f = fixture({ lostPost: true }); await f.channel.capture('microphone', undefined, 10000);
  assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].body.durationMs, 10000);
  assert.equal(f.calls.find(c => c.path.startsWith('/v1/operations/')).path, '/v1/operations/' + f.posts()[0].body.operationId);
});

test('explicit device rejection is not retried with a shorter microphone window', async () => {
  const f = fixture({ rejectPost: true });
  await assert.rejects(f.channel.capture('microphone', undefined, 10000), /device_request_rejected/);
  assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].body.durationMs, 10000);
  assert.equal(f.calls.some(c => c.path.startsWith('/v1/operations/')), false);
});

test('10000ms microphone can settle after its 13000ms device deadline inside the 17000ms observation budget', async () => {
  const f = fixture({ poll: n => n === 1 ? { now: 11000, settled: false } : { now: 14000, settled: true } });
  const result = await f.channel.capture('microphone', undefined, 10000);
  assert.equal(result.receipt.state, 'complete'); assert.equal(f.posts().length, 1);
  assert.equal(f.calls.filter(c => c.path.startsWith('/v1/operations/')).length, 2);
});

test('microphone observation budget expires without another POST or a completion claim', async () => {
  const f = fixture({ poll: () => ({ now: 18000, settled: false }) });
  await assert.rejects(f.channel.capture('microphone', undefined, 10000), error => error.message === 'media_not_complete' && error.details.retryAutomatically === false);
  assert.equal(f.posts().length, 1);
});

test('photo/video/tone keep existing duration contract; duration option is microphone-only', async () => {
  for (const [kind, duration] of [['photo', undefined], ['video', 3000], ['tone', 500]]) {
    const f = fixture(); await f.channel.capture(kind);
    assert.equal(f.posts()[0].body.durationMs, duration);
    const invalid = fixture(); await assert.rejects(invalid.channel.capture(kind, undefined, 3000), /duration_only_supported_for_microphone/);
    assert.equal(invalid.calls.length, 0);
  }
});

test('World microphone tool passes optional duration through; invalid extra arguments never record', async () => {
  const f = fixture(), world = new CanbotWorld({ cfg: { ...CANBOT_DEFAULTS, headEnabled: true }, avatarToken: () => TOKEN, mediaToken: () => TOKEN });
  world.head = f.channel; world.lifecycle = new AbortController();
  const tool = world.tools().find(t => t.name === 'canbot_capture');
  const result = await tool.handler({ kind: 'microphone', durationMs: 10000 }, {});
  assert.notEqual(result.failed, true); assert.equal(f.posts()[0].body.durationMs, 10000);
  for (const args of [{ kind: 'microphone', durationMs: 2999 }, { kind: 'photo', durationMs: 3000 }, { kind: 'microphone', continuous: true }]) {
    const failed = await tool.handler(args, {}); assert.equal(failed.failed, true);
  }
  assert.equal(f.posts().length, 1);
  assert.equal(tool.parameters.properties.durationMs.minimum, 3000);
  assert.equal(tool.parameters.properties.durationMs.maximum, 10000);
  assert.equal(tool.parameters.properties.durationMs.default, undefined, 'schema must not force legacy calls to become explicit 6000ms');
  world.lifecycle.abort();
});
