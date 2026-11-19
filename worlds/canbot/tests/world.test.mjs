import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { CANBOT } from '../src/definition.mjs';
import { CANBOT_DEFAULTS } from '../src/config.mjs';
import { CanbotClient } from '../src/client.mjs';
import { CanbotWorld } from '../src/world.mjs';

async function fixture(t, overrides = {}) {
  const calls = [];
  const state = {
    schemaVersion: 1,
    observer: { state: 'receiving', listening: true, validFrames: 1, lastReceivedAt: '2026-10-24T01:00:00Z' },
    observedSource: 'udp_peer_unattributed', daemonStatus: 'unknown', mcuStatus: 'unknown',
    capabilities: { observe: true, motion: false, physicalStop: false },
    blockers: ['unverified_motion_protocol', 'unverified_stop_protocol', 'mcu_link_unverified'],
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const call = { path: req.url, method: req.method, authorization: req.headers.authorization,
      body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    res.setHeader('Content-Type', 'application/json');
    const custom = overrides[req.url];
    if (custom) { await custom(req, res, call); return; }
    if (req.url === '/v1/status') { res.end(JSON.stringify(state)); return; }
    if (req.url?.startsWith('/v1/frames')) {
      res.end(JSON.stringify({ frames: [{ source: 'udp_peer_unattributed', hex: 'aa55', remote: '192.0.2.1:3300' }] })); return;
    }
    if (req.url === '/v1/actions' && req.method === 'GET') {
      res.end(JSON.stringify({ actions: [], reason: 'unverified_action_protocol' })); return;
    }
    if (req.url === '/v1/actions' && req.method === 'POST') {
      res.statusCode = 409;
      res.end(JSON.stringify({ accepted: false, code: 'unverified_action_protocol' })); return;
    }
    if (req.url === '/v1/stop') {
      res.statusCode = 409;
      res.end(JSON.stringify({ confirmed: false, code: 'unverified_stop_protocol' })); return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const apiBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  const host = {
    pushEvent: async (event, options) => { events.push({ ...event, options }); return { ...event, cursor: events.length }; },
    log: { warn() {} },
  };
  const world = new CanbotWorld({ cfg: { ...CANBOT_DEFAULTS, apiBaseUrl, pollIntervalMs: 60000 } });
  t.after(async () => {
    await world.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const tool = (name, args = {}, ctx = {}) => world.tools().find((value) => value.name === name).handler(args, ctx);
  return { server, apiBaseUrl, world, host, events, state, calls, tool };
}

test('default World construction is disabled and performs no connection', () => {
  const cfg = CANBOT.defaults();
  assert.equal(cfg.enabled, false);
  const world = CANBOT.create({ cfg, secret: () => '' });
  assert.equal(world.id, 'canbot');
  assert.deepEqual(world.tools().map((tool) => tool.name), [
    'canbot_status', 'canbot_observe', 'canbot_actions', 'canbot_move', 'canbot_move_receipt', 'canbot_do', 'canbot_stop',
    'canbot_programs', 'canbot_program_get', 'canbot_program_save', 'canbot_program_delete',
  ]);
  assert.equal(world.lastPollAt, null);
});

test('heartbeat counts do not wake Cortico; receiving-to-stale change does', async (t) => {
  const f = await fixture(t);
  await f.world.start(f.host);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].meta.daemonStatus, 'unknown');
  f.state.observer.validFrames = 25;
  f.state.observer.lastReceivedAt = '2026-10-24T01:00:40Z';
  await f.world.poll();
  assert.equal(f.events.length, 1);
  f.state.observer.state = 'stale';
  await f.world.poll();
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].meta.observer.state, 'stale');
  assert.equal(f.events[1].origin, 'external');
});

test('a changed timed action allowlist emits a fresh external capability observation', async (t) => {
  const f = await fixture(t);
  f.state.timedActions = { enabled: true, actions: [{ id: 'head.shake', enabled: true, blockedBy: null },
    { id: 'leg.forward', enabled: false, blockedBy: 'timed_action_not_allowlisted' }] };
  await f.world.start(f.host);
  assert.equal(f.events.length, 1);
  f.state.timedActions.actions[1] = { id: 'leg.forward', enabled: true, blockedBy: null };
  await f.world.poll();
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].origin, 'external');
  assert.equal(f.events[1].meta.timedActions.actions[1].enabled, true);
  await f.world.poll();
  assert.equal(f.events.length, 2);
});

test('device status is read from the observer object returned by the API', async (t) => {
  const f = await fixture(t);
  delete f.state.daemonStatus;
  delete f.state.mcuStatus;
  f.state.observer.daemonStatus = 'unavailable';
  f.state.observer.mcuStatus = 'link_unverified';
  await f.world.start(f.host);
  assert.equal(f.events[0].meta.daemonStatus, 'unavailable');
  assert.equal(f.events[0].meta.mcuStatus, 'link_unverified');
});

