import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TinaSelfMem, computeRevision } from '../src/core.mjs';
import { createSelfMemToolkit } from '../src/tools.mjs';
import { createSelfMemHttpServer, RemoteTinaSelfMemClient } from '../src/http-server.mjs';
import { collectSessionLogs } from '../src/session-collector.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const MCP_PATH = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url));

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tina-selfmem-'));
  const dataDir = join(root, 'shared');
  const mem = new TinaSelfMem({ dataDir, ...options });
  t.after(async () => {
    try {
      await mem.close();
    } finally {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      rmSync(root, { recursive: true, force: true });
    }
  });
  // Warm-up registers only the default bot's ledger, so other window ids stay fresh.
  await mem.readSelfRaw();
  return { root, dataDir, mem };
}

function gitLog(cwd, relPath, limit = 20) {
  const res = spawnSync(
    'git',
    ['-c', 'core.quotepath=false', 'log', `-n${limit}`, '--format=%H\t%an\t%s', '--', relPath],
    { cwd, encoding: 'utf8', windowsHide: true }
  );
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [commit, author, subject] = line.split('\t');
    return { commit, author, subject };
  });
}

test('readLedger exposes ledger path, revision, and size budget per window', async (t) => {
  const { mem } = await fixture(t);

  const fresh = await mem.readLedger({ agentId: 'dsh' });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.agentId, 'dsh');
  assert.equal(fresh.ref, 'bot:dsh');
  assert.equal(fresh.path, 'bots/dsh/记忆库.md');
  assert.equal(fresh.exists, false);
  assert.equal(fresh.content, '');
  assert.equal(fresh.revision, computeRevision(''));
  assert.equal(fresh.maxChars, 8000);
  assert.equal(fresh.usedChars, 0);
  assert.equal(fresh.remainingChars, 8000);
  assert.equal(fresh.rev, null);

  // The default window's ledger was materialized during warm-up and is readable.
  const tina = await mem.readLedger({ agentId: 'tina' });
  assert.equal(tina.exists, true);
  assert.match(tina.content, /记忆库入口/);
  assert.notEqual(tina.revision, fresh.revision);

  // Instance `agentId` is the fallback when no argument is supplied.
  const { mem: scoped } = await fixture(t, { agentId: 'codex', ledgerMaxChars: 512 });
  const viaInstance = await scoped.readLedger();
  assert.equal(viaInstance.agentId, 'codex');
  assert.equal(viaInstance.maxChars, 512);
  assert.equal(viaInstance.exists, false);

  // Path separators and control characters never escape bots/<agentId>/.
  const unsafe = await scoped.readLedger({ agentId: '../escape' });
  assert.equal(unsafe.agentId, '.._escape');
  assert.equal(unsafe.path, 'bots/.._escape/记忆库.md');
});

test('a cold process reads an empty ledger and appends from an empty baseline', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tina-cold-ledger-'));
  const mem = new TinaSelfMem({ dataDir: join(root, 'data') });
  t.after(async () => {
    try {
      await mem.close();
    } finally {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      rmSync(root, { recursive: true, force: true });
    }
  });

  const before = await mem.readLedger({ agentId: 'cold-window' });
  assert.equal(before.exists, false);
  assert.equal(before.content, '');
  assert.equal(before.revision, computeRevision(''));

  const appended = await mem.patchLedger({
    agentId: 'cold-window',
    mode: 'append',
    newText: '- 冷启动第一条',
    expectedRevision: before.revision,
  });
  assert.equal(appended.changed, true);
  assert.equal(appended.content, '- 冷启动第一条\n');
  assert.equal(appended.previousRevision, computeRevision(''));

  // Reading the ledger first does not prevent the canvas from being initialized later.
  assert.match(await mem.readSelfRaw(), /自我与记忆画布/);
});

