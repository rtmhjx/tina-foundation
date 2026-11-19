// Live acceptance through the original market client and the native World/Agent loop.
// Default invocation is a reviewable plan; --execute permits exactly the user-authorized model/effort.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptanceCodeSnapshot, fullMaxAcceptanceReceipt } from './lib/acceptance-gpt-max-receipt.mjs';
import { phaseTurnTerminal } from './lib/acceptance-gpt-max-state.mjs';
import { nativeFileReadEvidence } from './lib/native-file-read-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const value = flag => process.argv.find(arg => arg.startsWith(flag + '='))?.slice(flag.length + 1);
const phases = (value('--phases') ?? 'chat,rp,read,compaction,restart').split(',').filter(Boolean);
const implemented = ['chat', 'rp', 'read', 'compaction', 'restart'];
for (const phase of phases) if (!implemented.includes(phase)) throw new Error('Phase is not yet implemented: ' + phase);
const authState = join(root, '.tina-fusion-dev', 'provider-acceptance');
const endpoint = 'chatgpt-acceptance';
const model = 'gpt-6-astra', effort = 'max';
const contextPolicy = { stageBudgetTokens: 32000, thresholdRatio: 0.85 };
const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
const runId = value('--run') ?? new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + nonce.slice(0, 6);
if (!/^[\w-]+$/.test(runId)) throw new Error('Invalid acceptance run identifier.');
const stateDir = join(root, '.tina-fusion-dev', 'acceptance-gpt-max', runId);
const artifactDir = join(root, 'artifacts', 'acceptance-gpt-max', runId);
const reportFile = join(artifactDir, 'result.json');
const checkpointFile = join(stateDir, 'acceptance-checkpoint.json');
const plan = {
  model, effort, phases, stateDir, artifactDir, contextPolicy, inferenceUrl: 'https://api.openai.com/v1/responses',
  provider: 'cortico-provider-chatgpt@0.1.6', dependency: 'cortico-provider-coo@0.3.0',
  auth: 'Original market package reads and may refresh its own already-authenticated endpoint; no token copying or desktop-account extraction.',
  ingress: 'Native Console World WebSocket', loop: 'Original Cordis main Agent and tool dispatch',
  persona: 'Locked canonical @tina/self-mem Bot, installed through the original Cortico extension loader.',
  isolation: 'New empty deployment, memory, native session and workspace; only the explicit Provider account binding is shared.',
  limits: 'Natural completion; no runner timeout, turn limit or fallback model/effort.',
  ultraClaim: false, compactionRestart: 'Normal file-reading turns create measured pressure, followed by a durable SelfMem handoff and an owned-child hard process restart. Use --supervise-restart for the full sequence.',
};
if (!process.argv.includes('--execute')) { console.log(JSON.stringify({ execute: false, plan }, null, 2)); process.exit(0); }
const codeSnapshot = await acceptanceCodeSnapshot(root);
if (process.argv.includes('--supervise-restart')) {
  const firstPhases = phases.filter(phase => phase !== 'restart');
  assert.ok(firstPhases.length, 'A hard restart needs at least one complete pre-restart phase.');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, 'code-snapshot.json'), JSON.stringify(codeSnapshot, null, 2));
  const launch = async (phaseList, hold) => {
    const args = ['--expose-internals', '--import', pathToFileURL(join(root, 'upstream/cortico/node_modules/tsx/dist/loader.mjs')).href,
      fileURLToPath(import.meta.url), '--execute', '--run=' + runId, '--phases=' + phaseList.join(','),
      ...(hold ? ['--hold-for-hard-restart'] : ['--resume'])];
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(join(artifactDir, hold ? 'before-restart.log' : 'after-restart.log'));
    child.stderr.pipe(log, { end: false });
    let text = '', ready, killed = false;
    child.stdout.on('data', bytes => {
      log.write(bytes); text += bytes.toString();
      const lines = text.split(/\r?\n/); text = lines.pop();
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.hardRestartReady && event.pid === child.pid && event.stateDir === stateDir && hold) {
          ready = event;
          // Only this supervisor's own freshly spawned child can be terminated.
          killed = child.kill('SIGKILL');
        }
        if (event.phase || event.hardRestartReady) console.log(JSON.stringify(event));
      }
    });
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await new Promise(resolve => { child.once('close', resolve); if (child.stdout.readableEnded && child.stderr.readableEnded) resolve(); });
    await new Promise(resolve => log.end(resolve));
    if (hold) {
      assert.ok(ready && killed && exit.signal === 'SIGKILL', 'Child did not reach and undergo the verified hard restart boundary.');
      const receipt = { supervisorPid: process.pid, childPid: child.pid, stateDir, runId, ready,
        killedBySupervisor: true, exit, observedAt: new Date().toISOString(), orderlyAppClose: false };
      await writeFile(join(stateDir, 'hard-restart-receipt.json'), JSON.stringify(receipt, null, 2));
    } else assert.equal(exit.code, 0, 'Post-restart acceptance failed; inspect its isolated report.');
  };
  let supervisorFailure;
  try { await launch(firstPhases, true); await launch(['restart'], false); }
  catch (error) { supervisorFailure = { code: error.code ?? 'ACCEPTANCE_SUPERVISOR_FAILED', message: error.message }; }
  const readJson = (path, fallback) => readFile(path, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return fallback; throw error; });
  const completeReport = await readJson(reportFile, { plan, phases: [], requests: [], executions: [], fallbackRequests: 0, ultraClaim: false });
  const completedCheckpoint = await readJson(checkpointFile, { completedPhases: [] });
  const hardRestart = await readJson(join(stateDir, 'hard-restart-receipt.json'), null);
  if (supervisorFailure) completeReport.supervisorFailure = supervisorFailure;
  const finalSnapshot = await acceptanceCodeSnapshot(root);
  const receipt = fullMaxAcceptanceReceipt(completeReport, completedCheckpoint, hardRestart, codeSnapshot, finalSnapshot);
  const acceptanceFile = join(artifactDir, 'acceptance.json');
  completeReport.passed = receipt.passed;
  completeReport.fullAcceptance = { receipt: acceptanceFile, checks: receipt.checks };
  await writeFile(reportFile, JSON.stringify(completeReport, null, 2));
  await writeFile(acceptanceFile, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ supervisedHardRestart: true, passed: receipt.passed, checks: receipt.checks, reportFile, acceptanceFile, stateDir }));
  process.exit(receipt.passed ? 0 : 1);
}
const exists = path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const hash = value => createHash('sha256').update(value).digest('hex');
const errorFacts = error => error ? { code: error.code ?? null, type: error.type ?? null, param: error.param ?? null,
  status: error.status ?? null, message: String(error.message ?? error).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/\bsk-[\w-]+/g, '[REDACTED_SECRET]').replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED_SECRET]').slice(0, 1000) } : null;
