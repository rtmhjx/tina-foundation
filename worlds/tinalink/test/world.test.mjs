import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TinaLinkWorld } from '../src/world.mjs';
import { LinkStore } from '../src/store.mjs';

const token = 'fixture-only-token-not-a-real-secret-000000';
const event = (id, extra = {}) => ({ id, source_lane: 'main', target_lane: 'dsh', topic: 'fixture', summary: `progress ${id}`,
  kind: 'progress', source_ref: `ref://fixture/${id}`, created_at: '2026-01-01T00:00:00Z', request_wake: false, ...extra });
function host() {
  const events = [], promoted = [];
  return { events, promoted, store: { range: q => events.filter(e => e.source === q.source && e.senderKey === q.senderKey) },
    async pushEvent(value, options) { const saved = { ...value, cursor: events.length + 1, options }; events.push(saved); return saved; },
    async promotePending(cursor, trigger) { promoted.push({ cursor, trigger }); return true; } };
}
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tina-link-'));
  const context = { dataDir: dir, botDir: dir, secret: () => token, cfg: { lane: 'dsh', port: 0, batchSize: 3, tokenSecret: 'FIXTURE', peers: { main: 'http://127.0.0.1:1' }, ...options } };
  const world = new TinaLinkWorld(context), fake = host(); await world.start(fake);
  t.after(async () => { await world.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { world, fake, dir, context, url: `http://127.0.0.1:${world.server.address().port}` };
}
async function settled(world) { do { await world.pending; } while (world.pending); }
async function post(url, value) { return fetch(`${url}/v1/events`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) }); }

test('ordinary deltas persist and piggyback; threshold promotes exactly once', async t => {
  const { world, fake, url } = await fixture(t);
  for (const id of ['a', 'b']) { assert.equal((await post(url, event(id))).status, 201); await settled(world); }
  assert.equal(fake.promoted.length, 0); assert.equal(world.store.pending().length, 2);
  assert.ok(fake.events.every(e => e.options.trigger === 'piggyback'));
  await post(url, event('c')); await settled(world); assert.equal(fake.promoted.length, 1);
  world.kick(); await settled(world); assert.equal(fake.promoted.length, 1);
  world.onEventsSettled(fake.events, 'delivered'); assert.equal(world.store.pending().length, 0);
});
test('explicit wake and needs_user_action promote below threshold', async t => {
  const { world, fake, url } = await fixture(t);
  await post(url, event('a', { request_wake: true })); await settled(world);
  await post(url, event('b', { kind: 'needs_user_action' })); await settled(world);
  assert.equal(fake.promoted.length, 2);
});
test('idempotent network retry preserves source; changed body conflicts', async t => {
  const { world, fake, url } = await fixture(t);
  assert.equal((await post(url, event('a'))).status, 201); await settled(world);
  assert.equal((await post(url, event('a'))).status, 200);
  assert.equal((await post(url, event('a', { summary: 'changed' }))).status, 409);
  assert.equal(fake.events.length, 1); assert.equal(world.store.get('a').event.source_ref, 'ref://fixture/a');
});
test('restart keeps queued event and does not append another host event', async t => {
  const f = await fixture(t); await post(f.url, event('a')); await settled(f.world); await f.world.stop();
  await f.world.start(f.fake); await settled(f.world);
  assert.equal(f.fake.events.length, 1); assert.equal(f.world.store.pending().length, 1);
});
test('authentication and target mismatch do not write events', async t => {
  const { world, url } = await fixture(t);
  assert.equal((await fetch(`${url}/v1/health`)).status, 401);
  assert.equal((await post(url, event('a', { target_lane: 'elsewhere' }))).status, 400);
  assert.equal(world.store.pending().length, 0);
});
test('tool sends one stable sourced event; retry reuses timestamp and identity', async t => {
  const target = await fixture(t);
  const source = await fixture(t, { lane: 'main', peers: { dsh: target.url } });
  const tool = source.world.tools().find(t => t.name === 'tinalink_send');
  const input = { target: 'dsh', topic: 'fixture', summary: 'do one task', kind: 'task', source_ref: 'ref://phone/one', request_wake: true };
  const call = { role: 'main', callId: 'one' };
  const first = JSON.parse(await tool.handler(input, call)); await settled(target.world);
  const second = JSON.parse(await tool.handler(input, call)); await settled(target.world);
  assert.equal(first.id, second.id); assert.equal(target.fake.events.length, 1); assert.equal(target.fake.promoted.length, 1);
  const conflict = await tool.handler({ ...input, summary: 'different' }, call); assert.equal(conflict.failed, true);
});
test('outbox survives temporary peer outage and retries without a model', async t => {
  const source = await fixture(t, { lane: 'main', peers: { dsh: 'http://127.0.0.1:1' } });
  const tool = source.world.tools().find(t => t.name === 'tinalink_send');
  const queued = JSON.parse(await tool.handler({ target: 'dsh', topic: 'fixture', summary: 'one', kind: 'progress', source_ref: 'ref://one' }, { role: 'main', callId: 'retry' }));
  assert.equal(queued.state, 'queued_for_retry'); await settled(source.world);
  const target = await fixture(t); source.context.cfg.peers.dsh = target.url;
  source.world.kick(); await settled(source.world); await settled(target.world);
  assert.equal(source.world.outbox.pending().length, 0); assert.equal(target.fake.events.length, 1);
});
test('SQLite preserves original payload over close/reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tina-link-store-')), path = join(dir, 'data.sqlite');
  let store = new LinkStore(path); store.insert(event('a')); store.close(); store = new LinkStore(path);
  assert.deepEqual(store.get('a').event, event('a')); store.close(); rmSync(dir, { recursive: true, force: true });
});
test('source reader returns original lines and rejects outside paths', async t => {
  const f = await fixture(t); const root = join(f.dir, 'sources'); mkdirSync(root);
  writeFileSync(join(root, 'one.md'), '# source\n原始消息 42\n未完成事项\n', 'utf8');
  writeFileSync(join(f.dir, 'outside.md'), 'not in corpus', 'utf8'); f.context.cfg.sourceRoot = root;
  const read = f.world.tools().find(tool => tool.name === 'tinalink_source_read');
  const result = JSON.parse(await read.handler({ path: 'one.md', offset: 2, limit: 1 }, {}));
  assert.equal(result.text, '原始消息 42'); assert.equal(result.offset, 2);
  assert.equal((await read.handler({ path: '../outside.md' }, {})).failed, true);
});
test('literal source search locates Chinese text and returns an honest miss', async t => {
  const f = await fixture(t); const root = join(f.dir, 'sources'); mkdirSync(root);
  writeFileSync(join(root, 'one.md'), '# source\n手机里的记忆\n', 'utf8'); f.context.cfg.sourceRoot = root;
  const search = f.world.tools().find(tool => tool.name === 'tinalink_source_search');
  const found = JSON.parse(await search.handler({ query: '记忆' }, {}));
  assert.equal(found.hits.length, 1); assert.match(found.hits[0], /one.md:2:/);
  const miss = JSON.parse(await search.handler({ query: 'does-not-exist' }, {})); assert.deepEqual(miss.hits, []);
});
