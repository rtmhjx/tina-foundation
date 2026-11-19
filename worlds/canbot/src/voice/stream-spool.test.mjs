import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamSpool } from './stream-spool.mjs';

function wav(frames, sound = false, rate = 16000) {
  const data = Buffer.alloc(44 + frames * 2); data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  if (sound) for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(9000 * Math.sin(i * .2)), 44 + i * 2);
  return data;
}
const chunk = (sequence, startFrame, frames, sound) => { const data = wav(frames, sound); return { sequence, startFrame,
  frameCount: frames, sha256: createHash('sha256').update(data).digest('hex'), wav: data }; };

test('ACK only follows durable chunk and manifest; duplicate ACK does not duplicate data', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'voice-spool-')); const acks = [];
  try {
    const s = new StreamSpool({ folder, streamId: randomUUID(), mode: 'press_stop', sampleRate: 16000, ack: async seq => {
      const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
      assert.equal(manifest.chunks.length, 1); assert.ok((await readFile(join(folder, manifest.chunks[0].file))).length > 44); acks.push(seq);
    } });
    await s.init(); const c = chunk(1, 0, 16000, true);
    assert.equal((await s.ingest(c)).duplicate, false); assert.equal((await s.ingest(c)).duplicate, true);
    assert.deepEqual(acks, [1, 1]); assert.equal(s.chunks.length, 1);
    assert.equal((await s.finish({ settled: true, finalSequence: 1, finalEmpty: false, tailState: 'flushed' })).frames, 16000);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('8k fallback is checked against the advertised sample rate and keeps native frame offsets', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'voice-spool-'));
  try {
    const s = new StreamSpool({ folder, streamId: randomUUID(), mode: 'silence_stop', sampleRate: 8000, ack: async () => {} });
    await s.init(); const data = wav(8000, true, 8000), entry = { sequence: 1, startFrame: 0, frameCount: 8000,
      sha256: createHash('sha256').update(data).digest('hex'), wav: data };
    assert.equal((await s.ingest(entry)).duplicate, false); assert.equal(s.nextFrame, 8000);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('software-finalized tail with unknown capture boundary is retained and explicitly marked', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'voice-spool-'));
  try {
    const s = new StreamSpool({ folder, streamId: randomUUID(), mode: 'press_stop', sampleRate: 16000, ack: async () => {} });
    await s.init(); await s.ingest(chunk(1, 0, 16000, true));
    const final = await s.finish({ settled: true, finalSequence: 1, finalEmpty: false, tailState: 'flushed_read_unknown' });
    assert.equal(final.deviceSettled, true); assert.equal(final.tailBoundaryVerified, false); assert.equal(final.hardwareContinuityVerified, false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('continuous mode retires only acknowledged and processed complete chunks; later frames remain', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'voice-spool-'));
  try {
    const s = new StreamSpool({ folder, streamId: randomUUID(), mode: 'continuous', sampleRate: 16000, ack: async () => {} });
    await s.init(); await s.ingest(chunk(1, 0, 16000, true)); await s.ingest(chunk(2, 16000, 16000, false));
    assert.equal(await s.pruneThrough(15999), 0); assert.equal(await s.pruneThrough(16000), 1);
    assert.equal(s.firstSequence, 2); assert.equal(s.chunks.length, 1); assert.equal(s.nextFrame, 32000);
    await assert.rejects(readFile(join(folder, 'chunk-0000000001.wav')), /ENOENT/);
    assert.ok((await readFile(join(folder, 'chunk-0000000002.wav'))).length > 44);
    await s.ingest(chunk(3, 32000, 16000, true));
    assert.equal((await s.finish({ settled: true, finalSequence: 3, finalEmpty: false, tailState: 'flushed' })).frames, 48000);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('interrupted manifest persistence never acknowledges or prunes the audio', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'voice-spool-')); let acknowledgements = 0;
  try {
    const s = new StreamSpool({ folder, streamId: randomUUID(), mode: 'continuous', sampleRate: 16000, ack: async () => { acknowledgements++; } });
    await s.init(); await writeFile(join(folder, 'manifest.json.tmp'), 'simulated partial write');
    await assert.rejects(s.ingest(chunk(1, 0, 16000, true))); assert.equal(acknowledgements, 0);
    assert.ok((await readFile(join(folder, 'chunk-0000000001.wav'))).length > 44);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('gap, bad hash, wrong frame count and disk cap never ACK', async () => {
  for (const bad of ['gap', 'hash', 'frames', 'capacity']) {
    const folder = await mkdtemp(join(tmpdir(), 'voice-spool-')); let acks = 0;
    try {
      const s = new StreamSpool({ folder, streamId: randomUUID(), mode: 'press_stop', sampleRate: 16000, maxBytes: 200000, ack: async () => { acks++; } });
      await s.init(); const c = chunk(bad === 'gap' ? 2 : 1, 0, bad === 'capacity' ? 48000 : 16000, true);
      if (bad === 'hash') c.sha256 = '0'.repeat(64); if (bad === 'frames') c.frameCount++;
      if (bad === 'capacity') { s.bytes = 150000; }
      await assert.rejects(s.ingest(c)); assert.equal(acks, 0);
    } finally { await rm(folder, { recursive: true, force: true }); }
  }
});

test('silence mode requests stop only after speech then configured quiet interval', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'voice-spool-'));
  try {
    const s = new StreamSpool({ folder, streamId: randomUUID(), mode: 'silence_stop', sampleRate: 16000, silenceMs: 1500, ack: async () => {} });
    await s.init(); assert.equal((await s.ingest(chunk(1, 0, 16000, true))).shouldStop, false);
    assert.equal((await s.ingest(chunk(2, 16000, 16000, false))).shouldStop, false);
    assert.equal((await s.ingest(chunk(3, 32000, 16000, false))).shouldStop, true);
    await assert.rejects(s.finish({ settled: false, finalSequence: 3, finalEmpty: false, tailState: 'flushed' }), /not_safely/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