test('observation preserves source evidence and rejects an unbounded limit before HTTP', async (t) => {
  const f = await fixture(t);
  await f.world.start(f.host);
  const seen = await f.tool('canbot_observe', { limit: 2 });
  assert.equal(JSON.parse(seen.text).frames[0].source, 'udp_peer_unattributed');
  const callCount = f.calls.length;
  const rejected = await f.tool('canbot_observe', { limit: 101 });
  assert.equal(rejected.failed, true);
  assert.equal(f.calls.length, callCount);
});

test('API rejects movement and stopping without implying physical completion', async (t) => {
  const f = await fixture(t);
  await f.world.start(f.host);
  const actions = await f.tool('canbot_actions');
  assert.deepEqual(JSON.parse(actions.text).actions, []);
  const motion = await f.tool('canbot_do', { action: 'forward', requestId: 'test-request' });
  assert.equal(motion.failed, true);
  assert.deepEqual(JSON.parse(motion.text), {
    httpStatus: 409, accepted: false, code: 'unverified_action_protocol', requestId: 'test-request', physicalCompletion: 'unknown', retryAutomatically: false,
  });
  const submitted = f.calls.find((call) => call.method === 'POST' && call.path === '/v1/actions');
  assert.deepEqual(submitted.body, { id: 'test-request', action: 'forward' });
  const stop = await f.tool('canbot_stop');
  assert.equal(stop.failed, true);
  assert.equal(JSON.parse(stop.text).confirmed, false);
  assert.equal(JSON.parse(stop.text).physicalCompletion, 'unknown');
  assert.equal(f.events.filter((event) => event.type === 'canbot.command').length, 2);
});

test('timeout after submitting a command remains unknown and is not retried', async (t) => {
  const f = await fixture(t, { '/v1/actions': async () => {} });
  f.world.client.timeoutMs = 250;
  await f.world.start(f.host);
  const result = await f.tool('canbot_do', { action: 'forward' });
  const body = JSON.parse(result.text);
  assert.equal(result.failed, true);
  assert.equal(body.outcome, 'unknown');
  assert.equal(body.retryAutomatically, false);
  assert.equal(f.calls.filter((call) => call.path === '/v1/actions').length, 1);
});

test('unmount aborts polling, does not claim or send a physical stop, and disables tools', async (t) => {
  const f = await fixture(t);
  await f.world.start(f.host);
  await f.world.stop();
  const before = f.calls.length;
  await f.world.poll();
  const result = await f.tool('canbot_status');
  assert.equal(result.failed, true);
  assert.equal(f.calls.length, before);
  assert.equal(f.calls.filter((call) => call.path === '/v1/stop').length, 0);
  assert.equal(f.world.shutdownVerification()[0].status, 'unknown');
});

test('remote API requires a token; bearer credential is passed only in the header', async (t) => {
  const remote = new CanbotClient({ baseUrl: 'http://192.0.2.1:7331', timeoutMs: 250 });
  await assert.rejects(remote.request('/v1/status'), /CORTICO_CANBOT_API_TOKEN/);
  const f = await fixture(t);
  const client = new CanbotClient({ baseUrl: f.apiBaseUrl, timeoutMs: 3000, token: () => 'fixture-token' });
  await client.request('/v1/status');
  assert.equal(f.calls[0].authorization, 'Bearer fixture-token');
  assert.equal(f.calls[0].path, '/v1/status');
  assert.throws(() => new CanbotClient({ baseUrl: 'http://user:secret@127.0.0.1:7331', timeoutMs: 1000 }), /不含凭证/);
});

test('an unrelated HTTP service is not reported as the CANBOT API', async (t) => {
  const f = await fixture(t, { '/v1/status': async (_req, res) => res.end('{}') });
  await f.world.start(f.host);
  assert.equal(f.events[0].meta.api, 'unavailable');
  assert.equal(f.events[0].meta.mcuStatus, 'unknown');
  assert.equal((await f.tool('canbot_status')).failed, true);
});

test('gateway heartbeat does not wake the World but boot and program revision changes do', async (t) => {
  const f = await fixture(t);
  f.state.gateway = { configured: true, reachable: true, bootId: 'boot-1', instanceId: 'instance-1',
    state: 'disabled', serialOpen: false, motionEnabled: false, lastRx: 100 };
  f.state.programs = { revision: 0 };
  await f.world.start(f.host);
  f.state.gateway.lastRx = 200;
  await f.world.poll(); assert.equal(f.events.length, 1);
  f.state.gateway.bootId = 'boot-2';
  await f.world.poll(); assert.equal(f.events.length, 2);
  f.state.programs.revision = 1;
  await f.world.poll(); assert.equal(f.events.length, 3);
});

