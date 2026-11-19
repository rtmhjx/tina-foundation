import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { HeadChannel, TouchStream } from '../src/head-channel.mjs';
import { CanbotWorld } from '../src/world.mjs';
import { CANBOT_DEFAULTS } from '../src/config.mjs';

const TOKEN = 'a'.repeat(64), INSTANCE = '11111111-1111-4111-8111-111111111111';
const GATEWAY = '22222222-2222-4222-8222-222222222222';
const configuration = { avatarBaseUrl: 'http://127.0.0.1:1', mediaBaseUrl: 'http://127.0.0.1:1',
  deviceId: 'canbot-head', bindHost: '127.0.0.1', bindPort: 0, avatarToken: () => TOKEN, mediaToken: () => TOKEN };
const event = (sequence, gateway = null) => ({ schemaVersion: 'canbot.device-event.v1', deviceId: 'canbot-head',
  eventId: `${INSTANCE}:${sequence}`, instanceId: INSTANCE, sampleSequence: sequence,
  avatar: { schemaVersion: 'canbot.avatar.v1', instanceId: INSTANCE }, gateway });
const chunk = (offset, hex, truncated = false, bytes = hex.length / 2) => ({ at: 1000, offset, bytes, hex, truncated });

test('touch decoder establishes baseline, joins split frames once, and discards a tail across a gap', () => {
  const stream = new TouchStream();
  assert.deepEqual(stream.observe({ instanceId: GATEWAY, rxBytes: 6, recentRx: [chunk(0, '42542d01710a')] }), []);
  assert.deepEqual(stream.observe({ instanceId: GATEWAY, rxBytes: 9, recentRx: [chunk(6, '42542d')] }), []);
  const touch = stream.observe({ instanceId: GATEWAY, rxBytes: 12, recentRx: [chunk(6, '42542d'), chunk(9, '01710a')] });
  assert.equal(touch.length, 1); assert.equal(touch[0].position, 'head_top'); assert.equal(touch[0].impliesUserAuthorization, false);
  assert.deepEqual(stream.observe({ instanceId: GATEWAY, rxBytes: 12, recentRx: [chunk(9, '01710a')] }), []);
  stream.observe({ instanceId: GATEWAY, rxBytes: 15, recentRx: [chunk(12, '42542d')] });
  const gap = stream.observe({ instanceId: GATEWAY, rxBytes: 21, recentRx: [chunk(18, '01710a')] });
  assert.equal(gap.filter(e => e.type === 'canbot.touch').length, 0); assert.equal(gap[0].type, 'canbot.sensor_gap');
  const unknown = stream.observe({ instanceId: GATEWAY, rxBytes: 27, recentRx: [chunk(21, '42542d01810a')] });
  assert.equal(unknown[0].physicalPositionVerified, false);
});

test('charge events are candidate observations, deduplicated, and reset after a gap or gateway change', () => {
  const stream = new TouchStream();
  assert.deepEqual(stream.observe({ instanceId: GATEWAY, rxBytes: 0, recentRx: [] }), []);
  const charging = stream.observe({ instanceId: GATEWAY, rxBytes: 8, recentRx: [chunk(0, '42542d031300000a')] });
  assert.equal(charging.length, 1); assert.equal(charging[0].type, 'canbot.power');
  assert.equal(charging[0].lastSignal, 'charging_candidate'); assert.equal(charging[0].physicalPowerVerified, false);
  assert.equal(charging[0].impliesUserAuthorization, false);
  assert.deepEqual(stream.observe({ instanceId: GATEWAY, rxBytes: 8, recentRx: [chunk(0, '42542d031300000a')] }), []);
  const unplug = stream.observe({ instanceId: GATEWAY, rxBytes: 16, recentRx: [chunk(8, '42542d031000000a')] });
  assert.equal(unplug[0].lastSignal, 'charge_disconnected_candidate');
  const repeated = stream.observe({ instanceId: GATEWAY, rxBytes: 24, recentRx: [chunk(16, '42542d031000000a')] });
  assert.deepEqual(repeated, []);
  const gap = stream.observe({ instanceId: GATEWAY, rxBytes: 33, recentRx: [chunk(30, '42542d')] });
  assert.equal(gap[0].type, 'canbot.sensor_gap'); assert.equal(gap[1].type, 'canbot.power');
  assert.equal(gap[1].lastSignal, 'unknown'); assert.equal(stream.power.lastSignal, 'unknown');
  const next = '33333333-3333-4333-8333-333333333333';
  assert.deepEqual(stream.observe({ instanceId: next, rxBytes: 8, recentRx: [chunk(0, '42542d031300000a')] }), []);
  assert.equal(stream.power.lastSignal, 'unknown', 'retained history is not replayed as a fresh observation');
});