const safeUsage = raw => raw ? structuredClone(raw) : null;
const responseFacts = raw => raw ? { id: raw.id ?? null, model: raw.model ?? null, status: raw.status ?? null,
  reasoningEffort: raw.reasoning?.effort ?? null, usage: safeUsage(raw.usage), error: errorFacts(raw.error),
  incompleteReason: raw.incomplete_details?.reason ?? null } : null;
const accountOwner = JSON.parse(await readFile(join(authState, 'provider-acceptance-owner.json'), 'utf8'));
assert.equal(accountOwner.kind, 'tina-market-provider-acceptance-v1');
const accountStatus = JSON.parse(await readFile(join(authState, 'login-status.json'), 'utf8'));
assert.equal(accountStatus.signedIn, true, 'The original market account must already be signed in.');
const { verifyCanonicalSelfMem } = await import('./package-self-mem.mjs');
const canonical = await verifyCanonicalSelfMem(root);
const memoryLock = JSON.parse(await readFile(join(root, 'vendor', 'self-mem-lock.json'), 'utf8'));
assert.equal(memoryLock.version, canonical.pkg.version, 'Standalone archive is older than the canonical memory source.');
assert.equal(memoryLock.canonicalManifestSha256, canonical.canonicalManifestSha256, 'Memory archive must originate from the frozen canonical source.');
let checkpoint;
if (await exists(stateDir)) {
  if (!process.argv.includes('--resume')) throw new Error('Run state exists; explicit --resume is required.');
  checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
  assert.equal(checkpoint.kind, 'tina-gpt-max-acceptance-v1');
  assert.equal(checkpoint.model, model); assert.equal(checkpoint.effort, effort);
  assert.equal(checkpoint.persona?.archiveSha256, memoryLock.archiveSha256, 'Resumed memory runtime differs from this acceptance run.');
} else {
  // First-run setup verifies and installs the canonical Bot tarball before
  // acceptance metadata makes the new directory non-empty.
  process.env.CORTICO_HOME = stateDir;
  const { setupFusionMemory } = await import('./setup-fusion-memory.mjs');
  const installed = await setupFusionMemory({ root, stateDir });
  assert.equal(installed.status, 'complete');
  checkpoint = { kind: 'tina-gpt-max-acceptance-v1', runId, model, effort, nonce, completedPhases: [], fixture: null };
  checkpoint.persona = { package: installed.package, version: installed.version, archiveSha256: installed.archiveSha256,
    canonicalManifestSha256: memoryLock.canonicalManifestSha256 };
  checkpoint.continuity = { preference: '薄荷茶，不加糖', projectCode: '晨星-' + nonce.slice(0, 8), taskFile: 'restart-continuation-' + nonce + '.txt' };
  const configFile = join(stateDir, 'deployment', 'config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.selfMem = { agentId: 'acceptance-' + runId, dataDir: join(stateDir, 'self-mem'),
    authorityDir: join(stateDir, 'self-mem', 'authority'), deviceDir: join(stateDir, 'self-mem', 'replica'),
    remoteUrl: '', legacyRecall: { enabled: false }, memoryIngress: { enabled: false } };
  await writeFile(configFile, JSON.stringify(config, null, 2));
}
await mkdir(artifactDir, { recursive: true });
const report = await exists(reportFile) ? JSON.parse(await readFile(reportFile, 'utf8'))
  : { kind: checkpoint.kind, plan, startedAt: new Date().toISOString(), phases: [], requests: [],
    authValuesInspected: false, privateMemoryInputs: false, fallbackRequests: 0, ultraClaim: false };
