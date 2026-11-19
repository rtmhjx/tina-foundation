/** Existing-session deployment acceptance. Default is a plan; never restarts a service.
 * Run on the server as its service owner. Raw journals are decoded only in private,
 * disposable copies; reports contain this run's markers and metadata, not history.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';
import { nativeFileReadEvidence } from './lib/native-file-read-evidence.mjs';
export { nativeFileReadEvidence } from './lib/native-file-read-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const serverAcceptanceRoutes = Object.freeze({
  console: '/ws/providers/' + encodeURIComponent('world:console') + '/panels/chat?lang=zh',
  engine: '/api/webui/providers/' + encodeURIComponent('world:native-engine') + '/panels/engine/',
});
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const within = (base, path) => { const part = relative(base, path); return part !== '' && !part.startsWith('..') && !isAbsolute(part); };
const exists = path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const headerRoute = event => pick(event?.data?.header?.config, ['provider', 'model', 'reasoningEffort']);
const usageFacts = value => value ? pick(value, ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) : null;
const selectionFacts = status => ({ ...pick(status, ['provider', 'providerName', 'model', 'reasoningEffort', 'mode', 'state']),
  nativeSelection: pick(status.nativeSelection, ['provider', 'model', 'reasoningEffort', 'source']),
  lastRequestSelection: pick(status.lastRequestSelection, ['provider', 'model', 'reasoningEffort', 'nativeSeq', 'basis']) });

export function parseServerAcceptanceArgs(args) {
  const value = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
  const state = value('--state');
  if (!state || !isAbsolute(state)) fail('ACCEPTANCE_EXPLICIT_ABSOLUTE_STATE_REQUIRED');
  const phase = value('--phase');
  if (!['before', 'after-restart'].includes(phase)) fail('ACCEPTANCE_INVALID_PHASE');
  const origin = new URL(value('--origin') ?? 'http://127.0.0.1:7789');
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) fail('ACCEPTANCE_LOOPBACK_ORIGIN_REQUIRED');
  const reportDir = resolve(value('--report-dir') ?? join(state, 'server-upgrade-acceptance'));
  const runtime = resolve(value('--runtime') ?? join(root, 'runtime/dsh-0.1.5-rc.2'));
  return { execute: args.includes('--execute'), state: resolve(state), phase, origin: origin.origin, reportDir, runtime,
    service: value('--service') ?? 'cortico-tina-main.service', model: 'gpt-6-astra', effort: 'max' };
}

export function acceptancePlan(options) {
  return { execute: false, ...options, tests: options.phase === 'before' ? ['chat', 'rp', 'native-read', 'deferred-file-task'] : ['same-session', 'actual-process-restart', 'retained-context-file-task', 'native-readback'],
    mutations: ['Resume/pause existing bot through run API', 'Temporarily select companion/rp/work mode and restore prior mode',
      'Console World messages containing this run marker', 'New uniquely named test directory and files only'],
    serviceRestart: 'Not performed; root operator executes systemctl between phases',
    privateHistory: 'Never included in reports; strict native reader uses a private temporary byte-identical copy',
    evidence: 'Native persisted request configuration and provider attempt receipts; no server HTTP interception or upstream identity claim',
    waitPolicy: 'Natural turn completion, with no runner model-turn or wall-time limit. Natural errors fail explicitly.' };
}

export async function serverProcessIdentity(options) {
  if (process.platform !== 'linux' || !/^[\w@.-]+\.service$/.test(options.service)) fail('ACCEPTANCE_LINUX_USER_SERVICE_REQUIRED');
  const { stdout } = await promisify(execFile)('systemctl', ['--user', 'show', options.service,
    '--property=MainPID,InvocationID,ActiveState'], { encoding: 'utf8', windowsHide: true });
  const data = Object.fromEntries(stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const pid = Number(data.MainPID);
  if (!Number.isSafeInteger(pid) || pid < 1 || data.ActiveState !== 'active' || !data.InvocationID) fail('ACCEPTANCE_SERVICE_NOT_ACTIVE');
  const proc = join('/proc', String(pid));
  const env = (await readFile(join(proc, 'environ'))).toString().split('\0');
  const state = env.find(item => item.startsWith('CORTICO_FUSION_STATE='))?.slice('CORTICO_FUSION_STATE='.length);
  if (!state || await realpath(state) !== await realpath(options.state)) fail('ACCEPTANCE_PROCESS_STATE_MISMATCH');
  const status = await readFile(join(proc, 'stat'), 'utf8');
  const startTicks = status.slice(status.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(startTicks)) fail('ACCEPTANCE_PROCESS_START_UNKNOWN');
  return { service: options.service, pid, invocationId: data.InvocationID, startTicks,
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() };
}

export function assertRestart(before, after) {
  assert.equal(after.service, before.service);
  assert.notEqual(after.invocationId, before.invocationId, 'Service invocation must change across the operator restart');
  assert.ok(after.bootId !== before.bootId || after.pid !== before.pid || after.startTicks !== before.startTicks,
    'A new service process must be observed, not merely a state label change');
}

async function locateJournal(options, sessionId) {
  const sessions = join(options.state, 'native/dsh-embedded/home/sessions');
  const matches = [];
  for (const workspace of await readdir(sessions, { withFileTypes: true })) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) continue;
    for (const name of ['session.v3.jsonl.zstd', 'session.v3.jsonl']) {
      const path = join(sessions, workspace.name, sessionId, name);
      if (await exists(path)) {
        const actual = await realpath(path);
        if (!within(await realpath(sessions), actual)) fail('ACCEPTANCE_JOURNAL_PATH_ESCAPE');
        matches.push(actual);
      }
    }
  }
  if (matches.length !== 1) fail('ACCEPTANCE_NATIVE_JOURNAL_NOT_UNIQUE');
  return matches[0];
}

/** No backend is ever attached to the live persistence root. */
export async function strictJournalCopy({ journal, runtime, privateDir, sessionId }) {
  const scratch = await mkdtemp(join(privateDir, 'native-copy-'));
  const bytes = await readFile(journal);
  const beforeHash = hash(bytes);
  let mounted;
  try {
    const require = createRequire(join(runtime, 'package.json'));
    const load = name => import(pathToFileURL(require.resolve(name)).href);
    const [{ Context }, { default: Backend }] = await Promise.all([load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-session-persistence-jsonl')]);
    const prefix = journal.endsWith('.zstd') ? zstdDecompressSync(bytes) : bytes;
    const newline = prefix.indexOf(10);
    if (newline < 0) fail('ACCEPTANCE_NATIVE_HEADER_INCOMPLETE');
    const header = JSON.parse(prefix.subarray(0, newline).toString('utf8'));
    if (header.type !== 'session' || header.id !== sessionId) fail('ACCEPTANCE_SESSION_MISMATCH');
    const ctx = new Context();
    mounted = ctx.plugin(Backend, { root: scratch, compression: journal.endsWith('.zstd') ? 'zstd' : 'none' });
    await mounted.await();
    const copy = ctx.sessionPersistence.locate(header).path;
    await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
    await writeFile(copy, bytes, { flag: 'wx', mode: 0o600 });
    const stored = await ctx.sessionPersistence.readStoredLog(copy, sessionId);
    if (stored.tornTruncateTo !== undefined || stored.recoveredTail.length) fail('ACCEPTANCE_NATIVE_TORN_SNAPSHOT');
    if (hash(await readFile(copy)) !== beforeHash) fail('ACCEPTANCE_COPY_CHANGED');
    // Live append during a copy is not a stable checkpoint. Never repair it.
    if (hash(await readFile(journal)) !== beforeHash) fail('ACCEPTANCE_NATIVE_SNAPSHOT_CHANGED');
    return { events: stored.events, sessionId, journalSha256: beforeHash, bytes: bytes.length,
      eventCount: stored.events.length, eventsSha256: hash(JSON.stringify(stored.events)),
      completeFrames: true, repaired: false };
  } finally {
    await mounted?.dispose();
    // Only the exact newly-created private copy is removed, never a live path.
    assert.equal(dirname(scratch), resolve(privateDir));
    await rm(scratch, { recursive: true, force: true });
  }
}

export function prefixReceipt(snapshot) {
  return { sessionId: snapshot.sessionId, eventCount: snapshot.events.length,
    eventsSha256: hash(JSON.stringify(snapshot.events)), journalSha256: snapshot.journalSha256 };
}
export function assertPrefix(checkpoint, snapshot) {
  assert.equal(snapshot.sessionId, checkpoint.sessionId, 'Existing native session identity must be retained');
  assert.ok(snapshot.events.length >= checkpoint.eventCount, 'Historical native events must not disappear');
  assert.equal(hash(JSON.stringify(snapshot.events.slice(0, checkpoint.eventCount))), checkpoint.eventsSha256,
    'Historical native event prefix must remain unchanged');
}

export function promptFor(name, checkpoint, marker) {
  const scope = '本次只向 World 控制台发言，不向其他 World 或外部联系人发送消息；不要改已有文件。';
  const prompts = {
    chat: `这是现有 Tina 升级后的聊天测试。只供本次测试的约定：我的饮品偏好是${checkpoint.preference}，实验代号是${checkpoint.projectCode}。你好 Tina，今天你想怎样安排一个安静的下午？请自然回答，通过控制台发出来，末尾附上 ${marker}。${scope}`,
    rp: `做一小段明确虚构的 RP：雨夜旧书店，你是守店人，我推门问“这里还有茶吗？”请以角色口吻包含一个动作和一句回答，通过控制台发出来，末尾附上 ${marker}。临时场景不用写长期记忆。${scope}`,
    read: `请用 DSH 原生 read 工具（file_path 参数）实际读取 ${checkpoint.inputFile}，将 verification_code 完整值通过控制台告诉我，末尾附上 ${marker}。码没有写在这条消息里。另外保留一项待办：等我说“继续升级验收的文件任务”时，在同一全新测试目录新建 ${checkpoint.outputFile}，仅写三行 preference=先前饮品偏好、project_code=先前实验代号、verification_code=本次读到的完整码，并用原生 read 工具实际回读核对。现在不要创建输出文件，请保留约定供重启后续行。不要使用 shell 打印替代文件读取。${scope}`,
    restart: `继续升级验收的文件任务。请从保留的上下文或记忆找回之前的待办及三个值，完成新文件并用 DSH 原生 read 工具（file_path 参数）实际回读核对，再通过控制台报告，末尾附上 ${marker}。本条不重新提供代号、随机码、偏好或文件名。不要使用 shell 打印替代文件读取。${scope}`,
  };
  return prompts[name];
}

/** Select the marker's native turn, returning only structured facts and booleans. */
export function phaseEvidence(events, { marker, startSeq, code, expectedFile, expectedRoute, cwd }) {
  let currentTurn, markedTurn, inputSeq;
  const routes = new Map();
  let route = {};
  for (const event of events) {
    if (event.type === 'request/header') route = headerRoute(event);
    if (event.type === 'turn/start') currentTurn = event.data.turn;
    routes.set(event.seq, route);
    if (event.seq > startSeq && event.type === 'user/message' && event.data.source?.kind === 'plugin'
      && event.data.source.plugin === 'tina-cortico-world/console'
      && event.data.content?.some(block => block.type === 'text' && block.text.includes(marker))) {
      markedTurn ??= currentTurn; inputSeq ??= event.seq;
    }
  }
  if (markedTurn === undefined) {
    const failure = events.find(event => event.seq > startSeq && event.type === 'turn/end' && event.data.reason?.kind !== 'completed');
    if (failure) return { ready: true, inputSeq: null, endSeq: failure.seq, ending: failure.data.reason?.kind ?? null,
      attempts: [], tools: [], childTools: [], checks: { inputPresented: false, nativeTurnCompleted: false } };
    return { ready: false };
  }
  const end = events.find(event => event.seq >= inputSeq && event.type === 'turn/end' && event.data.turn === markedTurn);
  if (!end) return { ready: false };
  const selected = events.filter(event => event.seq >= inputSeq && event.seq <= end.seq);
  const terminals = selected.filter(event => ['assistant/message', 'assistant/attempt'].includes(event.type));
  const attempts = terminals.map(event => {
    const finish = event.data.stream?.findLast(item => item.type === 'chunk' && item.chunk.type === 'finish')?.chunk;
    const receipt = finish?.replayState?.response ?? event.data.replayState?.response ?? event.data.message?.source?.replayState?.response;
    return { seq: event.seq, turn: event.data.turn, step: event.data.step, eventType: event.type,
      requestConfiguration: routes.get(event.seq), finish: finish?.reason?.kind ?? null,
      usage: usageFacts(event.data.usage), providerResponseId: receipt?.responseId ?? null,
      providerAttempts: (receipt?.attempts ?? []).map(row => ({ ...pick(row, ['id', 'ordinal', 'purpose', 'outcome', 'elapsedMs', 'requestId', 'responseId', 'status']),
        origin: pick(row.origin, ['instance', 'module', 'model']),
        meters: pick(row.meters, ['input', 'output', 'total', 'cachedInput', 'uncachedInput', 'reasoning']) })) };
  });
  const tools = selected.filter(event => event.type === 'tool/call').map(event => ({ seq: event.seq, name: event.data.name, callId: event.data.callId }));
  const childTools = selected.filter(event => event.type === 'tool/ptc-dispatch').map(event => ({ seq: event.seq, name: event.data.toolName ?? event.data.name, callId: event.data.subCallId }));
  const foreignWorldActions = [...tools, ...childTools].filter(row => typeof row.name === 'string' && row.name.startsWith('cortico_')
    && !row.name.startsWith('cortico_console_console_send_') && !['cortico_world_events', 'cortico_world_read', 'cortico_world_blob'].includes(row.name));
  return { ready: true, turn: markedTurn, inputSeq, endSeq: end.seq, ending: end.data.reason?.kind ?? null,
    attempts, tools, childTools, actualReadCode: expectedFile ? nativeFileReadEvidence(selected, expectedFile, [code], { cwd }) : false,
    checks: { nativeTurnCompleted: end.data.reason?.kind === 'completed', durableModelCompletion: attempts.some(row => ['stop', 'tool-calls'].includes(row.finish)),
      exactNativeRequestConfiguration: attempts.length > 0 && attempts.every(row => row.requestConfiguration.provider === expectedRoute.provider
        && row.requestConfiguration.model === expectedRoute.model && row.requestConfiguration.reasoningEffort === expectedRoute.reasoningEffort),
      providerReceiptRecorded: attempts.some(row => row.providerAttempts.some(attempt => attempt.outcome === 'completed')),
      noForeignWorldActions: foreignWorldActions.length === 0 },
    foreignWorldActions };
}

async function connectConsole(options, checkpoint, transport) {
  const socket = new transport.WebSocket(options.origin.replace(/^http/, 'ws') + serverAcceptanceRoutes.console);
  const name = '升级验收-' + checkpoint.nonce.slice(0, 8), messages = [];
  let socketError, open = false, hello = false;
  socket.addEventListener('message', event => {
    let frame; try { frame = JSON.parse(String(event.data)); } catch { socketError = 'ACCEPTANCE_INVALID_FRAME'; return; }
    if (frame.type === 'sys') { hello = true; if (frame.kind === 'rejected') socketError = 'ACCEPTANCE_CONSOLE_REJECTED'; }
    // Drop historical and unrelated private messages immediately, including images.
    if (frame.type === 'msg' && !frame.history && frame.from !== name && typeof frame.text === 'string'
        && frame.text.includes('TINA_UPGRADE_') && frame.text.includes(checkpoint.nonce)) {
      messages.push({ text: frame.text, ts: frame.ts ?? null, receivedAt: new Date().toISOString() });
    }
  });
  socket.addEventListener('error', () => { socketError = 'ACCEPTANCE_CONSOLE_SOCKET_FAILED'; });
  socket.addEventListener('close', () => { if (open) socketError = 'ACCEPTANCE_CONSOLE_CLOSED'; });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  open = true; socket.send(JSON.stringify({ type: 'hello', name }));
  return { messages, ready: () => hello, check() { if (socketError) fail(socketError); },
    send: text => socket.send(JSON.stringify({ type: 'msg', text })), close() { open = false; socket.close(); } };
}

export async function runServerAcceptance(options, adapters = {}) {
  if (!options.execute) return acceptancePlan(options);
  const transport = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, ...adapters };
  if (await realpath(options.state) !== options.state) fail('ACCEPTANCE_REDIRECTED_STATE');
  const sessionId = (await readFile(join(options.state, 'conversation/dsh-session-id'), 'utf8')).trim();
  if (!/^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(sessionId)) fail('ACCEPTANCE_INVALID_SESSION_ID');
  const workspace = await realpath(join(options.state, 'native/dsh-embedded/workspace'));
  if (options.reportDir === workspace || within(workspace, options.reportDir) || within(options.reportDir, workspace)) fail('ACCEPTANCE_REPORT_MUST_BE_OUTSIDE_WORKSPACE');
  const checkpointFile = join(options.reportDir, 'checkpoint.json');
  let checkpoint;
  if (options.phase === 'before') {
    await mkdir(options.reportDir, { mode: 0o700 }); // Deliberately no recursive/existing acceptance reuse.
    const nonce = randomUUID().replaceAll('-', '');
    const directory = join(workspace, 'upgrade-acceptance-' + nonce);
    await mkdir(directory, { mode: 0o700 });
    checkpoint = { version: 1, nonce, sessionId, state: options.state, origin: options.origin, workspace,
      inputFile: join(directory, 'input.txt'), outputFile: join(directory, 'continued.txt'),
      code: randomUUID(), projectCode: '晨星-' + nonce.slice(0, 12), preference: '薄荷茶，不加糖', completed: [] };
    const contents = 'verification_code=' + checkpoint.code + '\n';
    await writeFile(checkpoint.inputFile, contents, { flag: 'wx', mode: 0o600 }); checkpoint.inputSha256 = hash(contents);
  } else {
    checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
    assert.equal(checkpoint.state, options.state); assert.equal(checkpoint.origin, options.origin);
    assert.equal(checkpoint.sessionId, sessionId); assert.equal(checkpoint.workspace, workspace);
    if (!checkpoint.beforePassed || checkpoint.afterPassed) fail('ACCEPTANCE_BEFORE_REQUIRED_OR_ALREADY_COMPLETE');
  }
  const privateDir = join(options.reportDir, '.private-reader');
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const reportFile = join(options.reportDir, options.phase + '.json');
  const report = { version: 1, phase: options.phase, sessionId, startedAt: new Date().toISOString(), passed: false,
    phases: [], privateHistoryExported: false, upstreamIdentityVerified: false,
    evidenceBoundary: 'Persisted native request configuration and provider receipts. The isolated Max runner separately verifies actual HTTP configuration.' };
  const save = async () => { await writeFile(checkpointFile, json(checkpoint), { mode: 0o600 }); await writeFile(reportFile, json(report), { mode: 0o600 }); };
  const api = async (path, body) => {
    const response = await transport.fetch(options.origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: options.origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) fail('ACCEPTANCE_HTTP_' + response.status);
    return response.json();
  };
  const panel = (method, body) => api(serverAcceptanceRoutes.engine + method, body === undefined ? undefined : { args: [body] });
  const identify = adapters.identity ?? (() => serverProcessIdentity(options));
  const journal = adapters.snapshot ? null : await locateJournal(options, sessionId);
  const snapshot = adapters.snapshot ?? (() => strictJournalCopy({ journal, runtime: options.runtime, privateDir, sessionId }));
  const polling = adapters.pollMs ?? 1000;
  let socket, originalMode;
  const wait = async (callback, label) => {
    let heartbeat = Date.now();
    for (;;) {
      socket?.check();
      const result = await callback(); if (result) return result;
      if (Date.now() - heartbeat >= 30_000) { heartbeat = Date.now(); await save(); console.log(json({ phase: options.phase, waiting: label, reportFile }).trim()); }
      await delay(polling);
    }
  };
  const stableSnapshot = async () => wait(async () => {
    try { return await snapshot(); }
    catch (error) { if (error.code === 'ACCEPTANCE_NATIVE_SNAPSHOT_CHANGED') return null; throw error; }
  }, 'stable private native snapshot');
  try {
    await save(); report.process = await identify();
    if (options.phase === 'after-restart') assertRestart(checkpoint.beforeProcess, report.process);
    await api('/api/run/pause', {});
    let status = await wait(async () => { const state = await panel('status'); return state.state === 'idle' && state; }, 'existing turn natural completion');
    if (await realpath(status.workspaceDir) !== workspace) fail('ACCEPTANCE_SERVER_WORKSPACE_MISMATCH');
    if (status.model !== options.model || status.reasoningEffort !== options.effort || !status.provider?.startsWith('cortico:')) fail('ACCEPTANCE_SERVER_ROUTE_MISMATCH');
    originalMode = status.mode; report.initialSelection = selectionFacts(status);
    const expectedRoute = { provider: status.provider, model: options.model, reasoningEffort: options.effort };
    if (checkpoint.route) assert.deepEqual(expectedRoute, checkpoint.route); else checkpoint.route = expectedRoute;
    const first = await stableSnapshot();
    if (options.phase === 'before') checkpoint.originalPrefix = prefixReceipt(first);
    else { assertPrefix(checkpoint.beforeRestartPrefix, first); assertPrefix(checkpoint.originalPrefix, first); }
    report.before = prefixReceipt(first);
    if (await exists(checkpoint.outputFile)) fail('ACCEPTANCE_OUTPUT_ALREADY_EXISTS');
    assert.equal(hash(await readFile(checkpoint.inputFile)), checkpoint.inputSha256);
    socket = await connectConsole(options, checkpoint, transport);
    await wait(() => socket.ready(), 'Console World handshake');
    for (const name of options.phase === 'before' ? ['chat', 'rp', 'read'] : ['restart']) {
      const mode = name === 'rp' ? 'rp' : name === 'chat' ? 'companion' : 'work';
      await panel('mode', { mode });
      const before = await stableSnapshot(), marker = 'TINA_UPGRADE_' + name.toUpperCase() + '_' + checkpoint.nonce;
      const row = { name, marker, startedAt: new Date().toISOString(), passed: false };
      report.phases.push(row); await save();
      socket.send(promptFor(name, checkpoint, marker));
      await api('/api/run/resume', {});
      const ended = await wait(async () => {
        const state = await panel('status');
        if (state.state !== 'idle') return null;
        const latest = await stableSnapshot();
        const facts = phaseEvidence(latest.events, { marker, startSeq: before.events.at(-1)?.seq ?? -1, code: checkpoint.code,
          expectedFile: name === 'restart' ? checkpoint.outputFile : checkpoint.inputFile, expectedRoute, cwd: workspace });
        return facts.ready ? { latest, facts, state } : null;
      }, 'marker native turn natural completion');
      await api('/api/run/pause', {});
      const messages = socket.messages.filter(message => message.text.includes(marker));
      Object.assign(row, ended.facts, { finishedAt: new Date().toISOString(), selection: selectionFacts(ended.state), messages });
      row.checks.consoleOutput = messages.length > 0;
      row.checks.fixtureUnchanged = hash(await readFile(checkpoint.inputFile)) === checkpoint.inputSha256;
      row.checks.historyPrefixUnchanged = (assertPrefix(checkpoint.originalPrefix, ended.latest), true);
      if (name === 'rp') row.checks.roleplayScene = messages.some(message => /茶/.test(message.text) && /杯|递|倒|雨|门|书/.test(message.text));
      if (name === 'read') {
        row.checks.nativeRead = row.actualReadCode;
        row.checks.codeReported = messages.some(message => message.text.includes(checkpoint.code));
        row.checks.taskDeferred = !await exists(checkpoint.outputFile);
      }
      if (name === 'restart') {
        if (await exists(checkpoint.outputFile) && !(await lstat(checkpoint.outputFile)).isFile()) fail('ACCEPTANCE_OUTPUT_NOT_REGULAR_FILE');
        const output = await readFile(checkpoint.outputFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        const expected = ['preference=' + checkpoint.preference, 'project_code=' + checkpoint.projectCode, 'verification_code=' + checkpoint.code];
        row.checks.fileContentCorrect = output !== null && output.trim().split(/\r?\n/).length === 3 && expected.every(line => output.trim().split(/\r?\n/).includes(line));
        row.checks.nativeReadback = nativeFileReadEvidence(ended.latest.events.filter(event => event.seq >= row.inputSeq && event.seq <= row.endSeq), checkpoint.outputFile, expected, { cwd: workspace });
        row.output = { path: checkpoint.outputFile, sha256: output === null ? null : hash(output), bytes: output === null ? null : Buffer.byteLength(output) };
      }
      row.passed = Object.values(row.checks).every(value => value === true);
      await save(); if (!row.passed) fail('ACCEPTANCE_PHASE_CHECKS_FAILED');
      checkpoint.completed.push(name);
    }
    await panel('mode', { mode: originalMode }); originalMode = undefined;
    const final = await stableSnapshot(); assertPrefix(checkpoint.originalPrefix, final);
    const identity = await identify(); assert.deepEqual(identity, report.process, 'Service process changed within an acceptance phase');
    report.after = prefixReceipt(final); report.passed = true;
    if (options.phase === 'before') {
      checkpoint.beforeProcess = identity; checkpoint.beforeRestartPrefix = prefixReceipt(final); checkpoint.beforePassed = true;
      report.next = 'Paused. Operator may now perform the real systemctl restart, then invoke after-restart with the same state/report directory.';
    } else { checkpoint.afterPassed = true; report.restartVerified = true; }
  } catch (error) {
    report.failure = { code: error.code ?? 'ACCEPTANCE_ASSERTION_FAILED', name: error.name };
  } finally {
    try { await api('/api/run/pause', {}); } catch { report.pauseFailed = true; report.passed = false; }
    if (originalMode !== undefined) {
      try { await panel('mode', { mode: originalMode }); } catch { report.modeRestoreFailed = true; report.passed = false; }
    }
    if (!report.passed) { if (options.phase === 'before') checkpoint.beforePassed = false; else checkpoint.afterPassed = false; }
    socket?.close(); report.finishedAt = new Date().toISOString(); await save();
  }
  return { passed: report.passed, phase: options.phase, reportFile, checkpointFile, nativeSessionId: sessionId,
    failure: report.failure ?? null, paused: !report.pauseFailed, processRestartPerformedByHelper: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runServerAcceptance(parseServerAcceptanceArgs(process.argv.slice(2)));
    console.log(json(result)); if (result.passed === false) process.exitCode = 1;
  } catch (error) { console.error(json({ passed: false, code: error.code ?? 'ACCEPTANCE_PREFLIGHT_FAILED', name: error.name })); process.exitCode = 1; }
}