test('truncated charge frames never become power observations, and fresh status expires with uplink', () => {
  const stream = new TouchStream();
  stream.observe({ instanceId: GATEWAY, rxBytes: 0, recentRx: [] });
  const cut = stream.observe({ instanceId: GATEWAY, rxBytes: 9, recentRx: [chunk(0, '42542d031300000a', true, 9)] });
  assert.equal(cut.some(e => e.type === 'canbot.power' && e.lastSignal !== 'unknown'), false);
  assert.equal(stream.power.lastSignal, 'unknown');
  let now = 2000;
  const channel = new HeadChannel({ ...configuration, clock: () => now });
  channel.touches.observe({ instanceId: GATEWAY, rxBytes: 0, recentRx: [] });
  channel.touches.observe({ instanceId: GATEWAY, rxBytes: 8, recentRx: [chunk(0, '42542d031000000a')] });
  channel.latest = { gateway: { instanceId: GATEWAY, serialOpen: true } }; channel.lastReceivedAt = now;
  assert.equal(channel.status().power.lastSignal, 'charge_disconnected_candidate');
  assert.equal(channel.status().power.physicalPowerVerified, false);
  now += 10000;
  assert.equal(channel.status().power.lastSignal, 'unknown'); assert.equal(channel.status().power.linkFresh, false);
});

test('a known charge signal becomes unknown when the gateway changes or becomes unavailable', () => {
  const stream = new TouchStream(), next = '33333333-3333-4333-8333-333333333333';
  stream.observe({ instanceId: GATEWAY, rxBytes: 0, recentRx: [] });
  stream.observe({ instanceId: GATEWAY, rxBytes: 8, recentRx: [chunk(0, '42542d031000000a')] });
  const replaced = stream.observe({ instanceId: next, rxBytes: 8, recentRx: [chunk(0, '42542d031300000a')] });
  assert.equal(replaced.length, 1); assert.equal(replaced[0].type, 'canbot.power');
  assert.equal(replaced[0].lastSignal, 'unknown'); assert.equal(stream.power.lastSignal, 'unknown');
  stream.observe({ instanceId: next, rxBytes: 16, recentRx: [chunk(8, '42542d031300000a')] });
  const unavailable = stream.observe(null);
  assert.equal(unavailable.length, 1); assert.equal(unavailable[0].lastSignal, 'unknown');
  assert.equal(stream.next, null);
});

test('power observations reach the World as external event text without becoming motor authority', async () => {
  const events = [], world = new CanbotWorld({ cfg: { ...CANBOT_DEFAULTS, headEnabled: true,
    headUplinkBind: '127.0.0.1', headUplinkPort: 0 }, avatarToken: () => TOKEN, mediaToken: () => TOKEN });
  world.host = { pushEvent: async (event, options) => events.push({ event, options }), log: { warn() {} } };
  await world.head.emit('canbot.power', { lastSignal: 'charging_candidate', physicalPowerVerified: false, impliesUserAuthorization: false });
  assert.equal(events[0].event.origin, 'external'); assert.equal(events[0].event.type, 'canbot.power');
  assert.match(events[0].event.text, /charging_candidate/); assert.match(events[0].event.text, /不证明/);
  assert.equal(events[0].event.meta.impliesUserAuthorization, false);
});