report.executions ??= [];
report.executions.push({ pid: process.pid, startedAt: new Date().toISOString(), phases, codeSnapshotSha256: codeSnapshot.sha256,
  ...(report.failure ? { priorFailure: report.failure } : {}) });
const execution = report.executions.at(-1);
delete report.failure;
delete report.shutdownCompleted; delete report.shutdownError;
report.passed = false;
const save = async () => {
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  await writeFile(checkpointFile, JSON.stringify(checkpoint, null, 2));
};
await save();
const originalFetch = globalThis.fetch;
let activePhase, app, socket, releaseProvider, market, currentPhase, socketFailure, socketExpectedClose = false;
const frames = [];

// Observe the actual HTTP stream without retaining prompt bodies, authorization
// headers or encrypted reasoning. Transform forwards the original bytes unchanged.
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!/\/(?:responses|chat\/completions)$/.test(url.pathname)) return originalFetch(input, options);
  const body = JSON.parse(options?.body ?? '{}');
  if (!activePhase || url.href !== plan.inferenceUrl || body.model !== model || body.reasoning?.effort !== effort || body.multi_agent !== undefined) {
    throw Object.assign(new Error('Acceptance permits only the exact authorized model/effort during an active phase.'), { code: 'ACCEPTANCE_WIRE_MISMATCH' });
  }
  const start = performance.now();
  const row = { ordinal: report.requests.length + 1, phase: activePhase, startedAt: new Date().toISOString(),
    request: { model: body.model, reasoningEffort: body.reasoning.effort, store: body.store ?? null, stream: body.stream ?? null,
      maxOutputTokens: body.max_output_tokens ?? null,
      inputItems: body.input?.length ?? 0, inputBytes: Buffer.byteLength(JSON.stringify(body.input ?? [])),
      instructionBytes: Buffer.byteLength(body.instructions ?? ''), tools: (body.tools ?? []).flatMap(tool =>
        tool.type === 'namespace' ? (tool.tools ?? []).map(member => tool.name + '.' + member.name) : [tool.name ?? tool.type]),
      fields: Object.keys(body).sort() }, http: null, terminal: null, finishedAt: null };
  report.requests.push(row);
  try {
    const response = await originalFetch(input, options);
    row.http = { status: response.status, requestId: response.headers.get('x-request-id'), headersElapsedMs: performance.now() - start };
    if (!response.ok) {
      const body = await response.clone().text();
      try { row.http.error = errorFacts(JSON.parse(body).error ?? JSON.parse(body)); } catch { row.http.error = errorFacts(body); }
      row.elapsedMs = performance.now() - start; row.finishedAt = new Date().toISOString();
      return response;
    }
    const decoder = new TextDecoder();
    let buffered = '';
    const observe = text => {
      buffered += text;
      const lines = buffered.split(/\r?\n/); buffered = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json || json === '[DONE]') continue;
        let event; try { event = JSON.parse(json); } catch { continue; }
        row.firstEventElapsedMs ??= performance.now() - start;
        if (event.type === 'response.output_text.delta') row.firstTextElapsedMs ??= performance.now() - start;
        if (event.type === 'response.function_call_arguments.delta') row.firstToolArgumentsElapsedMs ??= performance.now() - start;
        if (event.type === 'response.created') row.created = responseFacts(event.response);
        if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) {
          row.terminal = { event: event.type, response: responseFacts(event.response) };
          row.elapsedMs = performance.now() - start;
        }
      }
      if (buffered.length > 4 * 1024 * 1024) throw new Error('Unexpected oversized SSE line.');
    };
    const reader = response.body.getReader();
    const finished = () => { row.finishedAt = new Date().toISOString(); row.elapsedMs = performance.now() - start; };
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { observe(decoder.decode() + '\n'); finished(); controller.close(); return; }
          observe(decoder.decode(value, { stream: true })); controller.enqueue(value);
        } catch (error) { row.failure = errorFacts(error); finished(); controller.error(error); }
      },
      async cancel(reason) { row.streamCancelled = errorFacts(reason); try { await reader.cancel(reason); } finally { finished(); } },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    row.failure = errorFacts(error); row.elapsedMs = performance.now() - start; row.finishedAt = new Date().toISOString(); throw error;
  }
};

