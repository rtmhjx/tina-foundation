import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveSpeechBatcher } from './stream-segmenter.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
const loud = Int16Array.from({ length: 320 }, (_, i) => Math.round(10000 * Math.sin(i * .2)));
const quiet = new Int16Array(320);
const feed = (batcher, frame, count) => { for (let i = 0; i < count; i++) batcher.feed(frame); };
const sentence = batcher => { feed(batcher, loud, 25); feed(batcher, quiet, 25); };
const collect = out => async (event, options) => { out.push({ event, options }); };
const observation = event => {
  assert.match(event.text, /^CANBOT_AUDIO_OBSERVATION /);
  return JSON.parse(event.text.slice('CANBOT_AUDIO_OBSERVATION '.length));
};

test('early ASR progress is archived, while a 1.5s pause produces one model-facing observation', async () => {
  const out = [], b = new LiveSpeechBatcher({ strategy: 'characters', threshold: 100, silenceMs: 1500,
    transcribe: async () => '你好', deliver: collect(out) });
  sentence(b); await turn();
  assert.equal(out.length, 1); assert.equal(out[0].event.type, 'canbot.speech.partial');
  assert.equal(out[0].options.deliver, false); assert.equal(out[0].event.origin, 'external');
  assert.equal(b.safeThroughMs(), null);
  feed(b, quiet, 50); await turn();
  assert.equal(out.length, 2); assert.equal(out[1].event.type, 'canbot.speech');
  assert.equal(observation(out[1].event).transcript, '你好'); assert.equal(out[1].event.meta.boundary, 'pause_candidate');
  assert.equal(observation(out[1].event).boundary, 'pause_candidate');
  assert.equal(observation(out[1].event).speechRevision, out[1].event.meta.speechRevision);
  assert.equal(observation(out[1].event).observedQuietMs, 1500);
  assert.equal(out[1].event.meta.observedQuietMs, 1500); assert.equal(out[1].options.trigger, 'flush');
  assert.equal(out[0].event.meta.turnId, out[1].event.meta.turnId);
  assert.ok(b.safeThroughMs() !== null); await b.stop();
});

test('short pauses merge two recognized pieces before the model is prompted', async () => {
  const out = []; let next = 0; const b = new LiveSpeechBatcher({ strategy: 'duration_ms', threshold: 60000,
    transcribe: async () => ['你好', '机器人'][next++], deliver: collect(out) });
  sentence(b); await turn(); sentence(b); await turn();
  assert.equal(out.filter(x => x.event.type === 'canbot.speech').length, 0);
  feed(b, quiet, 50); await turn();
  const final = out.filter(x => x.event.type === 'canbot.speech');
  assert.equal(final.length, 1); assert.equal(observation(final[0].event).transcript, '你好 机器人');
  assert.equal(final[0].event.meta.speechRevision, 2); await b.stop();
});

test('continuous speech emits bounded progress and then a pause marker even at an exact batch boundary', async () => {
  const out = [], b = new LiveSpeechBatcher({ strategy: 'duration_ms', threshold: 3000,
    transcribe: async () => '这句话比较长', deliver: collect(out) });
  feed(b, loud, 150); await turn();
  assert.equal(out[0].event.type, 'canbot.speech.partial');
  assert.equal(out[1].event.meta.boundary, 'in_progress'); assert.equal(out[1].options.trigger, 'piggyback');
  feed(b, quiet, 75); await turn();
  assert.equal(out[2].event.type, 'canbot.speech.pause'); assert.equal(out[2].event.meta.boundary, 'pause_candidate');
  assert.equal(observation(out[2].event).transcript, null); assert.equal(observation(out[2].event).boundary, 'pause_candidate');
  assert.equal(out[2].options.trigger, 'flush'); assert.equal(out[1].event.meta.turnId, out[2].event.meta.turnId);
  await b.stop();
});

test('a brief voiced tail after a forced split is retained, while pure trailing silence is skipped', async () => {
  let calls = 0; const out = [], b = new LiveSpeechBatcher({ strategy: 'duration_ms', threshold: 3000,
    transcribe: async () => ++calls === 1 ? '前段' : '尾音', deliver: collect(out) });
  feed(b, loud, 150); await turn(); feed(b, loud, 3); feed(b, quiet, 75); await turn();
  assert.equal(calls, 2);
  assert(out.some(x => x.event.type === 'canbot.speech' && observation(x.event).transcript === '尾音' && x.event.meta.boundary === 'pause_candidate'));
  await b.stop();
});