test('ingress authenticates, acknowledges stable IDs, and does not redeliver duplicate touch events', async t => {
  const observed = [], channel = new HeadChannel({ ...configuration, emit: async (type, meta) => observed.push({ type, meta }) });
  const address = await channel.start(); t.after(() => channel.stop()); const url = `http://127.0.0.1:${address.port}/v1/device-events`;
  const send = async (body, token = TOKEN) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send(event(1), 'wrong')).status, 401);
  assert.equal((await send(event(1, { instanceId: GATEWAY, rxBytes: 0, recentRx: [] }))).status, 202);
  const second = event(2, { instanceId: GATEWAY, rxBytes: 6, recentRx: [chunk(0, '42542d017c0a')] });
  assert.equal((await send(second)).status, 202); assert.equal((await send(second)).status, 200);
  assert.equal(observed.length, 1); assert.equal(observed[0].meta.position, 'right_hand_or_arm');
  assert.equal((await send({ ...second, sampleMonotonicMs: 12 })).status, 409);
  assert.equal(channel.status().observationFresh, true); assert.equal(JSON.stringify(channel.status()).includes(TOKEN), false);
});

test('avatar sends one normalized state and retrieves the same ID when the POST response is lost', async () => {
  const calls = [], channel = new HeadChannel({ ...configuration, fetchImpl: async (url, options) => {
    calls.push({ path: url.pathname, method: options.method, body: options.body && JSON.parse(options.body) });
    if (options.method === 'POST') throw new Error('simulated_lost_response');
    const value = url.pathname === '/v1/status' ? { schemaVersion: 'canbot.avatar.v1', instanceId: INSTANCE, lastSequence: 7,
      expressions: ['happy'], motions: ['idle'], current: { gazeX: 0, gazeY: 0, mouth: -1 } } : { operationId: 'visual-test', drawReturned: true };
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  } });
  const reply = await channel.avatar({ requestId: 'visual-test', expression: 'happy', gazeX: -.75, mouthOpen: .4 });
  assert.equal(reply.operation.drawReturned, true); assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  const sent = calls.find(c => c.method === 'POST').body; assert.equal(sent.gazeX, -750); assert.equal(sent.mouth, 400); assert.equal(sent.sequence, 8);
  assert.equal(calls.at(-1).path, '/v1/operations/visual-test');
  await assert.rejects(channel.avatar({ gazeX: 2 }), /visual_value_out_of_range/);
  await assert.rejects(channel.avatar({ mouthOpen: -.5 }), /mouth_open_invalid/);
});

test('media uses the background protocol and returns verified bytes as a Cortico BlobInput', async t => {
  const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]); let posts = 0, sequence;
  const mediaId = '33333333-3333-4333-8333-333333333333';
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`); const parts = []; for await (const c of req) parts.push(c);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/status') return res.end(JSON.stringify({ schemaVersion: 'canbot.diagnostics.v2', foreground: true, instanceId: INSTANCE, lastSequence: 4 }));
    if (req.method === 'POST') { posts++; sequence = JSON.parse(Buffer.concat(parts)).sequence; res.statusCode = 202; return res.end('{}'); }
    if (req.url.startsWith('/v1/operations/')) return res.end(JSON.stringify({ settled: true, state: 'complete', result: { media: { id: mediaId, mime: 'image/jpeg', bytes: jpeg.length } } }));
    if (req.url === `/v1/media/${mediaId}`) { res.setHeader('Content-Type', 'image/jpeg'); return res.end(jpeg); }
    res.writeHead(404).end('{}');
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const channel = new HeadChannel({ ...configuration, mediaBaseUrl: `http://127.0.0.1:${server.address().port}` });
  const result = await channel.capture('photo'); assert.equal(posts, 1); assert.equal(sequence, 5);
  assert.equal(result.blobs[0].mime, 'image/jpeg'); assert.ok(result.blobs[0].bytes instanceof Uint8Array); assert.deepEqual(Buffer.from(result.blobs[0].bytes), jpeg);
  assert.ok(result.blobs[0].fallbackText.includes('CANBOT')); assert.equal(result.sha256.length, 64);
});