const eventsOf = () => app.dsh.ctx.sessions.get(app.sessionId).snapshotEvents();
const attemptFacts = row => ({ id: row.id, ordinal: row.ordinal, purpose: row.purpose ?? null, outcome: row.outcome,
  elapsedMs: row.elapsedMs, requestId: row.requestId, responseId: row.responseId, status: row.status,
  origin: row.origin, meters: safeUsage(row.meters), charges: safeUsage(row.charges) });
const ledgerFacts = () => app.bot.core.usageLog.readAll().map(row => ({ ...attemptFacts(row.attempt),
  providerAttempts: (row.attempt?.meters?.native?.providerAttempts ?? []).map(attemptFacts) }));

async function waitFor(predicate, label) {
  let observed = Date.now();
  for (;;) {
    if (socketFailure) throw socketFailure;
    const result = await predicate(); if (result) return result;
    if (Date.now() - observed > 30_000) {
      observed = Date.now(); await save();
      console.log(JSON.stringify({ phase: activePhase ?? 'setup', waiting: label, requests: report.requests.length,
        nativeStatus: app?.dsh.ctx.agents.get(app.sessionId)?.status ?? null }));
    }
    await delay(200);
  }
}

async function connectConsole() {
  const url = app.origin.replace(/^http/, 'ws') + '/ws/providers/world%3Aconsole/panels/chat?lang=zh';
  socket = new WebSocket(url);
  const failure = code => Object.assign(new Error('The acceptance Console connection is unavailable.'), { code });
  socket.addEventListener('error', () => { if (!socketExpectedClose) socketFailure = failure('ACCEPTANCE_CONSOLE_ERROR'); });
  socket.addEventListener('close', event => {
    if (!socketExpectedClose) socketFailure = Object.assign(failure('ACCEPTANCE_CONSOLE_CLOSED'), { closeCode: event.code });
  });
  socket.addEventListener('message', event => {
    try { const data = JSON.parse(String(event.data)); frames.push({ at: new Date().toISOString(), ...data }); }
    catch { frames.push({ type: 'invalid-frame' }); }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(socketFailure ?? failure('ACCEPTANCE_CONSOLE_ERROR')), { once: true });
    socket.addEventListener('close', () => reject(socketFailure ?? failure('ACCEPTANCE_CONSOLE_CLOSED')), { once: true });
  });
  socket.send(JSON.stringify({ type: 'hello', name: '验收员-' + checkpoint.nonce.slice(0, 6) }));
  await waitFor(() => frames.some(frame => frame.type === 'sys'), 'Console handshake');
}