test('patchLedger appends, replaces, and records Git audit history', async (t) => {
  const { mem } = await fixture(t);

  const first = await mem.patchLedger({
    agentId: 'dsh',
    mode: 'append',
    newText: '- 任务：验证小账本\n- 结论：可写',
    summary: '初始化窗口账本',
  });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.exists, true);
  assert.equal(first.agentId, 'dsh');
  assert.equal(first.mode, 'append');
  assert.equal(first.path, 'bots/dsh/记忆库.md');
  assert.equal(first.previousRevision, computeRevision(''));
  assert.equal(first.revision, computeRevision(first.content));
  assert.equal(first.usedChars, Array.from(first.content).length);
  assert.equal(first.remainingChars, 8000 - first.usedChars);
  assert.match(first.commit, /^[0-9a-f]{12}$/);
  assert.ok(first.fullCommit.startsWith(first.commit));
  assert.equal(first.summary, '初始化窗口账本');
  assert.equal(first.reason, 'agent_ledger_patch');
  assert.equal(first.actor, 'dsh');
  assert.match(first.content, /^\- 任务：验证小账本/m);

  const read = await mem.readLedger({ agentId: 'dsh' });
  assert.equal(read.exists, true);
  assert.equal(read.content, first.content);
  assert.equal(read.revision, first.revision);
  assert.equal(read.rev, first.commit);

  const second = await mem.patchLedger({
    agentId: 'dsh',
    mode: 'replace',
    oldText: '- 结论：可写',
    newText: '- 结论：可写（已复验）',
    summary: '复验结论',
    expectedRevision: first.revision,
  });
  assert.equal(second.changed, true);
  assert.equal(second.previousRevision, first.revision);
  assert.match(second.content, /已复验/);
  assert.doesNotMatch(second.content, /- 结论：可写\n/);

  const whole = await mem.patchLedger({
    agentId: 'dsh',
    mode: 'replace',
    newText: '# dsh 账本\n\n- 只剩一条\n',
    summary: '整篇重写',
  });
  assert.equal(whole.content, '# dsh 账本\n\n- 只剩一条\n');

  const noop = await mem.patchLedger({ agentId: 'dsh', mode: 'replace', newText: whole.content });
  assert.equal(noop.changed, false);
  assert.equal(noop.commit, null);
  assert.equal(noop.fullCommit, null);
  assert.equal(noop.status, 'unchanged');
  assert.equal(noop.exists, true);
  assert.equal(noop.revision, whole.revision);

  // Registration + three accepted writes; the no-op must not add a commit.
  const log = gitLog(mem.authorityDir, 'bots/dsh/记忆库.md');
  assert.equal(log.length, 4);
  assert.equal(log[0].commit, whole.fullCommit);
  assert.ok(log.every((entry) => entry.author === 'dsh'));
  assert.match(log[0].subject, /^dsh .+: bot dsh$/);
  assert.equal(log[3].subject, 'Register Bot dsh');
});

test('patchLedger guards revisions, size limits, and invalid edits', async (t) => {
  const { mem } = await fixture(t, { ledgerMaxChars: 200 });
  const created = await mem.patchLedger({ agentId: 'opencode', mode: 'append', newText: '- a' });

  await assert.rejects(
    mem.patchLedger({ agentId: 'opencode', mode: 'append', newText: '- b', expectedRevision: 'deadbeefdeadbeef' }),
    (err) => err.code === 'LEDGER_REVISION_CONFLICT' && err.currentRevision === created.revision
  );
  assert.equal((await mem.readLedger({ agentId: 'opencode' })).content, created.content);

  await assert.rejects(
    mem.patchLedger({ agentId: 'opencode', mode: 'replace', oldText: '- missing', newText: '- x' }),
    { code: 'NOT_FOUND' }
  );
  await mem.patchLedger({ agentId: 'opencode', mode: 'append', newText: '- dup\n- dup' });
  await assert.rejects(
    mem.patchLedger({ agentId: 'opencode', mode: 'replace', oldText: '- dup', newText: '- x' }),
    { code: 'AMBIGUOUS_MATCH' }
  );
  await assert.rejects(
    mem.patchLedger({ agentId: 'opencode', mode: 'append', newText: '   ' }),
    { code: 'EMPTY_NEW_TEXT' }
  );
  await assert.rejects(
    mem.patchLedger({ agentId: 'opencode', mode: 'splice', newText: 'x' }),
    { code: 'INVALID_MODE' }
  );
  await assert.rejects(
    mem.patchLedger({ agentId: 'opencode', mode: 'append', newText: 'x'.repeat(400) }),
    (err) => err.code === 'LEDGER_FULL' && err.maxChars === 200 && err.usedChars > 200
  );
  assert.ok((await mem.readLedger({ agentId: 'opencode' })).usedChars <= 200);

  const star = await mem.patchLedger({ agentId: 'opencode', mode: 'replace', oldText: '*', newText: 'final\n' });
  assert.equal(star.content, 'final\n');
  assert.equal(star.usedChars, 6);

  const cleared = await mem.patchLedger({ agentId: 'opencode', mode: 'replace', newText: '' });
  assert.equal(cleared.content, '');
  assert.equal(cleared.exists, true);
  assert.equal(cleared.usedChars, 0);
  assert.equal(cleared.remainingChars, 200);
});

