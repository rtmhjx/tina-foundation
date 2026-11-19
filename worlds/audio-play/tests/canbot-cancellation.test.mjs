import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioPlayWorld } from '../src/world.js';
import { playFile } from '../src/player.js';
import definition from '../src/definition.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 6000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'local fake subprocess condition timed out');
    await pause(10);
  }
}
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'canbot-audio-adapter-'));
  t.after(() => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('canbot-audio-adapter-'));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const command = (mode, code) => `"${process.execPath}" "${fixture}" "{file}" ${mode} ${code}`;
async function worldHarness(t, mode = 'wait', code = 76) {
  const dir = workspace(t);
  const file = join(dir, 'fake.wav');
  writeFileSync(file, 'fake fixture; no audio is decoded or played');
  const events = [];
  const world = new AudioPlayWorld({
    dataDir: dir, botDir: dir,
    cfg: { backend: 'custom', command: command(mode, code), autoPlay: false },
  });
  await world.start({
    store: { latestCursor: () => 0, range: () => [] },
    pushEvent: async (event, delivery) => events.push({ event, delivery }),
    log: { info() {}, warn() {} },
  });
  t.after(() => world.stop());
  const tool = name => world.tools().find(value => value.name === name).handler;
  return { file, events, world, play: tool('audio_play'), queue: tool('audio_queue') };
}
function assertUnknown(events) {
  assert.equal(events.length, 1);
  assert.equal(events[0].event.type, 'audio-play.failed');
  assert.match(events[0].event.text, /outcome_unknown/);
  assert.equal(events[0].event.meta.code, 'outcome_unknown');
  assert.equal(events[0].event.meta.settled, false);
  assert.equal(events[0].event.meta.retryAutomatically, false);
  assert.equal(events[0].delivery.deliver, true);
}

test('identity/API are unchanged and describe matches runtime declarations', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const describe = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url)));
  assert.equal(pkg.name, 'cortico-world-audio-play');
  assert.equal(pkg.version, '0.4.0-canbot.1');
  assert.equal(pkg.cortico.api, 6);
  assert.equal(definition.id, 'audio-play');
  assert.deepEqual(describe, definition.describe);
});

test('real custom subprocess exit 76 emits visible unknown without an abort', async t => {
  const h = await worldHarness(t, 'immediate');
  h.play({ audio: h.file });
  await h.world.whenIdle();
  assertUnknown(h.events);
});

test('custom subprocess success and ordinary failure retain exit semantics', async t => {
  const dir = workspace(t);
  const file = join(dir, 'fake.wav');
  writeFileSync(file, 'unused');
  const opts = { path: file, backend: 'custom', timeoutMs: 5000 };
  assert.deepEqual(await playFile({ ...opts, command: command('immediate', 0) }), { backend: 'custom' });
  await assert.rejects(playFile({ ...opts, command: command('immediate', 2) }), error => error.code === 'failed');
});

test('abort branch keeps real child exit 76 visible; signal delivery mocked for portability', async t => {
  const h = await worldHarness(t);
  h.play({ audio: h.file });
  await until(() => existsSync(h.file + '.ready'));
  let killRequests = 0;
  t.mock.method(ChildProcess.prototype, 'kill', function () { killRequests++; return true; });
  const result = await h.queue({ action: 'skip' });
  assert.match(result.text, /cancel_requested/);
  assert.doesNotMatch(result.text, /已停止|已跳过/);
  assert.equal(killRequests, 1);
  assert.ok((await h.world.invoke('queue', 'list')).current);
  assert.equal(h.events.length, 0);
  writeFileSync(h.file + '.release', 'exit now');
  await h.world.whenIdle();
  assertUnknown(h.events);
});

test('POSIX real SIGTERM -> child exit 76 -> visible queue event; no early advancement', {
  skip: process.platform === 'win32' ? 'Windows kill(SIGTERM) force-terminates; real POSIX signal test requires Linux/macOS' : false,
}, async t => {
  const h = await worldHarness(t);
  const next = h.file + '-next.wav';
  writeFileSync(next, 'unused');
  writeFileSync(next + '.release', 'next may exit after it starts');
  h.play({ audio: h.file });
  h.play({ audio: next });
  await until(() => existsSync(h.file + '.ready'));
  const result = await h.queue({ action: 'skip' });
  assert.match(result.text, /cancel_requested/);
  await until(() => existsSync(h.file + '.signal'));
  assert.equal(readFileSync(h.file + '.signal', 'utf8'), 'SIGTERM');
  assert.equal(existsSync(next + '.ready'), false);
  assert.equal(h.events.length, 0);
  assert.equal((await h.world.invoke('queue', 'list')).counts.current, 1);
  writeFileSync(h.file + '.release', 'settlement remains unknown');
  await h.world.whenIdle();
  assert.equal(h.events.length, 2);
  assertUnknown([h.events[0]]);
  assertUnknown([h.events[1]]);
  assert.ok(existsSync(next + '.ready'));
});

test('clear requests cancellation and drops pending item; unknown remains visible', async t => {
  const h = await worldHarness(t);
  h.play({ audio: h.file });
  h.play({ audio: h.file });
  await until(() => existsSync(h.file + '.ready'));
  t.mock.method(ChildProcess.prototype, 'kill', () => true);
  const result = await h.queue({ action: 'clear' });
  assert.match(result.text, /cancel_requested/);
  assert.doesNotMatch(result.text, /已停止/);
  assert.equal((await h.world.invoke('queue', 'list')).counts.pending, 0);
  writeFileSync(h.file + '.release', 'exit');
  await h.world.whenIdle();
  assertUnknown(h.events);
});

test('confirmed ordinary cancellation stays silent', async t => {
  const h = await worldHarness(t, 'wait', 130);
  h.play({ audio: h.file });
  await until(() => existsSync(h.file + '.ready'));
  t.mock.method(ChildProcess.prototype, 'kill', () => true);
  await h.queue({ action: 'skip' });
  writeFileSync(h.file + '.release', 'cancel confirmed');
  await h.world.whenIdle();
  assert.equal(h.events.length, 0);
});

test('unknown settlement remains visible during World shutdown', async t => {
  const h = await worldHarness(t);
  h.play({ audio: h.file });
  await until(() => existsSync(h.file + '.ready'));
  t.mock.method(ChildProcess.prototype, 'kill', () => true);
  const stopping = h.world.stop();
  writeFileSync(h.file + '.release', 'unknown during shutdown');
  await stopping;
  assertUnknown(h.events);
});
