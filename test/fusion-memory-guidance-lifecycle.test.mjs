import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { NativeCoreLoop } from '../src/fusion-native-loop.mjs';
import { MainLoop } from '../upstream/cortico/src/core/loop.ts';
import { WakeBus } from '../upstream/cortico/src/core/bus.ts';
import { SessionLog } from '../upstream/cortico/src/core/session.ts';
import { JsonlEventStore } from '../upstream/cortico/src/core/event-store.ts';
import { message } from '../upstream/cortico/src/protocol/open-responses/context.ts';

const gate = () => Promise.withResolvers();
const log = { warn() {}, error() {}, info() {}, emit() {} };
const busFixture = () => new WakeBus({ quietGapMs: 0, minBatchAgeMs: 0, maxBatchAgeMs: 0, maxBatchSize: 32 });
const prefix = session => session.records[0].item.content.map(x => x.text ?? '').join('');

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'guidance-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function native(dir, id, records = []) {
  const bus = busFixture();
  const session = { surface: { nodes: [] } };
  const agent = { status: 'idle', session, runMaintenance: fn => fn(new AbortController().signal) };
  const loop = Object.assign(Object.create(NativeCoreLoop.prototype), {
    stateDir: dir, sessionId: id, ready: Promise.resolve(), abort: new AbortController(),
    pendingStop: gate(), phase: { state: 'idle' }, running: false,
    ctx: { agents: { get: () => agent }, sessions: { flush: async () => true },
      loader: { import: async () => ({ createUserMessage() {} }) }, emit() {} },
    d: { session: { records }, persona: {}, bus, log },
    worldsChanged: async () => {}, restorePending: async () => {}, project() {},
  });
  return loop;
}

async function boot(loop) {
  const opened = gate();
  const reasons = [];
  loop.d.persona.onOpening = ({ reason }) => { reasons.push(reason); opened.resolve(); };
  const running = loop.run();
  await opened.promise;
  loop.running = false;
  loop.pendingStop.resolve();
  await running;
  return reasons;
}

test('native opening persists per session, including empty and legacy sessions', async t => {
  const dir = await temp(t);
  assert.deepEqual(await boot(native(dir, 'empty')), ['new']);
  assert.deepEqual(await boot(native(dir, 'empty')), ['restarted']);
  assert.deepEqual(await boot(native(dir, 'legacy', [{}])), ['restarted']);
  assert.deepEqual(await boot(native(dir, 'legacy')), ['restarted']);
  assert.deepEqual(await boot(native(dir, 'other')), ['new']);
});

test('native clear waits for hook reload before resuming a World wake', { timeout: 5000 }, async t => {
  const loop = native(await temp(t), 'native-clear');
  const entered = gate(), release = gate(), request = gate();
  let segment = 'old', committed = 'old', reloadCalls = 0;
  loop.worldsChanged = async () => { reloadCalls++; entered.resolve(); await release.promise; committed = segment; };
  loop.d.persona.onOpening = ({ reason }) => { if (reason === 'cleared') { segment = 'new'; void loop.reloadSystemPrefix(); } };
  loop.batches = 0;
  loop.enter = state => { loop.phase.state = state; };
  loop.materialize = async () => ({ events: [], provenance: new Map() });
  loop.admitMaterialized = async () => { request.resolve(committed); };
  const clearing = loop.clearSession();
  await entered.promise;
  let done = false;
  clearing.then(() => { done = true; });
  const event = { source: 'world', origin: 'external', text: 'wake', type: 'fixture', ts: new Date().toISOString() };
  loop.d.bus.push({ event }, { trigger: 'flush' });
  const batch = loop.d.bus.nextBatch().then(items => loop.deliver(items));
  await tick();
  assert.equal(done, false);
  assert.equal(committed, 'old');
  release.resolve();
  await clearing;
  assert.equal(committed, 'new');
  assert.equal(await request.promise, 'new');
  await batch;
  assert.equal(reloadCalls, 1);
});

