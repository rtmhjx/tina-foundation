import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventOutbox } from './event-outbox.mjs';

test('failed or invalid cursor keeps the submitted event pending and does not retry', async () => {
  for (const result of [undefined, { cursor: NaN }, { cursor: '12' }, { cursor: 0 }, { cursor: -1 }]) {
    const folder = await mkdtemp(join(tmpdir(), 'outbox-')); let submitted = 0;
    try {
      const box = new EventOutbox({ folder, host: { pushEvent: async () => { submitted++; return result; } } });
      await assert.rejects(box.push({ type: 'canbot.speech', text: 'test', origin: 'external' }), /event_outcome_unknown/);
      const files = await readdir(folder); assert.equal(files.length, 1);
      assert.equal(JSON.parse(await readFile(join(folder, files[0]), 'utf8')).state, 'pending_outcome_unknown'); assert.equal(submitted, 1);
    } finally { await rm(folder, { recursive: true, force: true }); }
  }
});

test('valid event cursor is recorded before the outbox reports completion', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'outbox-'));
  try {
    const box = new EventOutbox({ folder, host: { pushEvent: async () => ({ cursor: 42 }) } });
    await box.push({ type: 'canbot.speech', text: 'test', origin: 'external' });
    const [file] = await readdir(folder), record = JSON.parse(await readFile(join(folder, file), 'utf8'));
    assert.equal(record.state, 'confirmed'); assert.equal(record.cursor, 42);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('partial transcript is durably archived with delivery disabled, while a pause wakes once', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'outbox-options-')), submissions = [];
  try {
    const box = new EventOutbox({ folder, host: { pushEvent: async (event, options) => {
      submissions.push({ event, options }); return { cursor: submissions.length };
    } } });
    await box.push({ type: 'canbot.speech.partial', origin: 'external', text: '正在说' }, { deliver: false });
    await box.push({ type: 'canbot.speech.pause', origin: 'external', text: '出现停顿' }, { trigger: 'flush' });
    assert.deepEqual(submissions.map(x => x.options), [{ deliver: false }, { trigger: 'flush' }]);
    const records = await Promise.all((await readdir(folder)).map(async name => JSON.parse(await readFile(join(folder, name), 'utf8'))));
    assert(records.some(x => x.event.type === 'canbot.speech.partial' && x.state === 'confirmed' && x.options.deliver === false));
    await assert.rejects(box.push({ type: 'canbot.speech', text: 'x' }, { trigger: 'interrupt' }), /event_options_invalid/);
    assert.equal(submissions.length, 2);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