async function runPhase(name, options = {}) {
  if (checkpoint.completedPhases.includes(name)) return;
  const marker = 'TINA_' + name.toUpperCase() + '_' + checkpoint.nonce;
  const mode = options.mode ?? (name === 'rp' ? 'rp' : ['read', 'restart'].includes(name) ? 'work' : 'companion');
  await app.controls.handle('mode', { mode });
  const prompts = {
    chat: `这是独立空白工作区的真实聊天验收，没有导入私人记忆。我们约定两个仅供这次测试的事实：我的饮品偏好是${checkpoint.continuity.preference}，我们的实验代号是${checkpoint.continuity.projectCode}。你好 Tina，今天我们从一个小问题开始：你愿意怎样安排一个安静的下午？请自然地回答我，通过控制台发出来，并在消息末尾附上 ${marker}。`,
    rp: `我们做一小段明确虚构的 RP：雨夜的旧书店，你是守店人，我推门进来，说“外面太冷了，这里还有茶吗？”请以角色口吻接住这个场景，包含一个动作和一句回答，通过控制台发出来，末尾附上 ${marker}。这只是临时场景，不需要写入长期记忆。`,
    read: `请在本机独立测试工作区中实际读取文件 ${checkpoint.fixture.path}，把其中 verification_code 的完整值通过控制台告诉我，末尾附上 ${marker}。代码没有包含在这条消息里，请用原生 read 工具（参数 file_path）真实读取核对，不用 shell 打印替代，不修改任何文件。另外留下一件暂未完成的任务：等我下次明确说“继续那件文件任务”时，在工作区新建 ${checkpoint.continuity.taskFile}，写入我之前说的饮品偏好、实验代号和本次读到的完整 verification_code。现在先不要创建这个文件，保留这个约定供后续续行。`,
    restart: `继续那件文件任务。请按之前保留的约定，先告诉我我的饮品偏好和实验代号，再完成那份文件。完成后用原生 read 工具（参数 file_path）实际回读核对，不用 shell 打印替代，通过控制台报告结果，末尾附上 ${marker}。这条消息没有重新提供旧事实或文件名，请从保留下来的上下文与记忆中找回。`,
  };
  if (name === 'restart') {
    assert.ok(checkpoint.completedPhases.includes('read'), 'File-task handoff must precede restart acceptance.');
    assert.ok(checkpoint.completedPhases.includes('compaction'), 'Automatic compaction and committed SelfMem handoff must precede restart acceptance.');
    const receipt = JSON.parse(await readFile(join(stateDir, 'hard-restart-receipt.json'), 'utf8'));
    assert.equal(receipt.killedBySupervisor, true); assert.equal(receipt.orderlyAppClose, false);
    assert.notEqual(receipt.childPid, process.pid); assert.equal(receipt.ready.nativeSessionId, app.sessionId);
    assert.equal(hash(JSON.stringify(eventsOf().slice(0, receipt.ready.nativeEventCount))), receipt.ready.nativePrefixSha256,
      'Native historical events changed across the hard restart.');
    assert.deepEqual(memoryFacts(), receipt.ready.memory, 'SelfMem window or committed handoff changed across restart.');
    report.hardRestart = receipt;
  }
  const startSeq = eventsOf().at(-1)?.seq ?? -1;
  const startFrames = frames.length;
  const startRequests = report.requests.length;
  const started = performance.now();
  currentPhase = { name, mode, marker, startedAt: new Date().toISOString(), startSeq, passed: false };
  report.phases.push(currentPhase); activePhase = name;
  app.bot.core.bus.setPaused(false);
  socket.send(JSON.stringify({ type: 'msg', text: options.prompt?.(marker) ?? prompts[name] }));
  await waitFor(() => {
    const rejected = frames.slice(startFrames).find(frame => frame.type === 'sys' && frame.kind === 'rejected');
    if (rejected) throw Object.assign(new Error('Console World rejected this acceptance input: ' + rejected.text), { code: 'ACCEPTANCE_WORLD_INPUT_REJECTED' });
    return eventsOf().some(event => event.seq > startSeq && event.type === 'turn/start');
  }, 'World delivery and native turn start');
  await waitFor(() => {
    const last = phaseTurnTerminal(eventsOf(), startSeq);
    const rejected = frames.slice(startFrames).find(frame => frame.type === 'sys' && frame.kind === 'rejected');
    if (rejected) throw Object.assign(new Error('Console rejected the active acceptance input.'), { code: 'ACCEPTANCE_WORLD_INPUT_REJECTED' });
    const idle = app.dsh.ctx.agents.get(app.sessionId)?.status === 'idle';
    const pending = app.nativeLoop.world.inspect().delivery.filter(row => ['pending', 'admitted', 'reserved', 'committed'].includes(row.stage));
    if (last && idle && pending.length === 0) return last;
  }, 'Natural native turn completion');
  app.bot.core.bus.setPaused(true);
  await app.nativeLoop.world.flush();
  const events = eventsOf().filter(event => event.seq > startSeq);
  const messages = frames.slice(startFrames).filter(frame => frame.type === 'msg' && !frame.history && !frame.from?.startsWith('验收员-'));
  const calls = events.filter(event => event.type === 'tool/call');
  const results = events.filter(event => event.type === 'tool/result');
  currentPhase.elapsedMs = performance.now() - started;
  currentPhase.finishedAt = new Date().toISOString();
  currentPhase.endSeq = eventsOf().at(-1).seq;
  currentPhase.turns = events.filter(event => ['turn/start', 'turn/end'].includes(event.type)).map(event => ({ type: event.type, seq: event.seq, data: event.data }));
  currentPhase.requests = report.requests.slice(startRequests).map(row => row.ordinal);
  currentPhase.visibleMessages = messages;
  currentPhase.tools = calls.map(event => ({ name: event.data.name, callId: event.data.callId, seq: event.seq }));
  currentPhase.toolResults = results.map(event => ({ seq: event.seq,
    calls: event.data.message?.content?.filter(block => block.type === 'tool-result').map(block => ({ toolCallId: block.toolCallId,
      isError: block.isError ?? false, containsFixtureCode: JSON.stringify(block.content).includes(checkpoint.fixture.code) })) ?? [] }));
  currentPhase.delivery = app.nativeLoop.world.inspect().delivery.map(row => ({ id: row.id, worldId: row.worldId, stage: row.stage, cursor: row.cursor }));
  currentPhase.selection = await app.controls.handle('status');
  currentPhase.usage = app.nativeLoop.usageProjection.inspect();
  const wire = report.requests.slice(startRequests);
  currentPhase.checks = {
    nativeTurnCompleted: currentPhase.turns.filter(row => row.type === 'turn/end').every(row => row.data.reason?.kind === 'completed'),
    actualHttpResponse: wire.some(row => row.http?.status === 200 && row.terminal?.event === 'response.completed'),
    exactRequestedModelEffort: wire.length > 0 && wire.every(row => row.request.model === model && row.request.reasoningEffort === effort),
    worldOutputDelivered: messages.some(frame => frame.text?.includes(marker)),
    fixtureRead: name !== 'read' || nativeFileReadEvidence(events, checkpoint.fixture.path, [checkpoint.fixture.code], { cwd: app.dsh.workspaceDir }),
    fixtureReported: name !== 'read' || messages.some(frame => frame.text?.includes(checkpoint.fixture.code)),
    fixtureUnchanged: hash(await readFile(checkpoint.fixture.path)) === checkpoint.fixture.sha256,
  };
  if (name === 'rp') currentPhase.checks.sceneParticipated = messages.some(frame => /茶/.test(frame.text ?? '') && /杯|递|倒|雨|门|书/.test(frame.text ?? ''));
  if (options.document) {
    currentPhase.checks.documentActuallyRead = nativeFileReadEvidence(events, options.document.path, [options.document.tailCode], { cwd: app.dsh.workspaceDir });
    currentPhase.checks.documentReported = messages.some(frame => frame.text?.includes(options.document.tailCode));
    currentPhase.checks.documentUnchanged = hash(await readFile(options.document.path)) === options.document.sha256;
    currentPhase.document = options.document;
  }
  if (name === 'restart') {
    const taskFile = join(app.dsh.workspaceDir, checkpoint.continuity.taskFile);
    const actual = await readFile(taskFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const expected = ['薄荷茶', '不加糖', checkpoint.continuity.projectCode, checkpoint.fixture.code];
    currentPhase.checks.continuityFile = expected.every(text => actual.includes(text));
    currentPhase.checks.factsRecalled = expected.slice(0, 3).every(text => messages.some(frame => frame.text?.includes(text)));
    currentPhase.checks.realToolReadback = nativeFileReadEvidence(events, taskFile, expected, { cwd: app.dsh.workspaceDir });
    currentPhase.continuityFile = { path: taskFile, sha256: hash(actual), bytes: Buffer.byteLength(actual) };
  }
  currentPhase.passed = Object.values(currentPhase.checks).every(Boolean);
  report.ledger = ledgerFacts();
  report.nativeSessionId = app.sessionId;
  checkpoint.nativeSessionId = app.sessionId;
  checkpoint.lastNativeSeq = currentPhase.endSeq;
  if (currentPhase.passed) checkpoint.completedPhases.push(name);
  await save(); activePhase = undefined;
  console.log(JSON.stringify({ phase: name, passed: currentPhase.passed, checks: currentPhase.checks,
    elapsedMs: currentPhase.elapsedMs, requests: wire.length, reportFile }));
  if (!currentPhase.passed) throw Object.assign(new Error('Live phase did not meet all acceptance checks: ' + name), { code: 'ACCEPTANCE_PHASE_FAILED' });
}

function memoryFacts() {
  const persona = app.bot.core.persona;
  const state = persona.handoffSessionState(app.sessionId);
  const operations = persona.journal.db.prepare(`SELECT operation_id,session_id,generation,expected_window,phase,receipt
    FROM handoff_operations WHERE session_id=? ORDER BY expected_window,operation_id`).all(app.sessionId);
  return { sourceSessionId: persona.sourceSessionId, window: state.window, navigationRef: state.handoff?.ref ?? null,
    operations: operations.map(row => ({ operationId: row.operation_id, sessionId: row.session_id,
      generation: JSON.parse(row.generation), expectedWindow: row.expected_window, phase: row.phase,
      receipt: row.receipt ? JSON.parse(row.receipt) : null })) };
}

async function runAutomaticCompaction() {
  if (checkpoint.completedPhases.includes('compaction')) return;
  assert.ok(checkpoint.completedPhases.includes('read'), 'The same-session pending file task precedes pressure.');
  assert.ok(app.nativeLoop.contextMaintenance, 'Transactional SelfMem context maintenance must be mounted.');
  const phase = checkpoint.compaction ??= { startSeq: eventsOf().at(-1)?.seq ?? -1, initialMemory: memoryFacts(),
    initialMeasurement: app.nativeLoop.tokenMeasurement(), documents: [], startedAt: new Date().toISOString() };
  assert.ok(Number.isFinite(phase.initialMeasurement?.totalTokens), 'Head-aware native measurement is required.');
  report.automaticCompaction = phase;
  const completed = async () => {
    const status = await app.nativeLoop.contextMaintenance.status();
    if (status?.phase !== 'complete' || status.reason !== 'pressure') return null;
    const summary = eventsOf().find(event => event.seq > phase.startSeq && event.type === 'compaction/summary'
      && event.data.compactionId === status.nativeReceipt?.evidence?.compactionId);
    return summary ? { status, summary } : null;
  };
  let evidence = await completed();
  while (!evidence) {
    const index = phase.documents.length + 1;
    const before = app.nativeLoop.tokenMeasurement();
    const tailCode = 'DOCUMENT_' + randomUUID().replaceAll('-', '');
    const lines = ['仅供独立验收的虚构档案。每行是不同编号的书店库存记录，无真人或私人资料。'];
    while (lines.join('\n').length < 8500) {
      const n = lines.length;
      lines.push(`档案${index}条目${String(n).padStart(4, '0')}：虚构书架${(n * 17 + index) % 31}号，书名《雨天实验笔记${n}》，库存${n % 9 + 1}本，借阅类别为${['自然观察', '建筑草图', '旧城故事', '茶叶常识'][n % 4]}；当日核对说明：标签完好、封面平整，需于下次盘点时按编号顺序复查。`);
    }
    lines.push('文档末尾核对码=' + tailCode);
    const text = lines.join('\n') + '\n';
    const path = join(app.dsh.workspaceDir, 'pressure-document-' + checkpoint.nonce + '-' + index + '.txt');
    await writeFile(path, text, { flag: 'wx' });
    const document = { index, path, tailCode, bytes: Buffer.byteLength(text), sha256: hash(text), before };
    phase.documents.push(document); await save();
    await runPhase('pressure-document-' + index, { mode: 'work', document,
      prompt: marker => `请实际完整读取这份独立验收用虚构档案：${path}。内容需供后续整理使用，请用原生 read 工具（参数 file_path）把全文读入，不用 shell 打印替代；若输出截断，按工具提供的 continuation 或分段读取到末尾，不要只搜索核对码。随后用两句话概括这份档案，并把文档末尾核对码完整告诉我，末尾附上 ${marker}。不要修改任何文件，也不要提前完成之前约定的续行文件任务。` });
    document.after = app.nativeLoop.tokenMeasurement();
    document.maintenance = await app.nativeLoop.contextMaintenance.status();
    await save(); evidence = await completed();
    if (!evidence && !(document.after?.totalTokens > before?.totalTokens)) {
      throw Object.assign(new Error('Reading did not increase measured context or produce a committed pressure handoff; inspect token and surface evidence before adding more input.'), { code: 'ACCEPTANCE_PRESSURE_NO_PROGRESS' });
    }
  }
  await app.bot.core.persona.flush({ onlyPending: true });
  phase.completedAt = new Date().toISOString();
  phase.maintenance = evidence.status;
  phase.summary = { seq: evidence.summary.seq, compactionId: evidence.summary.data.compactionId,
    usage: safeUsage(evidence.summary.data.usage), llmStreamCall: evidence.summary.data.llmStreamCall ?? null };
  phase.finalMemory = memoryFacts();
  phase.finalMeasurement = app.nativeLoop.tokenMeasurement();
  const matching = phase.finalMemory.operations.find(row => row.operationId === evidence.status.operationId);
  const receipt = evidence.status.nativeReceipt;
  phase.checks = { naturalPressureReason: evidence.status.reason === 'pressure', coordinatorComplete: evidence.status.phase === 'complete',
    realSummaryRequest: evidence.summary.data.llmStreamCall === true,
    nativeDurableReceipt: receipt?.durable === true && receipt?.method === 'native-compact' && receipt.coverage?.sourceComplete === true,
    selfMemCommitted: matching?.phase === 'committed' && isDeepStrictEqual(matching.receipt, receipt),
    selfMemWindowAdvanced: phase.finalMemory.window > phase.initialMemory.window,
    sameNativeSession: phase.finalMemory.sourceSessionId === app.sessionId,
    summaryBilled: ledgerFacts().some(row => row.meters?.native?.eventType === 'compaction/summary'
      && row.meters?.native?.eventSeq === evidence.summary.seq) };
  phase.passed = Object.values(phase.checks).every(Boolean);
  report.phases.push({ name: 'compaction', passed: phase.passed, checks: phase.checks,
    startedAt: phase.startedAt, finishedAt: phase.completedAt, documents: phase.documents.length });
  if (phase.passed) checkpoint.completedPhases.push('compaction');
  await save();
  console.log(JSON.stringify({ phase: 'compaction', passed: phase.passed, checks: phase.checks, documents: phase.documents.length, reportFile }));
  assert.ok(phase.passed, 'Automatic compaction and SelfMem durable handoff did not meet every check.');
}

try {
  process.env.CORTICO_HOME = stateDir;
  const { loadMarketProviderModule } = await import('../src/fusion-market-provider.mjs');
  const packageDir = join(authState, 'extensions', 'node_modules', 'cortico-provider-chatgpt');
  market = await loadMarketProviderModule({ packageDir });
  const { chatgptModule } = await import(pathToFileURL(join(packageDir, 'src', 'provider.ts')).href);
  const availability = chatgptModule(undefined, () => join(authState, 'providers')).availability;
  const bound = { ...market.module, availability,
    create(name, entry, host) {
      assert.equal(name, endpoint, 'Only the original authenticated acceptance endpoint may be bound.');
      return market.module.create(name, entry, { ...host, stateDir: join(authState, 'providers', endpoint) });
    },
  };
  const { registerProviderModules } = await import('../upstream/cortico/src/providers/registry.ts');
  releaseProvider = registerProviderModules([bound]);
  const ownEndpoint = join(stateDir, 'providers', endpoint);
  await mkdir(ownEndpoint, { recursive: true });
  const entry = { kind: 'chatgpt', baseUrl: 'https://api.openai.com/v1', multimodal: true,
    spec: { model, thinking: true, reasoningEffort: effort } };
  await writeFile(join(ownEndpoint, 'config.json'), JSON.stringify(entry, null, 2));
  const { openFusionApp } = await import('../src/fusion-app.mjs');
  app = await openFusionApp({ stateDir, autonomousWork: true, contextPolicy,
    beforeStart({ bot }) { bot.core.bus.setPaused(true); bot.providerHub.activate(endpoint, 'zh'); },
  });
  assert.equal(app.bot.core.persona.constructor.name, 'TinaSelfMemPersona');
  report.runtime = { origin: app.origin, sessionId: app.sessionId, stateDir, workspaceDir: app.dsh.workspaceDir,
    providerPackage: market.identity, persona: checkpoint.persona, nativeRoundPolicy: app.bot.core.loaded.config.selfMem.rounds,
    authBinding: 'Original plugin state; independent model configuration and sessions.' };
  if (!checkpoint.fixture) {
    const file = join(app.dsh.workspaceDir, 'acceptance-read-' + checkpoint.nonce + '.txt');
    const code = 'READ_' + randomUUID().replaceAll('-', '');
    const text = 'Synthetic acceptance fixture.\nverification_code=' + code + '\n';
    await writeFile(file, text, { flag: 'wx' });
    checkpoint.fixture = { path: file, code, sha256: hash(text) };
  }
  const inside = relative(app.dsh.workspaceDir, checkpoint.fixture.path);
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
  await save(); await connectConsole();
  for (const phase of phases) {
    if (phase === 'compaction') await runAutomaticCompaction();
    else await runPhase(phase);
  }
  report.selectedPhasesPassed = phases.every(phase => checkpoint.completedPhases.includes(phase));
  report.passed = false; // Only the supervisor's complete five-phase receipt can be a deployment gate.
  if (process.argv.includes('--hold-for-hard-restart')) {
    assert.ok(checkpoint.completedPhases.includes('read'), 'Hard restart follows the preserved file-task handoff.');
    assert.ok(checkpoint.completedPhases.includes('compaction'), 'Hard restart follows verified automatic compaction.');
    await app.dsh.ctx.sessions.flush(app.dsh.ctx.sessions.get(app.sessionId));
    await app.bot.core.persona.flush({ onlyPending: true });
    execution.finalCodeSnapshotSha256 = (await acceptanceCodeSnapshot(root)).sha256;
    assert.equal(execution.finalCodeSnapshotSha256, codeSnapshot.sha256, 'Accepted source/runtime changed during the live run.');
    const ready = { hardRestartReady: true, pid: process.pid, stateDir, nativeSessionId: app.sessionId,
      nativeEventCount: eventsOf().length, nativePrefixSha256: hash(JSON.stringify(eventsOf())),
      phases: checkpoint.completedPhases, codeSnapshotSha256: codeSnapshot.sha256,
      memory: memoryFacts(), nativeStatus: app.dsh.ctx.agents.get(app.sessionId).status };
    assert.equal(ready.nativeStatus, 'idle');
    report.hardRestartReady = ready; await save(); console.log(JSON.stringify(ready));
    await new Promise(() => {}); // Supervisor kills this owned child; no orderly app shutdown runs.
  }
} catch (error) {
  report.failure = errorFacts(error); report.passed = false;
  if (currentPhase && !currentPhase.finishedAt) currentPhase.failure = errorFacts(error);
  process.exitCode = 1;
} finally {
  activePhase = undefined;
  socketExpectedClose = true; socket?.close();
  if (app) {
    app.bot.core.bus.setPaused(true);
    report.ledger = ledgerFacts();
    report.nativeEventCount = eventsOf().length;
    try { await app.close(); report.shutdownCompleted = true; } catch (error) { report.shutdownError = errorFacts(error); process.exitCode = 1; }
  }
  releaseProvider?.(); market?.dispose(); globalThis.fetch = originalFetch;
  execution.finalCodeSnapshotSha256 = (await acceptanceCodeSnapshot(root)).sha256;
  if (execution.finalCodeSnapshotSha256 !== codeSnapshot.sha256) {
    report.failure = { code: 'ACCEPTANCE_CODE_CHANGED', message: 'Source/runtime changed during a live execution.' }; process.exitCode = 1;
  }
  execution.shutdownCompleted = report.shutdownCompleted === true;
  execution.exitCode = process.exitCode ?? 0;
  execution.finishedAt = new Date().toISOString();
  report.finishedAt = new Date().toISOString();
  report.actualModels = [...new Set(report.requests.flatMap(row => [row.created?.model, row.terminal?.response?.model]).filter(Boolean))];
  report.actualEfforts = [...new Set(report.requests.flatMap(row => [row.created?.reasoningEffort, row.terminal?.response?.reasoningEffort]).filter(Boolean))];
  await save();
}
console.log(JSON.stringify({ passed: report.passed, selectedPhasesPassed: report.selectedPhasesPassed, reportFile, stateDir, failure: report.failure ?? null,
  requests: report.requests.length, actualModels: report.actualModels, actualEfforts: report.actualEfforts }));