async function official(t) {
  const dir = await temp(t);
  const session = new SessionLog(dir);
  session.append(message('system', 'old'));
  const store = new JsonlEventStore({ dataDir: dir, run: 'fixture' });
  const bus = busFixture();
  const requests = [], resets = [];
  let segment = 'old';
  const reloadEntered = gate(), reloadRelease = gate(), firstEntered = gate(), firstRelease = gate(), secondEntered = gate();
  const persona = { systemSegments: async () => {
    if (segment === 'new') { reloadEntered.resolve(); await reloadRelease.promise; }
    return [{ text: segment }];
  } };
  const llm = { respond: async request => {
    requests.push(request.input[0].content.map(x => x.text ?? '').join(''));
    if (requests.length === 1) { firstEntered.resolve(); await firstRelease.promise; assert.equal(prefix(session), 'old'); }
    else secondEntered.resolve();
    return { response: { id: 'fixture', status: 'completed', output: [] }, origin: {},
      attempts: [{ meters: { input: null, output: null, cachedInput: null, uncachedInput: null, reasoning: null } }] };
  } };
  const loop = new MainLoop({ cfg: { timezone: 'UTC' }, decl: { id: 'main', label: 'Fixture', tools: () => [], rounds: () => ({ hard: 1, soft: 1 }) },
    persona, session, store, bus, log, llm, spec: () => ({ model: 'fixture' }),
    state: { data: { llmStall: { at: [], since: 0 } }, save() {} },
    worlds: { all: () => [], visible: () => [] }, onWorldFailed() {} });
  session.onReset(() => resets.push({ text: prefix(session), duringBatch: loop.processingBatch }));
  loop.bootstrap = async () => {};
  loop.deliverBatch = async () => true;
  loop.flushRequestedHandoff = async () => {};
  loop.batchEndCheck = async () => {};
  persona.onOpening = ({ reason }) => { if (reason === 'cleared') { segment = 'new'; void loop.reloadSystemPrefix(); } };
  const running = loop.run();
  t.after(async () => { firstRelease.resolve(); reloadRelease.resolve(); loop.stop(); await running; });
  function push() {
    const event = store.append({ type: 'fixture', source: 'world', origin: 'external', ts: new Date().toISOString(), text: 'wake' });
    bus.push({ event }, { trigger: 'flush' });
  }
  return { loop, requests, resets, push, firstEntered, firstRelease, secondEntered, reloadEntered, reloadRelease, session };
}

test('official idle clear drains opening reload before admitting the next batch', { timeout: 5000 }, async t => {
  const r = await official(t);
  await r.loop.clearSession();
  await r.reloadEntered.promise;
  r.push();
  await tick();
  assert.equal(r.requests.length, 0, 'Batch must not start while opening reload is pending.');
  r.reloadRelease.resolve();
  await r.firstEntered.promise;
  r.firstRelease.resolve();
  assert.equal(prefix(r.session), 'new');
  assert.deepEqual(r.requests, ['new']);
  assert.ok(r.resets.every(x => !x.duringBatch));
});

test('official queued clear and hook reload drain at the batch boundary before the next request', { timeout: 5000 }, async t => {
  const r = await official(t);
  r.push();
  await r.firstEntered.promise;
  const clearing = r.loop.clearSession();
  r.push();
  await tick();
  assert.deepEqual(r.requests, ['old']);
  assert.equal(r.resets.length, 0);
  r.firstRelease.resolve();
  await clearing;
  await r.reloadEntered.promise;
  await tick();
  assert.deepEqual(r.requests, ['old'], 'Next batch must wait at flushBoundaryMaintenance until opening reload finishes.');
  r.reloadRelease.resolve();
  await r.secondEntered.promise;
  assert.equal(prefix(r.session), 'new');
  assert.deepEqual(r.requests, ['old', 'new']);
  assert.ok(r.resets.every(x => !x.duringBatch));
});
