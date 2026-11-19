import test from 'node:test';
import assert from 'node:assert/strict';
import definition from '../src/world.mjs';

test('World describes both independent native tools without provider or memory coupling', () => {
  assert.equal(definition.id, 'linux-tools');
  const w = definition.create({ botDir: '/isolated-test' });
  assert.deepEqual(w.tools().map(t => t.name), ['linux_run', 'linux_status']);
  assert.deepEqual(w.tools().map(t => t.name), definition.describe.tools.map(t => t.name));
});

test('stopped World cannot execute', async () => {
  const w = definition.create({ botDir: '/isolated-test' });
  const result = await w.tools()[0].handler({ command: 'echo test' });
  assert.equal(result.failed, true);
});