test('unverified duration and invalid operation ids are rejected before submitting', async (t) => {
  const f = await fixture(t); await f.world.start(f.host);
  const before = f.calls.length;
  assert.equal((await f.tool('canbot_do', { action: 'head.nod', durationMs: 100 })).failed, true);
  assert.equal((await f.tool('canbot_do', { action: 'head.nod', requestId: 'x'.repeat(65) })).failed, true);
  assert.equal((await f.tool('canbot_stop', { requestId: 'bad id' })).failed, true);
  assert.equal(f.calls.length, before);
});

test('serial-write receipt cannot become physical completion in the World', async (t) => {
  const f = await fixture(t, { '/v1/actions': async (_req, res) => {
    res.statusCode = 202;
    res.end(JSON.stringify({ accepted: true, sent: true, confirmed: false, outcome: 'serial_write_returned' }));
  } });
  await f.world.start(f.host);
  const result = await f.tool('canbot_do', { action: 'head.nod', requestId: 'one' });
  assert.equal(result.failed, undefined);
  assert.equal(JSON.parse(result.text).physicalCompletion, 'unknown');
  assert.equal(JSON.parse(result.text).retryAutomatically, false);
});

test('logic save/delete tools use revisioned CRUD and no robot action endpoint', async (t) => {
  const f = await fixture(t, {
    '/v1/programs': async (_req, res) => res.end(JSON.stringify({ revision: 0, programs: [], executionSupported: false })),
    '/v1/programs/hello': async (req, res, call) => {
      if (req.method === 'PUT') res.end(JSON.stringify({ saved: true, revision: 1, executionSupported: false, program: { name: 'hello', steps: call.body.steps } }));
      else if (req.method === 'DELETE') res.end(JSON.stringify({ deleted: true, revision: 2, factoryPresetsChanged: false }));
      else res.end(JSON.stringify({ revision: 1, program: { name: 'hello', steps: [{ action: 'head.nod', waitMs: 100 }] } }));
    },
  });
  await f.world.start(f.host);
  assert.equal(JSON.parse((await f.tool('canbot_programs')).text).revision, 0);
  const saved = await f.tool('canbot_program_save', { name: 'hello', expectedRevision: 0, steps: [{ action: 'head.nod', waitMs: 100 }] });
  assert.equal(saved.failed, undefined); assert.equal(JSON.parse(saved.text).storageOutcome, 'committed');
  assert.equal(JSON.parse((await f.tool('canbot_program_get', { name: 'hello' })).text).revision, 1);
  const deleted = await f.tool('canbot_program_delete', { name: 'hello', expectedRevision: 1 });
  assert.equal(JSON.parse(deleted.text).factoryPresetsChanged, false);
  assert.equal(f.events.filter((event) => event.type === 'canbot.program').length, 2);
  assert.equal(f.calls.filter((call) => ['/v1/actions', '/v1/stop'].includes(call.path)).length, 0);
  const before = f.calls.length;
  assert.equal((await f.tool('canbot_program_save', { name: 'bad', expectedRevision: 0, steps: [{ command: 37 }] })).failed, true);
  assert.equal((await f.tool('canbot_program_delete', { name: '../escape', expectedRevision: 0 })).failed, true);
  assert.equal(f.calls.length, before);
});

test('logic mutation timeout is an unknown storage result and never retried', async (t) => {
  const f = await fixture(t, { '/v1/programs/hello': async () => {} });
  f.world.client.timeoutMs = 250; await f.world.start(f.host);
  const result = await f.tool('canbot_program_save', { name: 'hello', expectedRevision: 0, steps: [{ action: 'head.nod' }] });
  assert.equal(result.failed, true);
  const body = JSON.parse(result.text);
  assert.equal(body.storageOutcome, 'unknown'); assert.equal(body.retryAutomatically, false);
  assert.equal(f.calls.filter((call) => call.path === '/v1/programs/hello').length, 1);
});

test('bounded movement submits one named macro and receipt lookup uses GET with the same explicit ID', async t => {
  const f = await fixture(t, {
    '/v1/timed-actions': async (_req, res, call) => {
      res.statusCode = 202; res.end(JSON.stringify({ requestId: call.body.requestId, accepted: true, sent: true,
        state: 'running', outcome: 'serial_write_returned', stop: { status: 'reserved', sent: null } }));
    },
    '/v1/timed-actions/move-1': async (_req, res) => res.end(JSON.stringify({ requestId: 'move-1', state: 'stop_write_returned',
      stop: { sent: true }, physicalCompletion: 'unknown', retryAutomatically: false })),
  });
  await f.world.start(f.host);
  const moved = await f.tool('canbot_move', { requestId: 'move-1', action: 'leg.forward', durationMs: 3000 });
  assert.equal(moved.failed, undefined); assert.equal(JSON.parse(moved.text).requestId, 'move-1');
  assert.equal(JSON.parse(moved.text).physicalCompletion, 'unknown');
  const queried = await f.tool('canbot_move_receipt', { requestId: 'move-1' });
  assert.equal(JSON.parse(queried.text).state, 'stop_write_returned');
  assert.deepEqual(f.calls.filter(c => c.path.startsWith('/v1/timed-actions')).map(c => [c.method, c.path, c.body]), [
    ['POST', '/v1/timed-actions', { requestId: 'move-1', action: 'leg.forward', durationMs: 3000 }],
    ['GET', '/v1/timed-actions/move-1', undefined],
  ]);
  assert.equal(f.events.filter(e => e.type === 'canbot.command').length, 1);
});

