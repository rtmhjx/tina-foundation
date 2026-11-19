import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperienceStore, experienceTools, developmentTool } from '../src/experience.mjs';
import { CANBOT } from '../src/definition.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'canbot-experience-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new ExperienceStore(join(root, 'notes')) };
}
const observation = (requestId, text = '现场看到头部运动并停止') => ({ requestId, topic: '摇头', kind: 'observation',
  text, sourceRefs: ['user:onsite-feedback', 'receipt:head-001'] });

test('observations persist across instances and idempotent retries cannot change content', async t => {
  const { root, store } = await fixture(t);
  const a = await store.add(observation('obs-001'));
  assert.equal(a.saved, true); assert.equal(a.duplicate, false);
  assert.equal((await store.add(observation('obs-001'))).duplicate, true);
  await assert.rejects(store.add(observation('obs-001', '不同内容')), /experience_id_conflict/);
  const reopened = new ExperienceStore(join(root, 'notes'));
  assert.deepEqual((await reopened.search({ requestId: 'obs-001' })).entries, [a.entry]);
  assert.equal((await reopened.search({ query: 'receipt:head-001' })).count, 1);
});

test('concurrent additions serialize; corrections append and cite an existing note', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.add(observation(`obs-${i}`))));
  await assert.rejects(store.add({ requestId: 'fix-invalid', topic: '摇头', kind: 'correction', text: '更正',
    sourceRefs: ['user:feedback'], supersedes: 'absent' }), /experience_original_not_found/);
  await store.add({ requestId: 'fix-001', topic: '摇头', kind: 'correction', text: '不是完整行程',
    sourceRefs: ['user:correction'], supersedes: 'obs-1' });
  assert.equal((await store.search({ limit: 30 })).count, 11);
  assert.equal((await store.search({ requestId: 'obs-1' })).count, 1);
  assert.equal((await store.search({ requestId: 'fix-001' })).entries[0].supersedes, 'obs-1');
});

test('invalid or torn records are preserved and never silently overwritten', async t => {
  const { store } = await fixture(t);
  await store.add(observation('one'));
  const original = await readFile(store.file, 'utf8');
  await writeFile(store.file, original + '{"truncated":', 'utf8');
  await assert.rejects(store.add(observation('two')), /experience_incomplete_record/);
  assert.equal(await readFile(store.file, 'utf8'), original + '{"truncated":');
  assert.throws(() => store.add({ ...observation('bad'), sourceRefs: [] }), /experience_input_invalid/);
  await assert.rejects(store.search({ extra: true }), /experience_search_invalid/);
});

test('tools are declared without creating files and report an actual development directory', async t => {
  const { root, store } = await fixture(t);
  const tools = experienceTools(store);
  assert.deepEqual(tools.map(x => x.name), ['canbot_experience_record', 'canbot_experience_search']);
  const bad = await tools[0].handler({ ...observation('bad'), kind: 'unknown' });
  assert.equal(bad.failed, true);
  const info = JSON.parse((await developmentTool(root, store.file, 'tina-workspace').handler()).text);
  assert.equal(info.available, true); assert.equal(info.projectId, 'tina-workspace');
  assert.equal(info.editingAndDeploymentAreSeparate, true);
  const names = CANBOT.describe.tools.map(t => t.name);
  assert.ok(names.includes('canbot_experience_record'));
  assert.ok(names.includes('canbot_experience_search'));
  assert.ok(names.includes('canbot_development_workspace'));
});