test('readRef resolves ref:guide, ref:seed, and bot:<agentId> ledgers', async (t) => {
  const { mem } = await fixture(t);

  const guide = await mem.readRef('ref:guide');
  assert.equal(guide.type, 'guide');
  assert.equal(guide.ref, 'ref:guide');
  assert.equal(guide.exists, true);
  assert.equal(guide.available, true);
  assert.match(guide.content, /记忆分层与升格说明书/);
  assert.equal(guide.chars, Array.from(guide.content).length);
  assert.ok(Array.isArray(guide.revisions));
  assert.equal((await mem.readRef('guide')).content, guide.content);

  const seed = await mem.readRef('seed');
  assert.equal(seed.type, 'seed');
  assert.equal(seed.ref, 'ref:seed');
  assert.equal(seed.exists, true);
  assert.equal(seed.source, 'authority');
  assert.equal(seed.title, 'SEED-TAIL-PROACTIVE-GITMEM.md');
  assert.match(seed.content, /主动性与冰山记账/);
  assert.equal((await mem.readRef('ref:seed')).content, seed.content);

  const missing = await mem.readRef('bot:new-window');
  assert.equal(missing.type, 'bot');
  assert.equal(missing.exists, false);
  assert.equal(missing.path, 'bots/new-window/记忆库.md');
  assert.equal(missing.revision, computeRevision(''));
  assert.equal(missing.ledger, true);

  const written = await mem.patchLedger({ agentId: 'new-window', mode: 'append', newText: '- 窗口专属线索' });
  const bot = await mem.readRef('bot:new-window');
  assert.equal(bot.exists, true);
  assert.equal(bot.content, written.content);
  assert.equal(bot.revision, written.revision);
  assert.equal(bot.maxChars, 8000);
  assert.equal(bot.remainingChars, 8000 - written.usedChars);
  assert.equal(bot.entryName, '记忆库.md');
  assert.equal((await mem.readRef('bot:new-window/记忆库.md')).content, bot.content);
  assert.equal((await mem.readRef('[bot:new-window]')).agentId, 'new-window');

  const otherEntry = await mem.readRef('bot:new-window/notes.md');
  assert.equal(otherEntry.exists, false);
  assert.equal(otherEntry.entryName, 'notes.md');
  assert.equal(otherEntry.path, 'bots/new-window/notes.md');

  await assert.rejects(mem.readRef('bot:new-window/../TINA_SELF.md'), { code: 'INVALID_ENTRY' });
  await assert.rejects(mem.readRef('bot:new-window/..'), { code: 'INVALID_ENTRY' });
  await assert.rejects(mem.readRef('bot:new-window', { rev: '--upload-pack=x' }), { code: 'INVALID_REV' });
});

