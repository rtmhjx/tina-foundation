import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { TinaMobileWorld } from '../src/world.mjs';
import { MobileStore } from '../src/store.mjs';

const token = 'test-token-no-production-secret';
const input = (id, device = 'phone-a', text = '你好，手机原文') => ({ id, device_id: device, text, created_at: '2026-10-28T01:00:00+08:00' });
function fakeHost() {
  const events = [];
  return {
    events, attempts: 0, fail: false,
    store: { range: q => events.filter(e => e.source === q.source && e.senderKey === q.senderKey).slice(0, q.limit) },
    async pushEvent(event, options) {
      this.attempts++;
      if (this.fail) throw new Error('simulated-disk-error');
      assert.equal(options.trigger, 'flush');
      const saved = { ...event, cursor: events.length + 1 };
      events.push(saved); return saved;
    },
  };
}
async function fixture(t, host = fakeHost()) {
  const dir = mkdtempSync(join(tmpdir(), 'tina-mobile-world-'));
  const context = { cfg: { host: '127.0.0.1', port: 0, tokenSecret: 'TEST' }, dataDir: dir, botDir: dir,
    secret: name => { assert.equal(name, 'TEST'); return token; } };
  const world = new TinaMobileWorld(context);
  await world.start(host);
  t.after(async () => {
    await world.stop();
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()), 'cleanup must remain directly inside the system temp directory');
    assert.match(basename(target), /^tina-mobile-world-/);
    rmSync(target, { recursive: true, force: true });
  });
  const request = async (path, body, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${world.address().port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const flush = async () => { while (world.pending) await world.pending; };
  return { world, host, context, dir, request, flush };
}

test('authenticated durable intake, duplicate retry and explicit delivery transition', async t => {
  const { world, host, request, flush } = await fixture(t);
  assert.equal((await request('/v1/health', undefined, false)).status, 401);
  const health = await request('/v1/health');
  assert.equal(health.body.protocol, 'tina-mobile/1');
  const first = await request('/v1/messages', input('msg-a'));
  assert.equal(first.status, 201);
  assert.equal(first.body.state, 'accepted');
  await flush();
  assert.equal(host.events.length, 1);
  assert.equal(host.events[0].origin, 'external');
  assert.equal(host.events[0].senderKey, 'msg-a');
  assert.match(host.events[0].text, /你好，手机原文/);
  assert.equal((await request('/v1/messages', input('msg-a'))).body.state, 'accepted', 'host queue is not delivered');
  assert.equal((await request('/v1/messages', input('msg-a', 'phone-a', 'changed'))).status, 409);
  assert.equal(host.events.length, 1);
  world.onEventsSettled(host.events, 'delivered');
  world.onEventsSettled(host.events, 'delivered');
  assert.equal((await request('/v1/messages', input('msg-a'))).body.state, 'delivered');
  const feed = (await request('/v1/feed?device_id=phone-a')).body;
  assert.deepEqual(feed.items.map(item => item.kind), ['user_message', 'message_state']);
  assert.equal(feed.items[1].state, 'delivered');
  assert.equal((await request('/v1/source?id=msg-a')).body.record.text, input('msg-a').text);
});

test('new arrivals during a slow push dispatch immediately without the retry timer', async t => {
  const host = fakeHost(), push = host.pushEvent;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  host.pushEvent = async function(event, options) {
    if (event.senderKey === 'slow-first') await gate;
    return push.call(this, event, options);
  };
  const { world, request, flush } = await fixture(t, host);
  clearInterval(world.timer);
  await request('/v1/messages', input('slow-first'));
  await request('/v1/messages', input('arrived-during-push'));
  assert.equal(host.events.length, 0);
  release(); await flush();
  assert.deepEqual(host.events.map(e => e.senderKey), ['slow-first', 'arrived-during-push']);
  assert.equal(world.store.pending().length, 0);
});

test('coalesced dispatch failure does not hot-loop and stop does not restart dispatch', async t => {
  const host = fakeHost();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  host.pushEvent = async function() {
    this.attempts++;
    if (this.attempts === 1) await gate;
    throw new Error('persistent failure');
  };
  const { world, request, flush } = await fixture(t, host);
  clearInterval(world.timer);
  await request('/v1/messages', input('failure-first'));
  await request('/v1/messages', input('failure-second'));
  world.kick(); world.kick();
  release(); await flush();
  assert.equal(host.attempts, 2, 'only a coalesced new request retries immediately, not the failed row count');
  assert.equal(world.store.pending().length, 2);

  let releaseStop;
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  host.pushEvent = async function(event) { this.attempts++; await stopGate; return { ...event, cursor: 1 }; };
  world.kick(); world.kick();
  const stopping = world.stop();
  releaseStop(); await stopping;
  assert.equal(host.attempts, 3, 'stop must prevent the requested follow-up run');
  assert.equal(world.pending, null);
});

test('World prompt document includes the API 6 description field', () => {
  const world = new TinaMobileWorld({});
  const doc = world.webUi().promptDocs[0];
  assert.equal(typeof doc.description, 'string');
  assert.ok(doc.description.length > 0);
});

test('archive-only host receipt is explicitly discarded without guessing delivered or waking again', async t => {
  const host = fakeHost(), push = host.pushEvent;
  host.pushEvent = async function(event, options) {
    const saved = await push.call(this, event, options);
    saved.contextDelivery = 'archive-only';
    return saved;
  };
  const { world, request, flush } = await fixture(t, host);
  await request('/v1/messages', input('hidden-input')); await flush();
  const feed = (await request('/v1/feed?device_id=phone-a')).body;
  assert.deepEqual(feed.items.map(item => item.kind), ['user_message', 'message_state']);
  assert.equal(feed.items[1].state, 'discarded');
  assert.match(feed.items[1].text, /仅归档未进入对话/);
  assert.equal(world.store.get('hidden-input').delivery_state, 'discarded');
  assert.equal((await request('/v1/source?id=hidden-input')).body.record.text, input('hidden-input').text);
  await request('/v1/messages', input('hidden-input')); await flush();
  assert.equal(host.events.length, 1);
  await world.stop(); await world.start(host); await flush();
  assert.equal(host.events.length, 1);
  assert.equal((await request('/v1/feed?device_id=phone-a')).body.items.length, 2);
});

test('facts are sourced, silent and idempotent; feed pagination is stable and device-specific', async t => {
  const { host, request } = await fixture(t);
  const fact = { ...input('fact-1'), source_ref: 'ref://dsh/session-a/event-2' };
  assert.equal((await request('/v1/facts', input('bad-fact'))).status, 400);
  assert.equal((await request('/v1/facts', fact)).status, 201);
  assert.equal((await request('/v1/facts', fact)).status, 200);
  assert.equal((await request('/v1/facts', { ...fact, source_ref: 'ref://different' })).status, 409);
  await request('/v1/facts', { ...input('fact-2', 'phone-b'), source_ref: 'ref://other' });
  await request('/v1/facts', { ...input('fact-3'), source_ref: 'ref://third' });
  assert.equal(host.events.length, 0, 'fact receipt must not wake Cortico');
  const first = (await request('/v1/feed?device_id=phone-a&limit=1')).body;
  assert.equal(first.items[0].id, 'fact-1'); assert.equal(first.has_more, true);
  const next = (await request(`/v1/feed?device_id=phone-a&limit=1&after=${first.next_cursor}`)).body;
  assert.equal(next.items[0].id, 'fact-3'); assert.equal(next.has_more, false);
  const empty = (await request(`/v1/feed?device_id=phone-a&after=${next.next_cursor}`)).body;
  assert.equal(empty.next_cursor, next.next_cursor); assert.deepEqual(empty.items, []);
  const source = (await request('/v1/source?id=fact-1')).body;
  assert.equal(source.record.source_ref, fact.source_ref); assert.equal(source.external_source_retrieved, false);
  assert.equal((await request('/v1/feed?device_id=phone-a&limit=101')).status, 400);
});

test('reply uses stable native call identity, retains original and does not wake another model', async t => {
  const { world, host, request, flush } = await fixture(t);
  await request('/v1/messages', input('msg-r')); await flush();
  const reply = world.tools().find(tool => tool.name === 'mobile_reply').handler;
  const args = { device_id: 'phone-a', in_reply_to: 'msg-r', text: '你好，已接通。' };
  const call = { role: 'tina', callId: 'native-call-1' };
  const a = JSON.parse(await reply(args, call));
  const b = JSON.parse(await reply(args, call));
  assert.equal(a.id, b.id); assert.equal(a.server_seq, b.server_seq); assert.equal(a.phone_read, 'unknown');
  const conflict = await reply({ ...args, text: 'changed reply' }, call);
  assert.equal(conflict.failed, true); assert.match(conflict.text, /ID_PAYLOAD_CONFLICT/);
  const missingId = await reply(args, { role: 'tina' });
  assert.equal(missingId.failed, true); assert.match(missingId.text, /STABLE_CALL_ID_REQUIRED/);
  const otherDevice = await reply({ ...args, device_id: 'phone-b' }, { ...call, callId: 'different' });
  assert.equal(otherDevice.failed, true);
  assert.equal(host.events.length, 1);
  const feed = (await request('/v1/feed?device_id=phone-a')).body;
  assert.equal(feed.items.filter(item => item.kind === 'assistant_message').length, 1);
  const source = (await request(`/v1/source?id=${a.id}`)).body.record;
  assert.equal(source.text, args.text); assert.equal(source.in_reply_to, 'msg-r');
});

test('restart recovers dispatch after failure and does not duplicate a host-persisted event', async t => {
  const { world, host, request, flush } = await fixture(t);
  host.fail = true;
  await request('/v1/messages', input('pending')); await flush();
  assert.equal(world.store.pending().length, 1);
  const originalServerId = (await request('/v1/health')).body.server_id;
  await world.stop(); host.fail = false; await world.start(host); await flush();
  assert.equal(host.events.length, 1);
  assert.equal((await request('/v1/health')).body.server_id, originalServerId);
  // Model a crash gap: host persisted the event, local cursor write did not happen.
  world.store.db.prepare('UPDATE records SET host_cursor=NULL WHERE id=?').run('pending');
  await world.stop(); await world.start(host); await flush();
  assert.equal(host.events.length, 1);
  assert.equal(world.store.get('pending').host_cursor, 1);
  world.onEventsSettled(host.events, 'discarded');
  await world.stop(); await world.start(host); await flush();
  await request('/v1/messages', input('pending')); await flush();
  assert.equal(host.events.length, 1, 'duplicate POST cannot resurrect discarded input');
  assert.equal((await request('/v1/feed?device_id=phone-a')).body.items.at(-1).state, 'discarded');
});

test('one transaction rolls back both original and feed when feed insertion fails', () => {
  const store = new MobileStore(':memory:');
  try {
    store.db.exec("CREATE TRIGGER fail_feed BEFORE INSERT ON feed BEGIN SELECT RAISE(ABORT, 'simulated disk error'); END;");
    assert.throws(() => store.insert(input('rollback'), 'user_message'));
    assert.equal(store.get('rollback'), null);
    assert.equal(store.feed('phone-a', 0, 100).items.length, 0);
  } finally { store.close(); }
});

test('stop releases HTTP and SQLite for restart; startup failure cleans up', async t => {
  const { world, context, host } = await fixture(t);
  const port = world.address().port;
  const second = new TinaMobileWorld({ ...context, cfg: { ...context.cfg, port } });
  await assert.rejects(second.start(host), { code: 'EADDRINUSE' });
  assert.equal(second.store, null); assert.equal(second.server, null);
  await world.stop();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/health`));
  await second.start(host); await second.stop();
  await world.start(host);
});