test('head tools are opt-in and never introduce a raw motor tool', () => {
  const world = new CanbotWorld({ cfg: { ...CANBOT_DEFAULTS, headEnabled: true, headUplinkBind: '127.0.0.1', headUplinkPort: 0 }, avatarToken: () => TOKEN, mediaToken: () => TOKEN });
  assert.ok(world.tools().some(tool => tool.name === 'canbot_avatar'));
  assert.ok(world.tools().some(tool => tool.name === 'canbot_capture'));
  assert.equal(world.tools().some(tool => /raw|serial_write|shell/.test(tool.name)), false);
  const off = new CanbotWorld({ cfg: CANBOT_DEFAULTS }); assert.equal(off.head, null); assert.equal(off.tools().length, 11);
});

async function photoWorld(t, rejectPhotoEvent = false) {
  const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]), events = [];
  const mediaId = '33333333-3333-4333-8333-333333333333';
  let posts = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/status') return res.end(JSON.stringify({ schemaVersion: 'canbot.diagnostics.v2', foreground: true, instanceId: INSTANCE, lastSequence: 0 }));
    if (req.method === 'POST') { posts++; res.statusCode = 202; return res.end('{}'); }
    if (req.url.startsWith('/v1/operations/')) return res.end(JSON.stringify({ operationId: req.url.split('/').at(-1), settled: true, state: 'complete', result: { media: { id: mediaId, mime: 'image/jpeg', bytes: jpeg.length } } }));
    if (req.url === `/v1/media/${mediaId}`) { res.setHeader('Content-Type', 'image/jpeg'); return res.end(jpeg); }
    res.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const world = new CanbotWorld({ cfg: { ...CANBOT_DEFAULTS, apiBaseUrl: 'http://127.0.0.1:1', headEnabled: true,
    headUplinkBind: '127.0.0.1', headUplinkPort: 0, mediaBaseUrl: `http://127.0.0.1:${server.address().port}` },
    avatarToken: () => TOKEN, mediaToken: () => TOKEN });
  t.after(async () => { await world.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await world.start({ log: { warn() {} }, pushEvent: async (event, options) => {
    if (event.type === 'canbot.camera' && rejectPhotoEvent) throw new Error('event_store_failed');
    const saved = { ...event, cursor: events.length + 1 }; events.push({ ...saved, options }); return saved;
  } });
  assert.equal(posts, 0, 'mounting never starts the camera');
  const take = () => world.tools().find(tool => tool.name === 'canbot_capture').handler({ kind: 'photo' }, {});
  return { jpeg, events, take, posts: () => posts };
}

test('a photo publishes original bytes once as an external event and returns only the event receipt', async t => {
  const f = await photoWorld(t), result = await f.take();
  assert.equal(result.failed, undefined); assert.equal(result.blobs, undefined);
  const images = f.events.filter(event => event.type === 'canbot.camera'); assert.equal(images.length, 1);
  const event = images[0]; assert.equal(event.origin, 'external'); assert.equal(event.source, 'canbot');
  assert.equal(event.options.trigger, 'flush'); assert.equal(event.meta.deviceId, 'canbot-head');
  assert.deepEqual(Buffer.from(event.blobs[0].bytes), f.jpeg); assert.equal(event.blobs[0].mime, 'image/jpeg');
  const receipt = JSON.parse(result.text); assert.equal(receipt.delivery.cursor, event.cursor);
  assert.equal(receipt.sha256, event.meta.sha256); assert.equal(receipt.modelPerception, 'not_verified'); assert.equal(f.posts(), 1);
});

test('event storage failure reports a captured photo without retrying the camera or claiming delivery', async t => {
  const f = await photoWorld(t, true), result = await f.take(), receipt = JSON.parse(result.text);
  assert.equal(result.failed, true); assert.equal(receipt.code, 'photo_event_delivery_failed');
  assert.equal(receipt.mediaCaptured, true); assert.equal(receipt.retryAutomatically, false);
  assert.equal(receipt.delivery, undefined); assert.equal(f.posts(), 1);
  assert.equal(f.events.some(event => event.type === 'canbot.camera'), false);
});
