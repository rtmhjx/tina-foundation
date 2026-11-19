import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TinaMobileWorld } from '../src/world.mjs';
import { MobileStore } from '../src/store.mjs';

test('opening an existing text-only database adds media storage without rewriting originals', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tina-mobile-media-')), path = join(dir, 'mobile.sqlite');
  t.after(() => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.match(basename(dir), /^tina-mobile-media-/); rmSync(dir, { recursive: true, force: true }); });
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE records (id TEXT PRIMARY KEY,device_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,source_ref TEXT,in_reply_to TEXT,delivery_state TEXT,host_cursor INTEGER,server_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE feed (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,device_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,source_ref TEXT,in_reply_to TEXT,state TEXT);
    INSERT INTO meta VALUES ('server_id','existing-server');
    INSERT INTO records(id,device_id,kind,text,created_at,server_seq) VALUES ('old','phone-a','user_message','  original  ','2026-01-01T00:00:00Z',1);
    INSERT INTO feed(id,device_id,kind,text,created_at,source_ref) VALUES ('old','phone-a','user_message','  original  ','2026-01-01T00:00:00Z','source-old');`);
  old.close();
  const store = new MobileStore(path);
  try {
    assert.equal(store.serverId, 'existing-server'); assert.equal(store.get('old').text, '  original  ');
    assert.equal(store.feed('phone-a', 0, 10).items[0].source_ref, 'source-old');
    const bytes = Buffer.from('new media'), sha = createHash('sha256').update(bytes).digest('hex');
    store.putMedia('new', 'phone-a', 'image/png', sha, bytes);
    assert.deepEqual(Buffer.from(store.getMedia('new').data), bytes); assert.equal(store.get('old').created_at, '2026-01-01T00:00:00Z');
  } finally { store.close(); }
});

test('phone media keeps its source, isolates devices and carries bytes in both directions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tina-mobile-media-')), events = [];
  const host = {
    store: { range: q => events.filter(e => e.source === q.source && e.senderKey === q.senderKey) },
    pushEvent: async event => { const row = { ...event, cursor: events.length + 1 }; events.push(row); return row; },
    blob: handle => handle === 'mem:voice' ? { mime: 'audio/mpeg', bytes: Buffer.from('test voice') } : null,
  };
  const world = new TinaMobileWorld({ cfg: { host: '127.0.0.1', port: 0, tokenSecret: 'TEST' }, dataDir: dir, botDir: dir, secret: () => 'fixture' });
  await world.start(host);
  t.after(async () => { await world.stop(); assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.match(basename(dir), /^tina-mobile-media-/); rmSync(dir, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${world.address().port}`;
  const request = async (path, body, auth = true) => {
    const response = await fetch(root + path, { method: body ? 'POST' : 'GET', headers: { ...(auth ? { authorization: 'Bearer fixture' } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const bytes = Buffer.from('fixture image bytes');
  const original = { id: 'photo-one', device_id: 'phone-a', created_at: '2026-10-28T01:00:00Z', text: '[图片]', mime: 'image/png',
    sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') };
  assert.equal((await request('/v1/media', original, false)).status, 401);
  assert.equal((await request('/v1/media', { ...original, sha256: 'wrong' })).status, 400);
  assert.equal((await request('/v1/media', original)).status, 201);
  assert.equal((await request('/v1/media', original)).status, 200);
  const textOnly = { id: 'text-only', device_id: 'phone-a', text: '原文字', created_at: original.created_at };
  assert.equal((await request('/v1/messages', textOnly)).status, 201);
  assert.equal((await request('/v1/media', { ...original, ...textOnly })).status, 409);
  assert.equal(world.store.getMedia('text-only'), null, 'a conflicting record must roll back its media bytes');
  while (world.pending) await world.pending;
  assert.equal(events.filter(e => e.senderKey === original.id).length, 1);
  assert.deepEqual(Buffer.from(events.find(e => e.senderKey === original.id).blobs[0].bytes), bytes);
  assert.equal((await request('/v1/media?id=photo-one&device_id=phone-b')).status, 404);
  const metadata = await request('/v1/media?id=photo-one&device_id=phone-a&metadata=1');
  assert.equal(metadata.body.mime, 'image/png'); assert.equal(metadata.body.size, bytes.length); assert.equal(Object.hasOwn(metadata.body, 'data'), false);
  const restored = await request('/v1/media?id=photo-one&device_id=phone-a'); assert.deepEqual(Buffer.from(restored.body.data, 'base64'), bytes);
  const send = world.tools().find(tool => tool.name === 'mobile_send_media').handler;
  const args = { device_id: 'phone-a', in_reply_to: 'photo-one', handle: 'mem:voice' }, call = { role: 'assistant', callId: 'voice-one' };
  const reply = JSON.parse(await send(args, call)); assert.equal(JSON.parse(await send(args, call)).id, reply.id);
  const feed = (await request('/v1/feed?device_id=phone-a')).body;
  assert.equal(feed.items.find(row => row.id === reply.id).source_ref, `coo-media:${reply.id}`);
  assert.equal((await request(`/v1/media?id=${reply.id}&device_id=phone-a`)).body.mime, 'audio/mpeg');
  assert.equal((await send({ ...args, handle: 'missing' }, { ...call, callId: 'missing' })).failed, true);
});