test('bounded tools reject absent IDs, unknown or conflicting macros, wheel overflow and extra control fields before HTTP', async t => {
  const f = await fixture(t); await f.world.start(f.host); const before = f.calls.length;
  const ok = { requestId: 'one', action: 'head.nod', durationMs: 12000 };
  for (const value of [ {}, { ...ok, requestId: undefined }, { ...ok, action: 'head.look_left' },
    { ...ok, action: 'leg.forward', durationMs: 3001 }, { ...ok, durationMs: 12001 }, { ...ok, durationMs: 99 },
    { ...ok, durationMs: 500.5 }, { ...ok, durationMs: '500' }, { ...ok, command: 37 }, { ...ok, epoch: 1 } ]) {
    assert.equal((await f.tool('canbot_move', value)).failed, true);
  }
  for (const value of [ {}, { requestId: '../status' }, { requestId: 'one', action: 'head.nod' } ]) {
    assert.equal((await f.tool('canbot_move_receipt', value)).failed, true);
  }
  assert.equal(f.calls.length, before);
});

test('bounded movement timeout keeps requestId and only a later explicit receipt tool sends GET', async t => {
  const f = await fixture(t, {
    '/v1/timed-actions': async () => {},
    '/v1/timed-actions/lost': async (_req, res) => { res.statusCode = 404; res.end(JSON.stringify({ code: 'operation_not_found' })); },
  });
  f.world.client.timeoutMs = 250; await f.world.start(f.host);
  const moved = await f.tool('canbot_move', { requestId: 'lost', action: 'head.shake', durationMs: 12000 });
  assert.equal(moved.failed, true); const body = JSON.parse(moved.text);
  assert.equal(body.requestId, 'lost'); assert.equal(body.outcome, 'unknown'); assert.equal(body.retryAutomatically, false);
  assert.equal((await f.tool('canbot_move_receipt', { requestId: 'lost' })).failed, true);
  assert.equal(f.calls.filter(c => c.method === 'POST' && c.path === '/v1/timed-actions').length, 1);
  assert.equal(f.calls.filter(c => c.path === '/v1/stop').length, 0);
});

test('bounded state transitions wake the World while operation counters do not; badge says bounded macros only', async t => {
  const f = await fixture(t);
  f.state.capabilities.timedMotionCommands = true;
  f.state.gateway = { boundedActions: { supported: true, instanceId: 'instance-one', epoch: 0,
    activeOperationId: null, unsettledOperations: 0, journalHealthy: true, operationCount: 0 } };
  await f.world.start(f.host); assert.equal(f.events.length, 1);
  assert.equal(f.world.webUi().badges.find(b => b.label === '运动').value, '有界宏可用');
  f.state.gateway.boundedActions.operationCount++;
  await f.world.poll(); assert.equal(f.events.length, 1);
  f.state.gateway.boundedActions.activeOperationId = 'active';
  await f.world.poll(); assert.equal(f.events.length, 2);
});

test('candidate packaged description matches live tools and prompt; normal speech still reuses existing tools', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const described = JSON.parse(await readFile(new URL('../describe.json', import.meta.url), 'utf8'));
  const prompt = await readFile(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8');
  assert.equal(manifest.version, '0.8.0-candidate.8');
  assert.deepEqual(described.tools, CANBOT.describe.tools);
  assert.deepEqual(described.events, CANBOT.describe.events);
  assert.equal(described.prompts[0].content, prompt);
  assert.equal(described.tools.length, 25); assert(described.tools.some(t => t.name === 'canbot_voice_control'));
  assert(described.tools.some(t => t.name === 'canbot_speech_wait'));
  assert(prompt.includes('stt_transcribe')); assert(prompt.includes('音频log句柄'));
  assert(prompt.includes('tts_speak')); assert(prompt.includes('audio-play')); assert(prompt.includes('canbot_voice_control'));
  assert(prompt.includes('supportsCue=true')); assert(prompt.includes('cue=true')); assert(prompt.includes('最多30秒'));
  assert(!described.tools.some(t => /stt|tts/.test(t.name)));
});
