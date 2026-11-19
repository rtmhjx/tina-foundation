import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { openEmbeddedDsh } from '../src/dsh-embedded.mjs';

const root = resolve(process.argv[2] ?? 'runtime/dsh-0.1.5-rc.2');
const manifest = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8'));
const { links } = JSON.parse(await readFile(join(root, 'runtime-links.json'), 'utf8'));
for (const link of links) {
  const actual = await realpath(resolve(root, link.at));
  assert.equal(actual, resolve(root, link.to));
  assert.ok(actual.startsWith(root + sep));
}
const base = resolve('.tina-fusion-dev');
await mkdir(base, { recursive: true });
const state = await mkdtemp(join(base, 'source-runtime-smoke-'));
const runtime = await openEmbeddedDsh({
  deploymentDir: state, dshRoot: root, expectedVersion: manifest.cliVersion, surface: 'headless',
});
try {
  assert.ok(runtime.ctx.get('sessionController'));
  assert.ok(runtime.ctx.get('tools'));
  assert.ok(runtime.ctx.get('settings'));
  assert.ok(!runtime.ctx.get('webServer'));
  const agent = await runtime.importPackage('@deepseek-ai/dsh-agent');
  assert.ok(agent);
  console.log(JSON.stringify({
    version: runtime.version, pid: runtime.pid, profile: runtime.profile,
    packages: manifest.packages.length, internalLinks: links.length, state,
    sessionController: true, tools: true, settings: true, noDshWebServer: true,
  }));
} finally {
  await runtime.stop();
}
