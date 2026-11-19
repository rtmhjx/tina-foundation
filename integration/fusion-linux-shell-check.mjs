import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setupFusionMemory } from '../scripts/setup-fusion-memory.mjs';
import { openFusionApp } from '../src/fusion-app.mjs';

assert.equal(process.platform, 'linux');
const root = resolve(import.meta.dirname, '..');
const base = join(root, '.tina-fusion-dev');
await mkdir(base, { recursive: true });
const work = await mkdtemp(join(base, 'linux-native-shell-'));
const stateDir = join(work, 'state');
const marker = 'TINA_LINUX_NATIVE_SHELL_' + randomUUID().replaceAll('-', '');
const report = { status: 'running', work, stateDir, startedAt: new Date().toISOString(),
  modelCalls: 0, productionDataUsed: false, calls: [], checks: [] };
let app;
try {
  report.setup = await setupFusionMemory({ root, stateDir });
  assert.equal(report.setup.status, 'complete');
  app = await openFusionApp({ stateDir, port: 0, beforeStart({ bot, ctx }) {
    bot.core.bus.setPaused(true);
    ctx.on('llm/stream', () => { report.modelCalls++; throw new Error('No model calls allowed in native Linux shell acceptance.'); });
  } });
  report.sessionId = app.sessionId;
  report.workspace = app.dsh.workspaceDir;
  const agent = app.dsh.ctx.agents.get(app.sessionId);
  const schemas = app.dsh.ctx.tools.schemas(agent);
  report.shellTools = schemas.map(row => row.name).filter(name => /bash|pwsh|terminal/.test(name));
  assert.ok(report.shellTools.includes('bash'), 'Native Linux profile must expose bash.');
  assert.ok(!report.shellTools.includes('pwsh'), 'Windows pwsh must not replace Linux bash.');
  report.checks.push('native-linux-shell-selection');
  async function call(name, args) {
    const result = await app.dsh.ctx.tools.execute({ agent, name, arguments: args,
      callId: 'linux-shell-' + randomUUID(), signal: AbortSignal.timeout(30_000) });
    report.calls.push({ name, isError: result.isError, value: result.value, content: result.content });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result;
  }
  const result = await call('bash', { command: `printf '%s\\n' '${marker}' > linux-shell-marker.txt\ncat linux-shell-marker.txt`,
    description: 'Write and read one synthetic acceptance marker in the isolated workspace.', workdir: app.dsh.workspaceDir, timeoutMs: 10_000 });
  const text = result.content.filter(row => row.type === 'text').map(row => row.text).join('\n');
  assert.ok(text.includes(marker));
  assert.ok(!text.includes('[exit code:') && !text.includes('[sandbox:'));
  assert.equal(result.value.exitCode, 0);
  assert.equal(result.value.timedOut, false);
  assert.equal(result.value.sandbox?.denied, false);
  report.checks.push('native-bash-process-exit-zero', 'workspace-write-sandbox-allows-fixture');
  const path = join(app.dsh.workspaceDir, 'linux-shell-marker.txt');
  const schema = schemas.find(row => row.name === 'read');
  const key = ['file_path', 'path', 'filePath', 'filename'].find(name => name in (schema.parameters?.properties ?? {}));
  assert.ok(key);
  const readback = await call('read', { [key]: path });
  assert.ok(readback.content.some(row => row.type === 'text' && row.text.includes(marker)));
  assert.equal(await readFile(path, 'utf8'), marker + '\n');
  report.markerSha256 = createHash('sha256').update(await readFile(path)).digest('hex');
  report.checks.push('native-read-retrieves-shell-created-file', 'independent-file-readback');
  assert.equal(report.modelCalls, 0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  await app?.close();
  report.appClosed = true;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(work, 'RESULT.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