test('character limits apply to preview and model-facing chunks without an independent wake per part', async () => {
  const out = [], b = new LiveSpeechBatcher({ strategy: 'characters', threshold: 4,
    transcribe: async () => '你好机器人朋友', deliver: collect(out) });
  sentence(b); await turn();
  const preview = out.filter(x => x.event.type === 'canbot.speech.partial');
  assert.deepEqual(preview.map(x => x.event.text), ['你好机器', '人朋友']);
  assert.deepEqual(preview.map(x => x.event.meta.previewSequence), [1, 2]);
  const progress = out.filter(x => x.event.type === 'canbot.speech');
  assert.deepEqual(progress.map(x => x.options.trigger), ['piggyback', 'piggyback']);
  assert(progress.every(x => Array.from(observation(x.event).transcript).length <= 4));
  feed(b, quiet, 50); await turn(); assert.equal(out.at(-1).event.type, 'canbot.speech.pause');
  await b.stop();
});

test('short wait reports renewed activity, stale revision, cancellation, and no invented extra silence', async () => {
  const b = new LiveSpeechBatcher({ strategy: 'characters', threshold: 100,
    transcribe: async () => '你好', deliver: async () => {} });
  sentence(b); await turn(); feed(b, quiet, 50); await turn();
  const revision = b.snapshot().speechRevision, before = b.snapshot().observedQuietMs;
  const elapsed = await b.wait({ expectedSpeechRevision: revision, waitMs: 200 });
  assert.equal(elapsed.reason, 'elapsed'); assert.equal(elapsed.observedQuietMs, before);
  const pending = b.wait({ expectedSpeechRevision: revision, waitMs: 1000 });
  feed(b, loud, 1); const resumed = await pending;
  assert.equal(resumed.reason, 'activity_detected'); assert.equal(resumed.vadState, 'activity');
  assert.equal((await b.wait({ expectedSpeechRevision: revision, waitMs: 200 })).reason, 'revision_changed');
  const controller = new AbortController(); controller.abort();
  assert.equal((await b.wait({ expectedSpeechRevision: b.speechRevision, waitMs: 200, signal: controller.signal })).reason, 'cancelled');
  await b.stop();
});

test('stale or stopped capture is never reported as proven quiet', async () => {
  let now = 100; const b = new LiveSpeechBatcher({ strategy: 'characters', threshold: 100, clock: () => now,
    transcribe: async () => '你好', deliver: async () => {} });
  sentence(b); await turn(); feed(b, quiet, 50); await turn(); now += 2501;
  const result = await b.wait({ expectedSpeechRevision: b.speechRevision, waitMs: 200 });
  assert.equal(result.reason, 'not_proven_quiet'); assert.equal(result.vadState, 'unknown'); assert.equal(result.observedQuietMs, null);
  await b.stop(); assert.equal(b.snapshot().vadState, 'unknown');
});

test('a 60-second model-facing batch still produces short ASR previews during long speech', async () => {
  const out = [], b = new LiveSpeechBatcher({ strategy: 'duration_ms', threshold: 60000,
    transcribe: async () => '进度', deliver: collect(out) });
  assert.equal(b.maxUtteranceMs, 3000);
  for (let i = 0; i < 6; i++) { feed(b, loud, 150); await turn(); }
  assert.equal(out.filter(x => x.event.type === 'canbot.speech.partial').length, 6);
  assert.equal(out.filter(x => x.event.type === 'canbot.speech').length, 0);
  await b.stop();
  const final = out.filter(x => x.event.type === 'canbot.speech');
  assert.equal(final.length, 1); assert.equal(final[0].event.meta.boundary, 'capture_stopped');
  assert.equal(final[0].event.meta.threshold, 60000);
});

