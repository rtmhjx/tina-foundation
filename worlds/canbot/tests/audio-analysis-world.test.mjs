import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanbotWorld } from '../src/world.mjs';
import { CANBOT_DEFAULTS } from '../src/config.mjs';

const ID = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222';
function wav() {
  const b = Buffer.alloc(32044); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(32000, 40); return b;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'canbot-analysis-world-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token'); await writeFile(tokenFile, 'b'.repeat(64), { mode: 0o600 });
  const world = new CanbotWorld({ cfg: { ...CANBOT_DEFAULTS, diarizationEnabled: true,
    diarizationTokenFile: tokenFile, audioAnalysisJournalDir: join(directory, 'journal') } });
  world.lifecycle = new AbortController(); t.after(() => world.lifecycle.abort());
  const blobCalls = [], analysisCalls = [], receiptCalls = [];
  world.host = { blob: handle => { blobCalls.push(handle); return { bytes: wav(), mime: 'audio/wav' }; } };
  world.diarization = { analyze: async args => { analysisCalls.push(args); return { requestId: args.requestId, state: 'complete', segments: [
    { start: 0, end: 0.8, speaker: 'anonymous_01', track: 'a' }, { start: 0.5, end: 1, speaker: 'anonymous_02', track: 'b' }] }; },
  receipt: async args => { receiptCalls.push(args); return { requestId: args.requestId, state: 'complete' }; } };
  return { world, blobCalls, analysisCalls, receiptCalls,
    tool: (name, args) => world.tools().find(t => t.name === name).handler(args, {}) };
}

test('8053 World records original blob identity and repeating the same request performs receipt only', async t => {
  const f = await fixture(t), args = { audio: 'log:authorized.wav', requestId: ID };
  const first = JSON.parse((await f.tool('canbot_diarize_audio', args)).text);
  assert.equal(first.segments.length, 2); assert(first.segments[1].start < first.segments[0].end);
  assert.equal(first.originalPreserved, true); assert.equal(first.accuracyAccepted, false);
  await f.tool('canbot_diarize_audio', args);
  assert.equal(f.analysisCalls.length, 1); assert.equal(f.receiptCalls.length, 1);
  assert.match(f.receiptCalls[0].expectedInputSha256, /^[0-9a-f]{64}$/);
  assert.equal(f.world.head, null); assert.equal(f.world.separation, null);
});

test('8053 World refuses unregistered receipts and non-log input before analysis', async t => {
  const f = await fixture(t);
  for (const [tool, args] of [['canbot_diarization_receipt', { requestId: ID }],
    ['canbot_diarize_audio', { requestId: ID, audio: 'C:/elsewhere.wav' }],
    ['canbot_diarize_audio', { requestId: ID, audio: 'log:authorized.wav', url: 'http://example.invalid' }]]) {
    assert.equal((await f.tool(tool, args)).failed, true);
  }
  assert.equal(f.analysisCalls.length, 0); assert.equal(f.receiptCalls.length, 0); assert.equal(f.blobCalls.length, 0);
});

test('8053 unknown remains registered, blocks same-audio new ID and cancellation never claims backend stop', async t => {
  const f = await fixture(t);
  f.world.diarization.analyze = async args => { f.analysisCalls.push(args); return { requestId: args.requestId, state: 'outcome_unknown', retryAutomatically: false }; };
  const first = await f.tool('canbot_diarize_audio', { audio: 'log:authorized.wav', requestId: ID });
  assert.equal(first.failed, true); assert.equal(JSON.parse(first.text).serverCancellationConfirmed, false);
  const next = await f.tool('canbot_diarize_audio', { audio: 'log:authorized.wav', requestId: ID2 });
  assert.equal(next.failed, true); assert.equal(f.analysisCalls.length, 1);
  assert.equal(JSON.parse(next.text).requestId, ID);
  await f.tool('canbot_diarization_receipt', { requestId: ID }); assert.equal(f.receiptCalls.length, 1);
});
