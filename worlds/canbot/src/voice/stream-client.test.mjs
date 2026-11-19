import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamClient } from './stream-client.mjs';

function setup({ lostStart = false, lostAck = false, lostLease = false, gap = false } = {}) {
  const calls = [], guardCalls = [], clock = { now: 0 }; let op, ack = 0, stopped = false, acks = 0, leases = 0, consumed = 0;
  const chunk = { sequence: 1, startFrame: 0, frameCount: 16000, sha256: '0'.repeat(64), final: false, bytes: 7 };
  const transport = { async request(path, options = {}) {
    calls.push({ path, ...options });
    if (path === '/v1/status') return { schemaVersion: 'canbot.diagnostics.v2', foreground: true, instanceId: 'instance', lastSequence: 2, activeOperation: null, microphoneCapture: { supportsStream: true } };
    if (path === '/v1/microphone-stream') { op = options.body.operationId; if (lostStart) throw Error('lost'); return {}; }
    if (path.endsWith('/ack')) { acks++; if (lostAck && acks === 1) throw Error('lost'); ack = options.body.throughSequence; return {}; }
    if (path.endsWith('/lease')) { leases++; if (lostLease && leases === 1) throw Error('lost'); return {}; }
    if (path.endsWith('/stop')) { stopped = true; return { settled: false }; }
    if (path.includes('/chunks/')) return Buffer.from('fixture');
    if (path === `/v1/microphone-stream/${op}`) return { operationId: op, instanceId: 'instance', sampleRate: 16000,
      channels: 1, bitsPerSample: 16, chunks: ack ? [] : [chunk], lastAckSequence: ack, settled: stopped, tailState: stopped ? 'flushed' : 'open',
      finalProduced: stopped, finalEmpty: false, finalSequence: 1, tailBoundaryUnknown: false, gap: gap ? { reason: 'overflow' } : null };
    throw Error('unknown route');
  } };
  const guard = { async reserve(v) { guardCalls.push(['reserve', v]); }, async settle(...v) { guardCalls.push(['settle', ...v]); } };
  const spoolFactory = async ({ ack: ackFn, sampleRate }) => ({ sampleRate, firstSequence: 1, chunks: [], async init() {},
    async ingest(item) { this.chunks.push(item); await ackFn(item.sequence); return { duplicate: false, shouldStop: false }; },
    async finish() { return { files: [], deviceSettled: true }; } });
  const client = new StreamClient({ transport, guard, spoolFactory, clock: () => clock.now, onChunk: () => { consumed++; } });
  return { client, calls, guardCalls, clock, count: () => ({ acks, leases, consumed }) };
}

test('one start POST, same-operation ACK and lease retry, stop settlement separated', async () => {
  const f = setup({ lostStart: true, lostAck: true, lostLease: true });
  await f.client.start({ mode: 'press_stop' }); assert.equal(f.guardCalls[0][0], 'reserve');
  f.clock.now = 6000; await f.client.tick();
  assert.equal(f.calls.filter(c => c.path === '/v1/microphone-stream').length, 1);
  const leases = f.calls.filter(c => c.path.endsWith('/lease')); assert.equal(leases.length, 2);
  assert.deepEqual(leases[0].body, leases[1].body); assert.equal(leases[0].body.leaseSequence, 1);
  const acks = f.calls.filter(c => c.path.endsWith('/ack')); assert.equal(acks.length, 2); assert.deepEqual(acks[0].body, acks[1].body);
  assert.equal(f.count().consumed, 1); assert.equal((await f.client.stop()).deviceStopConfirmed, false);
  assert.equal((await f.client.tick()).deviceStopConfirmed, true); assert.equal(f.guardCalls.filter(c => c[0] === 'settle').length, 0);
});

test('gap causes failure and one stop request; no clearance', async () => {
  const f = setup(); await f.client.start({ mode: 'press_stop' });
  f.client.transport.request = async (path, opts) => {
    f.calls.push({ path, ...opts });
    if (path.endsWith('/stop')) return { settled: false };
    return { operationId: f.client.operation.operationId, instanceId: 'instance', gap: true };
  };
  await assert.rejects(f.client.tick(), /stream_gap_or_unknown/);
  assert.equal(f.calls.filter(c => c.path.endsWith('/stop')).length, 1);
  assert.equal(f.client.status().capture.gap, true);
  assert.equal(f.client.status().capture.lastObservedGap, true);
  f.clock.now += 3000; assert.equal(f.client.status().capture.gap, null);
  assert.equal(f.guardCalls.filter(c => c[0] === 'settle').length, 0);
});

test('stop during in-flight start waits for that one POST and submits one stop', async () => {
  const f = setup(); const request = f.client.transport.request; let release;
  const pending = new Promise(r => { release = r; }); let inPost;
  f.client.transport.request = async (path, options) => {
    if (path === '/v1/microphone-stream') { inPost = request(path, options); await pending; return inPost; }
    return request(path, options);
  };
  const start = f.client.start({ mode: 'press_stop' });
  while (!inPost) await new Promise(r => setTimeout(r, 0));
  const stop = f.client.stop();
  assert.equal(f.calls.filter(x => x.path.endsWith('/stop')).length, 0);
  release(); await Promise.all([start, stop]);
  assert.equal(f.calls.filter(x => x.path === '/v1/microphone-stream').length, 1);
  assert.equal(f.calls.filter(x => x.path.endsWith('/stop')).length, 1);
  assert.equal(f.calls.filter(x => x.path.endsWith('/lease')).length, 0);
});

test('a final chunk published between snapshots is fetched on the next tick', async () => {
  const f = setup(); await f.client.start({ mode: 'press_stop' });
  const request = f.client.transport.request; let snapshots = 0; let ack = 0;
  const chunk = { sequence: 1, startFrame: 0, frameCount: 16000, sha256: '0'.repeat(64), final: true, bytes: 7 };
  f.client.transport.request = async (path, opts = {}) => {
    if (path.endsWith('/ack')) { ack = opts.body.throughSequence; return {}; }
    if (path.includes('/chunks/')) return Buffer.from('fixture');
    if (path === f.client.path()) {
      snapshots++;
      return { operationId: f.client.operation.operationId, instanceId: 'instance', sampleRate: 16000, channels: 1, bitsPerSample: 16,
        chunks: snapshots === 1 || ack ? [] : [chunk], lastAckSequence: ack, settled: snapshots > 1,
        tailState: snapshots > 1 ? 'flushed' : 'open', finalProduced: snapshots > 1, finalEmpty: false,
        finalSequence: snapshots > 1 ? 1 : null, tailBoundaryUnknown: false, gap: null };
    }
    return request(path, opts);
  };
  await f.client.tick(); assert.equal(f.client.finished, false); assert.equal(ack, 0);
  await f.client.tick(); assert.equal(f.client.finished, true); assert.equal(ack, 1);
  f.clock.now += 3000; assert.equal(f.client.status().capture.gap, false);
});