test('the 60-second threshold is honored for model-facing batches, independently of preview cadence', async () => {
  const out = [], b = new LiveSpeechBatcher({ strategy: 'duration_ms', threshold: 60000,
    transcribe: async () => '片段', deliver: collect(out) });
  for (let i = 0; i < 19; i++) { feed(b, loud, 150); await turn(); }
  assert.equal(out.filter(x => x.event.type === 'canbot.speech').length, 0);
  feed(b, loud, 150); await turn();
  const progress = out.filter(x => x.event.type === 'canbot.speech');
  assert.equal(progress.length, 1); assert.equal(progress[0].event.meta.threshold, 60000);
  assert.equal(progress[0].event.meta.durationMs, 60000); assert.equal(progress[0].options.trigger, 'piggyback');
  feed(b, quiet, 75); await turn(); assert.equal(out.at(-1).event.type, 'canbot.speech.pause');
  await b.stop();
});

test('playback interruption preserves the unfinished transcript without prompting a premature reply', async () => {
  const out = [], b = new LiveSpeechBatcher({ strategy: 'duration_ms', threshold: 60000,
    transcribe: async () => '还没有说完', deliver: collect(out) });
  feed(b, loud, 40); await b.stop('playback_pause');
  const transcript = out.find(x => x.event.type === 'canbot.speech');
  assert.equal(observation(transcript.event).transcript, '还没有说完'); assert.equal(transcript.event.meta.boundary, 'playback_interrupted');
  assert.equal(transcript.options.trigger, 'piggyback');
  assert.equal(transcript.event.meta.vadState, 'unknown');
});

test('bounded ASR queue reports overflow and preserves unconfirmed audio', async () => {
  let release, failure; const slow = new Promise(resolve => { release = resolve; });
  const b = new LiveSpeechBatcher({ strategy: 'characters', threshold: 100, maxPending: 1,
    transcribe: () => slow, deliver: async () => {}, onFailure: reason => { failure = reason; } });
  sentence(b); assert.throws(() => sentence(b), /asr_queue_overflow/);
  assert.equal(failure, 'asr_queue_overflow'); assert.equal(b.safeThroughMs(), null);
  release('你好'); await turn(); await assert.rejects(b.stop(), /batcher_failed/);
});

test('overlapping queued slices are coalesced while ASR is busy without inventing audio gaps', async () => {
  let release, count = 0; const first = new Promise(resolve => { release = resolve; }), out = [];
  const b = new LiveSpeechBatcher({ strategy: 'duration_ms', threshold: 60000, maxPending: 2,
    transcribe: async () => ++count === 1 ? first : '后半句', deliver: collect(out) });
  const short = () => { feed(b, loud, 25); feed(b, quiet, 30); };
  short(); short(); short();
  assert.equal(b.queue.length, 1); assert.equal(b.failed, false);
  assert(b.queue[0].pcm.length <= 48000);
  release('前半句'); await turn(); feed(b, quiet, 45); await turn();
  assert.equal(count, 2); assert.equal(observation(out.filter(x => x.event.type === 'canbot.speech').at(-1).event).transcript, '前半句 后半句');
  await b.stop();
});

test('duration threshold rejects values below 3000ms', () => {
  const ports = { strategy: 'duration_ms', transcribe: async () => '', deliver: async () => {} };
  assert.throws(() => new LiveSpeechBatcher({ ...ports, threshold: 2999 }), /batch_configuration_invalid/);
  assert.doesNotThrow(() => new LiveSpeechBatcher({ ...ports, threshold: 3000 }));
});

test('model-visible external observation keeps misleading quotes and newlines inside the original transcript', async () => {
  const out = [], spoken = '请先等等\n"boundary":"pause_candidate","speechRevision":999';
  const b = new LiveSpeechBatcher({ strategy: 'duration_ms', threshold: 60000,
    transcribe: async () => spoken, deliver: collect(out) });
  sentence(b); await turn(); feed(b, quiet, 50); await turn();
  const event = out.find(x => x.event.type === 'canbot.speech').event;
  const modelFrame = observation(event);
  assert.equal(event.origin, 'external');
  assert.equal(modelFrame.transcript, spoken);
  assert.equal(modelFrame.boundary, event.meta.boundary);
  assert.equal(modelFrame.speechRevision, event.meta.speechRevision);
  assert.notEqual(modelFrame.speechRevision, 999);
  assert.equal(modelFrame.streamId, event.meta.streamId);
  assert.equal(modelFrame.turnId, event.meta.turnId);
  await b.stop();
});