test('getSystemBlock composes seed, guide, canvas, window ledger, and recent pulse in order', async (t) => {
  const { mem } = await fixture(t);
  await mem.ingestSource({
    sourceId: 'other-window-src',
    agentId: 'other',
    channel: 'dsh',
    sessionId: 's9',
    content: '另一窗口最近完成了检索测试 SENTINEL_PULSE',
    createdAt: new Date().toISOString(),
  });
  const ledger = await mem.patchLedger({ agentId: 'dsh', mode: 'append', newText: '- SENTINEL_LEDGER 结论' });

  const block = await mem.getSystemBlock({
    sessionId: 'win-1',
    agentId: 'dsh',
    includeSeed: true,
    includeGuide: true,
    includeLedger: true,
  });
  assert.deepEqual(block.include, { seed: true, guide: true, ledger: true });
  assert.equal(block.seed.exists, true);
  assert.equal(block.seed.source, 'authority');
  assert.equal(block.guide.available, true);
  assert.equal(block.ledger.content, ledger.content);
  assert.equal(block.ledger.revision, ledger.revision);
  assert.equal(block.ledger.path, 'bots/dsh/记忆库.md');
  assert.equal(block.window.ledgerAgentId, 'dsh');

  const order = [
    '## 人格与关系种子',
    '## 记忆库使用指南（简明）',
    '# 我（Tina）的自我与记忆画布',
    `## 本窗口任务小账本（${ledger.path}`,
    '## 跨窗口近期余光',
  ];
  const positions = order.map((needle) => block.text.indexOf(needle));
  assert.ok(positions.every((position) => position >= 0), `missing section: ${JSON.stringify(positions)}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);

  assert.match(block.text, /SENTINEL_LEDGER/);
  assert.match(block.text, /SENTINEL_PULSE/);
  assert.match(block.text, /ref:guide/);
  assert.match(block.text, /mem_ledger/);
  assert.match(block.text, /<!-- window=dsh /);
  assert.match(block.text, new RegExp(`ledger=${ledger.usedChars}/8000`));
  assert.ok(block.text.indexOf('SENTINEL_LEDGER') < block.text.indexOf('SENTINEL_PULSE'));

  // Requesting no extensions keeps the historical block shape.
  const plain = await mem.getSystemBlock({ sessionId: 'win-2', agentId: 'dsh' });
  assert.deepEqual(plain.include, { seed: false, guide: false, ledger: false });
  assert.equal(plain.ledger, undefined);
  assert.equal(plain.guide, undefined);
  assert.equal(plain.seed, undefined);
  assert.equal(plain.text.includes('记忆库使用指南（简明）'), false);
  assert.equal(plain.text.includes('## 本窗口任务小账本'), false);
  assert.equal(plain.text.includes('## 人格与关系种子'), false);

  // A window without a ledger gets an actionable empty-ledger prompt instead of an empty section.
  const emptyLedger = await mem.getSystemBlock({ sessionId: 'win-3', agentId: 'fresh-window', includeLedger: true });
  assert.equal(emptyLedger.ledger.exists, false);
  assert.match(emptyLedger.text, /本窗口小账本尚为空/);
  assert.match(emptyLedger.text, /mem_ledger/);
  assert.match(emptyLedger.text, /bots\/fresh-window\/记忆库\.md/);

  // The snapshot cache key includes the extension flags and the ledger target.
  const withoutLedger = await mem.getSystemBlock({ sessionId: 'win-4', agentId: 'dsh', includeLedger: false });
  const withLedger = await mem.getSystemBlock({ sessionId: 'win-4', agentId: 'dsh', includeLedger: true });
  assert.equal(withoutLedger.include.ledger, false);
  assert.equal(withLedger.include.ledger, true);
  assert.match(withLedger.text, /SENTINEL_LEDGER/);
  const tinaLedger = await mem.getSystemBlock({ sessionId: 'win-4', agentId: 'dsh', includeLedger: true, ledgerAgentId: 'tina' });
  assert.equal(tinaLedger.ledger.path, 'bots/tina/记忆库.md');
  assert.notEqual(tinaLedger.text, withLedger.text);

  // Frames are frozen per session until an explicit refresh.
  const frozen = await mem.getSystemBlock({ sessionId: 'win-5', agentId: 'dsh', includeLedger: true });
  await mem.patchLedger({ agentId: 'dsh', mode: 'append', newText: '- SENTINEL_REFRESH 新结论' });
  const stillFrozen = await mem.getSystemBlock({ sessionId: 'win-5', agentId: 'dsh', includeLedger: true });
  assert.equal(stillFrozen.text.includes('SENTINEL_REFRESH'), false);
  const refreshed = await mem.refreshSession('win-5', { agentId: 'dsh', includeLedger: true, includeGuide: true });
  assert.match(refreshed.text, /SENTINEL_REFRESH/);
  assert.equal(refreshed.include.guide, true);
  assert.ok(frozen.capturedAt <= refreshed.capturedAt);
});

test('instance configuration can enable seed, guide, and ledger by default', async (t) => {
  const { mem } = await fixture(t, { agentId: 'dsh', includeSeed: true, includeGuide: true, includeLedger: true });

  const block = await mem.getSystemBlock({ sessionId: 'defaults-1' });
  assert.deepEqual(block.include, { seed: true, guide: true, ledger: true });
  assert.match(block.text, /## 人格与关系种子/);
  assert.match(block.text, /## 记忆库使用指南（简明）/);
  assert.match(block.text, /## 本窗口任务小账本（bots\/tina\/记忆库\.md/);
  assert.equal(block.ledger.path, 'bots/tina/记忆库.md');

  const off = await mem.getSystemBlock({
    sessionId: 'defaults-2',
    includeSeed: false,
    includeGuide: false,
    includeLedger: false,
  });
  assert.deepEqual(off.include, { seed: false, guide: false, ledger: false });
  assert.equal(off.text.includes('## 人格与关系种子'), false);

  const instanceScope = await mem.readLedger();
  assert.equal(instanceScope.agentId, 'dsh');
});

test('toolkit exposes mem_ledger and documents guide/seed/bot refs on mem_read', async (t) => {
  const { mem } = await fixture(t);
  const toolkit = createSelfMemToolkit(mem, { agentId: 'dsh' });
  const names = toolkit.declarations.map((declaration) => declaration.name);
  assert.ok(names.includes('mem_ledger'));
  assert.ok(names.includes('mem_read'));

  const ledgerTool = toolkit.declarations.find((declaration) => declaration.name === 'mem_ledger');
  assert.deepEqual(ledgerTool.parameters.properties.action.enum, ['read', 'replace', 'append']);
  assert.ok(ledgerTool.parameters.required.includes('action'));

  const readTool = toolkit.declarations.find((declaration) => declaration.name === 'mem_read');
  for (const needle of ['ref:guide', 'ref:seed', 'bot:<agentId>']) {
    assert.ok(readTool.description.includes(needle), `description misses ${needle}`);
    assert.ok(readTool.parameters.properties.ref.description.includes(needle), `ref description misses ${needle}`);
  }

  const fresh = await toolkit.call('mem_ledger', { action: 'read' });
  assert.equal(fresh.agentId, 'dsh');
  assert.equal(fresh.exists, false);

  const appended = await toolkit.call('mem_ledger', {
    action: 'append',
    newText: '- token: TOOL_LEDGER',
    summary: 'tool append',
  });
  assert.equal(appended.changed, true);
  assert.equal(appended.reason, 'mem_ledger_tool');
  assert.equal(appended.summary, 'tool append');

  const replaced = await toolkit.call('mem_ledger', {
    action: 'replace',
    oldText: 'TOOL_LEDGER',
    newText: 'TOOL_LEDGER_V2',
  });
  assert.match(replaced.content, /TOOL_LEDGER_V2/);

  const readBack = await toolkit.call('mem_ledger', { action: 'read', agentId: 'dsh' });
  assert.match(readBack.content, /TOOL_LEDGER_V2/);

  await assert.rejects(toolkit.call('mem_ledger', { action: 'merge' }), { code: 'INVALID_ACTION' });
  await assert.rejects(toolkit.call('nope'), { code: 'UNKNOWN_TOOL' });

  const botRead = await toolkit.call('mem_read', { ref: 'bot:dsh' });
  assert.match(botRead.content, /TOOL_LEDGER_V2/);
  assert.equal((await toolkit.call('mem_read', { ref: 'ref:guide' })).type, 'guide');
  assert.equal((await toolkit.call('mem_read', { ref: 'ref:seed' })).type, 'seed');
});

test('HTTP /api/ledger and /api/system-block expose the window ledger', async (t) => {
  const { mem } = await fixture(t);
  const srv = createSelfMemHttpServer({ mem, token: '' });
  t.after(async () => { await srv.close(); });
  const info = await srv.listen(0, '127.0.0.1');
  const asJson = async (path, init) => {
    const response = await fetch(`${info.url}${path}`, init);
    return { status: response.status, body: await response.json() };
  };
  const post = (path, body) => asJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const empty = await asJson('/api/ledger?agentId=http-dsh');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.agentId, 'http-dsh');
  assert.equal(empty.body.exists, false);
  assert.equal(empty.body.maxChars, 8000);

  const appended = await post('/api/ledger', {
    agentId: 'http-dsh',
    action: 'append',
    newText: '- HTTP_LEDGER 线索',
    summary: 'http append',
  });
  assert.equal(appended.status, 200);
  assert.equal(appended.body.changed, true);
  assert.equal(appended.body.summary, 'http append');
  assert.match(appended.body.commit, /^[0-9a-f]{12}$/);

  const read = await asJson('/api/ledger?agentId=http-dsh');
  assert.match(read.body.content, /HTTP_LEDGER/);

  const replaced = await post('/api/ledger', {
    agentId: 'http-dsh',
    mode: 'replace',
    oldText: 'HTTP_LEDGER',
    newText: 'HTTP_LEDGER_V2',
    expectedRevision: read.body.revision,
  });
  assert.equal(replaced.status, 200);
  assert.match(replaced.body.content, /HTTP_LEDGER_V2/);

  const conflict = await post('/api/ledger', {
    agentId: 'http-dsh',
    action: 'append',
    newText: '- 冲突',
    expectedRevision: 'stale',
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'LEDGER_REVISION_CONFLICT');

  const invalid = await post('/api/ledger', { agentId: 'http-dsh', action: 'merge', newText: '- x' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'INVALID_ACTION');

  const block = await asJson('/api/system-block?agentId=http-dsh&includeSeed=1&includeGuide=1&includeLedger=1&ledgerAgentId=http-dsh');
  assert.equal(block.status, 200);
  assert.match(block.body.text, /## 人格与关系种子/);
  assert.match(block.body.text, /## 记忆库使用指南（简明）/);
  assert.match(block.body.text, /HTTP_LEDGER_V2/);
  assert.equal(block.body.include.ledger, true);
  assert.equal(block.body.guide.available, true);
  assert.match(block.body.ledger.content, /HTTP_LEDGER_V2/);

  // The dedicated /api endpoint enables guide + ledger when no flags are given.
  const defaults = await asJson('/api/system-block?agentId=http-dsh&ledgerAgentId=http-dsh');
  assert.match(defaults.body.text, /记忆库使用指南（简明）/);
  assert.match(defaults.body.text, /HTTP_LEDGER_V2/);

  const disabled = await asJson('/api/system-block?agentId=http-dsh&includeLedger=0&includeGuide=0');
  assert.equal(disabled.body.include.ledger, false);
  assert.equal(disabled.body.text.includes('HTTP_LEDGER_V2'), false);

  // Legacy /v1 routes keep working and accept the new query flags.
  const legacy = await asJson('/v1/self?agentId=http-dsh&includeLedger=1&ledgerAgentId=http-dsh');
  assert.match(legacy.body.text, /HTTP_LEDGER_V2/);
  const legacyLedger = await asJson('/v1/ledger?agentId=http-dsh');
  assert.match(legacyLedger.body.content, /HTTP_LEDGER_V2/);

  const actionRead = await post('/api/ledger', { agentId: 'http-dsh', action: 'read' });
  assert.match(actionRead.body.content, /HTTP_LEDGER_V2/);

  // Remote client (used by MCP --remote-url) supports the same surface.
  const remote = new RemoteTinaSelfMemClient({ baseUrl: info.url });
  assert.equal((await remote.readLedger({ agentId: 'remote-dsh' })).exists, false);
  assert.equal((await remote.patchLedger({ agentId: 'remote-dsh', mode: 'append', newText: '- REMOTE_LEDGER' })).changed, true);
  const remoteBlock = await remote.getSystemBlock({
    agentId: 'remote-dsh',
    sessionId: 'remote-1',
    includeLedger: true,
    includeGuide: true,
    ledgerAgentId: 'remote-dsh',
  });
  assert.match(remoteBlock.text, /REMOTE_LEDGER/);
});

function startMcpServer(t, dir, agent) {
  const child = spawn(process.execPath, [MCP_PATH, '--dir', dir, '--agent', agent], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  const stderr = [];
  let buffer = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`MCP request timed out: ${method}\n${stderr.join('')}`));
    }, 20000);
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  t.after(async () => {
    child.stdin.end();
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) { resolveExit(); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    });
  });

  return { child, request, stderr };
}

test('MCP exposes mem_ledger and includes ledger + guide for external clients', async (t) => {
  assert.equal(pkg.version, '0.4.6-fusion.next.1');
  const root = mkdtempSync(join(tmpdir(), 'tina-mcp-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const mcp = startMcpServer(t, join(root, 'data'), 'mcp-dsh');

  const init = await mcp.request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.result.serverInfo.name, 'tina-self-mem');
  assert.equal(init.result.serverInfo.version, pkg.version);
  assert.match(init.result.instructions, /## 记忆库使用指南（简明）/);
  assert.match(init.result.instructions, /## 本窗口任务小账本（bots\/mcp-dsh\/记忆库\.md/);
  assert.doesNotMatch(init.result.instructions, /## 人格与关系种子/);

  const list = await mcp.request('tools/list');
  const names = list.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('mem_ledger'));
  const ledgerTool = list.result.tools.find((tool) => tool.name === 'mem_ledger');
  assert.deepEqual(ledgerTool.inputSchema.properties.action.enum, ['read', 'replace', 'append']);

  const appended = await mcp.request('tools/call', {
    name: 'mem_ledger',
    arguments: { action: 'append', newText: '- MCP_LEDGER 结论', summary: 'mcp append' },
  });
  assert.equal(appended.result.isError, false);
  const appendedBody = JSON.parse(appended.result.content[0].text);
  assert.equal(appendedBody.changed, true);
  assert.match(appendedBody.content, /MCP_LEDGER/);

  const read = await mcp.request('tools/call', { name: 'mem_ledger', arguments: { action: 'read' } });
  const readBody = JSON.parse(read.result.content[0].text);
  assert.match(readBody.content, /MCP_LEDGER/);

  const started = await mcp.request('session_start', { sessionId: 'mcp-test-session', includeSeed: true });
  assert.deepEqual(started.result.include, { seed: true, guide: true, ledger: true });
  assert.match(started.result.ledger.content, /MCP_LEDGER/);
  assert.equal(started.result.guide.available, true);
  assert.equal(started.result.seed.exists, true);
  assert.match(started.result.text, /## 人格与关系种子/);
  assert.match(started.result.text, /MCP_LEDGER/);

  const bot = await mcp.request('tools/call', { name: 'mem_read', arguments: { ref: 'bot:mcp-dsh' } });
  assert.match(JSON.parse(bot.result.content[0].text).content, /MCP_LEDGER/);

  const guide = await mcp.request('tools/call', { name: 'mem_read', arguments: { ref: 'ref:guide' } });
  assert.equal(JSON.parse(guide.result.content[0].text).type, 'guide');

  const unknown = await mcp.request('tools/call', { name: 'mem_ledger', arguments: { action: 'merge' } });
  assert.equal(unknown.result.isError, true);
  assert.equal(JSON.parse(unknown.result.content[0].text).error, 'INVALID_ACTION');
});

test('stable L0 getSystemBlock and dynamic L2 getTailBlock separate prefix from volatile tail', async (t) => {
  const { mem } = await fixture(t);

  const l0Before = await mem.getSystemBlock({
    sessionId: 'main:0',
    agentId: 'tina-main',
    includePulse: false,
    includeFooter: false,
    includeLedger: false,
  });
  assert.equal(typeof l0Before.bodyRevision, 'string');
  assert.equal(l0Before.bodyRevision.length, 16);
  assert.doesNotMatch(l0Before.text, /跨窗口近期余光/);
  assert.doesNotMatch(l0Before.text, /<!-- window=/);

  const tail1 = await mem.getTailBlock({
    agentId: 'tina-main',
    sourceSessionId: 'main',
    includePulse: true,
    includeFooter: true,
    includeLedger: true,
  });
  assert.equal(tail1.bodyRevision, l0Before.bodyRevision);
  assert.match(tail1.text, /<!-- window=tina-main /);

  // Ingesting another window's turn and updating ledger mutates the tail digest,
  // while the L0 system block text and bodyRevision remain byte-identical.
  await mem.ingestSource({
    sourceId: 'other-turn-1',
    agentId: 'dsh-worker',
    channel: 'dsh',
    sessionId: 's-other',
    content: '跨窗口新进展 TAIL_PULSE_SENTINEL',
    createdAt: new Date().toISOString(),
  });
  await mem.patchLedger({
    agentId: 'tina-main',
    mode: 'append',
    newText: '- TAIL_LEDGER_SENTINEL 窗口进展',
  });

  const l0After = await mem.getSystemBlock({
    sessionId: 'main:1',
    agentId: 'tina-main',
    includePulse: false,
    includeFooter: false,
    includeLedger: false,
    forceRefresh: true,
  });
  assert.equal(l0After.text, l0Before.text);
  assert.equal(l0After.bodyRevision, l0Before.bodyRevision);

  const tail2 = await mem.getTailBlock({
    agentId: 'tina-main',
    sourceSessionId: 'main',
    includePulse: true,
    includeFooter: true,
    includeLedger: true,
  });
  assert.notEqual(tail2.digest, tail1.digest);
  assert.match(tail2.text, /TAIL_PULSE_SENTINEL/);
  assert.match(tail2.text, /TAIL_LEDGER_SENTINEL/);
  assert.match(tail2.text, /ledger=\d+\/8000/);

  // Calling getTailBlock again without state changes produces the exact same digest.
  const tail3 = await mem.getTailBlock({
    agentId: 'tina-main',
    sourceSessionId: 'main',
    includePulse: true,
    includeFooter: true,
    includeLedger: true,
  });
  assert.equal(tail3.digest, tail2.digest);
});

test('collectSessionLogs ingests OpenCode SQLite v1 (message/part) and v2 (session_message) incrementally', async (t) => {
  const { root, mem } = await fixture(t);
  const ocDir = join(root, 'opencode-data');
  rmSync(ocDir, { recursive: true, force: true });
  const dbPath = join(ocDir, 'opencode.db');
  spawnSync('mkdir', ['-p', ocDir]);

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  // Insert v1 user + assistant rows
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    'msg_v1_user',
    'ses_v1',
    1700000001000,
    1700000001000,
    JSON.stringify({ role: 'user', time: { created: 1700000001000 } })
  );
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt_v1_user',
    'msg_v1_user',
    'ses_v1',
    1700000001000,
    1700000001000,
    JSON.stringify({ type: 'text', text: 'OPENCODE_V1_USER_QUERY' })
  );
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    'msg_v1_asst',
    'ses_v1',
    1700000002000,
    1700000002000,
    JSON.stringify({ role: 'assistant', time: { created: 1700000002000 } })
  );
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt_v1_asst_r',
    'msg_v1_asst',
    'ses_v1',
    1700000002000,
    1700000002000,
    JSON.stringify({ type: 'reasoning', text: 'OPENCODE_V1_REASONING' })
  );
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt_v1_asst_t',
    'msg_v1_asst',
    'ses_v1',
    1700000002001,
    1700000002001,
    JSON.stringify({ type: 'text', text: 'OPENCODE_V1_ASSISTANT_REPLY' })
  );

  // Insert v2 user + assistant rows
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'msg_v2_user',
    'ses_v2',
    'user',
    1,
    1700000003000,
    1700000003000,
    JSON.stringify({ time: { created: 1700000003000 }, text: 'OPENCODE_V2_USER_QUERY' })
  );
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'msg_v2_asst',
    'ses_v2',
    'assistant',
    2,
    1700000004000,
    1700000004000,
    JSON.stringify({
      time: { created: 1700000004000 },
      content: [
        { type: 'reasoning', text: 'OPENCODE_V2_REASONING' },
        { type: 'text', text: 'OPENCODE_V2_ASSISTANT_REPLY' },
      ],
    })
  );
  db.close();

  const pass1 = await collectSessionLogs({
    mem,
    sessionsRoot: ocDir,
    agentId: 'opencode-test',
    originDeviceId: 'test-device',
    format: 'opencode',
  });
  assert.equal(pass1.errors.length, 0);
  assert.equal(pass1.sourcesIngested, 4);
  assert.equal(pass1.messagesIngested, 4);

  // Second pass without new rows should ingest 0
  const pass2 = await collectSessionLogs({
    mem,
    sessionsRoot: ocDir,
    agentId: 'opencode-test',
    originDeviceId: 'test-device',
    format: 'opencode',
  });
  assert.equal(pass2.sourcesIngested, 0);
  assert.equal(pass2.readLines, 0);

  // Search both v1 and v2 ingested messages
  const s1 = await mem.search({ query: 'OPENCODE_V1_ASSISTANT_REPLY', scope: 'raw' });
  assert.equal(s1.hits.length, 1);
  const r1 = await mem.readRef(s1.hits[0].ref, { includeNeighbors: 0, includeReasoning: true });
  assert.match(r1.content, /OPENCODE_V1_ASSISTANT_REPLY/);
  assert.match(r1.reasoning, /OPENCODE_V1_REASONING/);

  const s2 = await mem.search({ query: 'OPENCODE_V2_ASSISTANT_REPLY', scope: 'raw' });
  assert.equal(s2.hits.length, 1);
  const r2 = await mem.readRef(s2.hits[0].ref, { includeNeighbors: 0, includeReasoning: true });
  assert.match(r2.content, /OPENCODE_V2_ASSISTANT_REPLY/);
  assert.match(r2.reasoning, /OPENCODE_V2_REASONING/);
});
