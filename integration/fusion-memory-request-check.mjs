import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fusionWorldToolName } from '../src/fusion-world.mjs';

// Only the LLM transport is scripted. Package loading, World ingress, native
// Agent/tool dispatch, memory persistence, and restart use the actual product.
const root = resolve(import.meta.dirname, '..');
const run = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const SEED = 'MEMORY_REQUEST_FIXTURE_SEED_8e55';
const PATCH_A = 'MEMORY_REQUEST_REFRESHED_CANVAS_12d9';
const PATCH_B = 'MEMORY_REQUEST_UNREFRESHED_CANVAS_a603';
const FILE_TEXT = 'MEMORY_REQUEST_NATIVE_FILE_445a';
const SPEECH = 'MEMORY_REQUEST_WORLD_SPEECH_a144';
const toolNames = {
  events: 'cortico_world_events',
  patch: fusionWorldToolName('persona', 'self_memory_patch'),
  memory: fusionWorldToolName('persona', 'self_memory_read'),
  speech: fusionWorldToolName('console', 'console_send'),
  file: 'read',
};
const systems = body => (body.messages ?? []).filter(row => row.role === 'system')
  .map(row => typeof row.content === 'string' ? row.content : JSON.stringify(row.content)).join('\n');
const resultText = (body, id) => {
  const message = (body.messages ?? []).findLast(row => row.role === 'tool' && row.tool_call_id === id);
  assert.ok(message, 'No tool result reached the model for ' + id);
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
};
function sse(response, delta, reason = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end('data: ' + JSON.stringify({ choices: [{ index: 0,
    delta: { role: 'assistant', ...delta }, finish_reason: reason }] }) + '\n\ndata: [DONE]\n\n');
}
async function until(predicate, label) {
  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error('Scripted native memory fixture did not settle: ' + label);
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
}
async function installPackage(packageFile, outDir, stateDir) {
  assert.ok(isAbsolute(packageFile), '--package must resolve to an absolute tgz path.');
  const npmCli = [process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js'].find(file => file?.endsWith('npm-cli.js') && existsSync(file));
  assert.ok(npmCli, 'npm CLI is required to install the independent package.');
  const extensionDir = join(stateDir, 'extensions');
  await mkdir(extensionDir, { recursive: true });
  const userconfig = join(outDir, 'npmrc');
  await writeFile(userconfig, 'registry=http://127.0.0.1:9\naudit=false\nfund=false\n');
  await run(process.execPath, [npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-package-lock', '--cache', join(outDir, 'npm-cache'), '--prefix', extensionDir, packageFile], {
    cwd: outDir, windowsHide: true, env: { ...process.env, npm_config_userconfig: userconfig },
  });
  const pkgDir = join(extensionDir, 'node_modules/@tina/self-mem');
  const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@tina/self-mem');
  assert.equal(pkg.cortico?.kind, 'bot');
  assert.equal(pkg.cortico?.api, 7);
  const manifest = JSON.parse(await readFile(join(pkgDir, 'BUILD-MANIFEST.json'), 'utf8'));
  assert.ok(manifest.files.length > 0, 'The package must carry its build integrity manifest.');
  for (const entry of manifest.files) {
    const file = resolve(pkgDir, entry.path);
    assert.ok(inside(pkgDir, file), 'Package manifest escaped its installed root.');
    assert.equal(sha(await readFile(file)), entry.sha256, 'Installed package hash mismatch: ' + entry.path);
  }
  return { packageFile, sha256: sha(await readFile(packageFile)), name: pkg.name, version: pkg.version,
    api: pkg.cortico.api, pkgDir, verifiedFiles: manifest.files.length, lifecycleScriptsExecuted: false };
}

export async function runMemoryRequestCheck({ packageFile, outDir } = {}) {
  assert.ok(packageFile, 'Supply the independently built API7 @tina/self-mem tgz with --package.');
  packageFile = resolve(packageFile);
  await readFile(packageFile);
  const base = join(root, '.tina-fusion-dev');
  await mkdir(base, { recursive: true });
  if (outDir) {
    outDir = resolve(outDir);
    assert.ok(inside(base, outDir) && outDir !== base, 'Explicit output must be a new directory under .tina-fusion-dev.');
    await mkdir(outDir); // Deliberately refuse reuse of any prior state.
  } else outDir = await mkdtemp(join(base, 'fusion6-memory-request-'));
  const stateDir = join(outDir, 'state');
  const report = { schema: 'fusion6-memory-request/v1', startedAt: new Date().toISOString(),
    outDir, stateDir, fixtureOnly: true, externalModelRequests: 0, tokenUsage: null,
    tokenUsageReason: 'Loopback scripted provider emits no usage; this is a request-chain correctness check.',
    restartMethod: 'Full app.close() tears down Core and embedded DSH, then openFusionApp() reads the same state in this test process; no OS-process restart is claimed.',
    productionMemoryUsed: false, personaHooksReplaced: false, acceptance: {}, phases: {}, errors: [] };
  report.scriptSha256 = sha(await readFile(import.meta.filename));
  report.reproduce = { cwd: root, executable: process.execPath, args: ['--expose-internals', '--import',
    join(root, 'upstream/cortico/node_modules/tsx/dist/loader.mjs'), import.meta.filename,
    '--package', packageFile] };
  const requests = [], generations = [], originalReadback = [];
  let app, phase = 'boot', eventText, steps = [], step = 0, lastCall, fixtureError;
  let expectedCanvas, forbidCanvas = [], nativeFile, serial = 0;
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }));
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw);
      const system = systems(body);
      const main = system.includes(SEED);
      requests.push({ index: requests.length + 1, at: new Date().toISOString(), phase, main,
        path: request.url, rawBase64: raw.toString('base64'), rawRequestSha256: sha(raw), body,
        systemSha256: sha(system), systemBytes: Buffer.byteLength(system),
        schemaCount: body.tools?.length ?? 0, canvasSha256: expectedCanvas ? sha(expectedCanvas) : null });
      assert.equal(main, true, 'Unexpected auxiliary/model request without the isolated Persona seed.');
      assert.ok(expectedCanvas && system.includes(expectedCanvas), 'The expected complete frozen canvas did not reach the native model request.');
      for (const marker of forbidCanvas) assert.equal(system.includes(marker), false, 'Mid-turn or unrequested canvas content leaked into system: ' + marker);
      if (lastCall) {
        const text = resultText(body, lastCall.id);
        lastCall.verify?.(text);
      }
      if (step === steps.length) return sse(response, { content: 'MEMORY_REQUEST_PHASE_COMPLETE_' + phase });
      const next = steps[step++];
      const definition = body.tools?.find(tool => tool.function?.name === next.name);
      assert.ok(definition, 'Native model schema does not advertise ' + next.name);
      const args = typeof next.args === 'function' ? next.args(definition.function.parameters) : next.args;
      const id = 'memory-fixture-' + ++serial;
      lastCall = { ...next, id };
      sse(response, { tool_calls: [{ index: 0, id, type: 'function',
        function: { name: next.name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
    } catch (error) {
      fixtureError ??= error;
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const events = () => app.dsh.ctx.sessions.get(app.sessionId).snapshotEvents();
  const canvas = async () => {
    const segment = (await app.bot.parts.persona.systemSegments()).find(row => row.title === '自我与记忆画布');
    assert.ok(segment?.text, 'Selected Bot did not expose its memory canvas system segment.');
    return segment.text;
  };
  const pull = () => ({ name: toolNames.events, args: {}, verify: text => assert.ok(text.includes(eventText), 'World event original did not reach the model through the event tool.') });
  const patch = marker => ({ name: toolNames.patch, args: { action: 'promote', heading: '验收',
    newText: marker, reason: 'Isolated synthetic native request-chain verification.' } });
  const read = (markers, refresh = false) => ({ name: toolNames.memory,
    args: refresh ? { refreshSystem: true } : {}, verify(text) {
      for (const marker of markers) assert.ok(text.includes(marker), 'Memory readback is missing ' + marker);
      if (refresh) {
        assert.match(text, /"requested"\s*:\s*true/);
        assert.match(text, /"applies"\s*:\s*"next-turn"/);
      }
    } });
  async function open(reopen = false) {
    const { openFusionApp } = await import('../src/fusion-app.mjs');
    app = await openFusionApp({ stateDir, ...(reopen ? {} : { bot: '@tina/self-mem' }),
      localProvider: 'http://127.0.0.1:' + server.address().port,
      executionDefaults: { toolMode: 'native', maxInlineBytes: 1024 * 1024 },
      beforeStart(context) { context.bot.core.bus.setPaused(true); },
    });
    assert.equal(app.dsh.pid, process.pid);
    assert.equal(app.dsh.ctx.corticoCore, app.bot.core);
    assert.equal(app.bot.parts.persona.sourceSessionId, app.sessionId, 'Memory must use the real persistent native session identity.');
    await app.controls.handle('mode', { mode: 'work' });
  }
  async function turn(nextPhase, plan, frozen, forbidden = []) {
    console.log('[memory-request] phase ' + nextPhase + ' starting');
    phase = nextPhase; steps = plan; step = 0; lastCall = undefined; fixtureError = undefined;
    expectedCanvas = frozen; forbidCanvas = forbidden;
    eventText = 'MEMORY_REQUEST_ORIGINAL_' + nextPhase + ': synthetic World text with Unicode 原文 and punctuation [a:b].';
    const previousSeq = events().at(-1)?.seq ?? 0;
    const requestStart = requests.length;
    const event = app.bot.core.store.append({ source: 'console', origin: 'internal', type: 'fixture.memory',
      ts: new Date().toISOString(), text: eventText, contextDelivery: 'deliver' });
    app.bot.core.bus.push({ event }, { trigger: 'flush' });
    app.bot.core.bus.setPaused(false);
    await until(() => fixtureError || events().some(row => row.seq > previousSeq && row.type === 'turn/end')
      && app.nativeLoop.phase.state === 'idle', phase);
    app.bot.core.bus.setPaused(true);
    if (fixtureError) throw fixtureError;
    await app.nativeLoop.world.flush();
    const rows = events().filter(row => row.seq > previousSeq);
    assert.equal(rows.findLast(row => row.type === 'turn/end')?.data.reason.kind, 'completed');
    assert.equal(step, plan.length);
    assert.equal(rows.some(row => row.type === 'user/message' && row.data.source?.kind === 'user'), false);
    const calls = rows.filter(row => row.type === 'tool/call');
    assert.deepEqual(calls.map(row => row.data.name), plan.map(row => row.name));
    const blocks = rows.filter(row => row.type === 'tool/result').flatMap(row => row.data.message?.content ?? []);
    for (const call of calls) {
      const result = blocks.find(block => block.toolCallId === call.data.callId);
      assert.ok(result, 'Native result was not persisted for ' + call.data.name);
      assert.ok(!result.isError, 'Native tool failed: ' + call.data.name + ' ' + JSON.stringify(result));
    }
    assert.equal(app.nativeLoop.world.inspect().delivery.some(row => row.cursor === event.cursor
      && ['pending', 'admitted', 'reserved', 'committed'].includes(row.stage)), false);
    await app.bot.parts.persona.flush({ onlyPending: true });
    const search = await app.bot.parts.persona.memory.search({ query: 'MEMORY_REQUEST_ORIGINAL_' + nextPhase, scope: 'raw', limit: 50 });
    let preserved;
    for (const hit of search.hits ?? []) {
      if (hit.type !== 'source') continue;
      const source = await app.bot.parts.persona.memory.readRef(hit.ref, { includeNeighbors: 0 });
      if (source.content === eventText && JSON.stringify(source.original ?? null).includes(eventText)) {
        preserved = source; break;
      }
    }
    assert.ok(preserved, 'World original was not retained in memory with its original payload.');
    assert.deepEqual(preserved.original, event, 'Memory did not retain the exact complete World event envelope.');
    assert.equal(preserved.sessionId, app.sessionId);
    originalReadback.push({ phase, event, source: preserved });
    const wire = requests.slice(requestStart);
    assert.equal(wire.length, plan.length + 1);
    assert.equal(new Set(wire.map(row => row.systemSha256)).size, 1,
      'The full system prefix changed between requests in the same native turn.');
    report.phases[phase] = { eventCursor: event.cursor, originalSha256: sha(eventText), memoryRef: preserved.ref,
      wireRequests: wire.length, frozenCanvasSha256: sha(frozen), systemHashes: [...new Set(wire.map(row => row.systemSha256))],
      nativeToolCalls: calls.map(row => ({ seq: row.seq, ...row.data })), endReason: 'completed' };
    console.log('[memory-request] phase ' + nextPhase + ' passed: ' + wire.length + ' requests');
  }
  try {
    report.package = await installPackage(packageFile, outDir, stateDir);
    const { loadBuiltinWorlds } = await import('../upstream/cortico/src/worlds/index.ts');
    const worlds = Object.fromEntries((await loadBuiltinWorlds()).map(world => [world.id, { enabled: world.id === 'console' }]));
    const deployment = join(stateDir, 'deployment');
    await mkdir(deployment, { recursive: true });
    report.precreatedMemoryDataDir = false;
    await writeFile(join(deployment, 'seed.md'), '# Synthetic acceptance Persona\n' + SEED + '\n');
    await writeFile(join(deployment, 'config.json'), JSON.stringify({
      worlds, web: { host: '127.0.0.1', port: 0 },
      paths: { memory: join(stateDir, 'persona'), data: join(stateDir, 'cortico-data') },
      selfMem: { agentId: 'fusion6-request-fixture', dataDir: join(stateDir, 'self-mem'),
        authorityDir: join(stateDir, 'memory-authority'), deviceDir: join(stateDir, 'memory-device'),
        remoteUrl: '', remoteToken: '', seedFile: 'seed.md', captureReasoning: true,
        rounds: { soft: 8, hard: 12 } },
    }, null, 2));
    await new Promise((accept, reject) => server.listen(0, '127.0.0.1', accept).once('error', reject));
    await open();
    report.sessionId = app.sessionId;
    nativeFile = join(app.dsh.workspaceDir, 'memory-request-native-fixture.txt');
    await writeFile(nativeFile, FILE_TEXT + '\n');
    const baseline = await canvas();
    await writeFile(join(outDir, 'canvas-before.txt'), baseline);
    await turn('refresh', [pull(), patch(PATCH_A), read([PATCH_A], true), {
      name: toolNames.file, args(parameters) {
        const key = ['file_path', 'path', 'filePath', 'filename'].find(candidate => candidate in (parameters?.properties ?? {}));
        assert.ok(key, 'Unknown native read path argument: ' + JSON.stringify(parameters));
        return { [key]: nativeFile };
      }, verify: text => assert.ok(text.includes(FILE_TEXT)),
    }, { name: toolNames.speech, args: { text: SPEECH }, verify: text => assert.ok(text.includes('[sent]')) }], baseline, [PATCH_A, PATCH_B]);
    const speechEvent = app.bot.core.store.range({ fromCursor: report.phases.refresh.eventCursor })
      .find(event => event.source === 'console' && event.type === 'console.self' && event.meta?.body === SPEECH);
    assert.ok(speechEvent, 'Successful speech was not archived by the actual console World.');
    report.consoleSpeech = { cursor: speechEvent.cursor, textSha256: sha(speechEvent.text), liveBrowserObserved: false };
    report.acceptance.sameTurnCanvasFrozen = true;
    report.acceptance.sameTurnFullSystemFrozen = true;
    report.acceptance.refreshAcknowledgedNextTurn = true;
    report.acceptance.nativeFileRead = true;
    report.acceptance.worldSpeechTool = true;
    const refreshed = await canvas();
    assert.ok(refreshed.includes(PATCH_A));
    assert.notEqual(refreshed, baseline);
    await writeFile(join(outDir, 'canvas-refreshed.txt'), refreshed);
    await turn('next-turn', [pull(), read([PATCH_A]), patch(PATCH_B), read([PATCH_A, PATCH_B])], refreshed, [PATCH_B]);
    report.acceptance.nextTurnUsesRefreshedCanvas = true;
    report.acceptance.patchWithoutRefreshPreservesFrozenCanvas = true;
    assert.equal(await canvas(), refreshed);
    generations.push({ generation: 1, sessionId: app.sessionId, events: events() });
    await app.close(); app = undefined;
    await open(true);
    assert.equal(app.sessionId, report.sessionId);
    assert.equal(await canvas(), refreshed, 'Restart changed the persisted frozen prefix to the newer unrefreshed memory.');
    await turn('reopen', [pull(), read([PATCH_A, PATCH_B])], refreshed, [PATCH_B]);
    assert.deepEqual(report.phases.reopen.systemHashes, report.phases['next-turn'].systemHashes,
      'Closing and reopening the same session changed the full frozen system prefix.');
    report.acceptance.restartKeepsFrozenPrefix = true;
    report.acceptance.restartKeepsFullSystemPrefix = true;
    report.acceptance.restartRetainsUnrefreshedCanvasChanges = true;
    report.acceptance.worldOriginalInMemory = true;
    report.acceptance.worldOriginalPayloadExact = true;
    report.acceptance.eventOnlyNativeIngress = true;
    report.acceptance.realSessionIdentity = true;
    report.acceptance.independentApi7Package = true;
    report.acceptance.sameProcessNative = true;
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL';
    report.errors.push({ message: error.message, stack: error.stack });
  } finally {
    try { if (app) generations.push({ generation: generations.length + 1, sessionId: app.sessionId, events: events() }); }
    catch (error) { report.errors.push({ snapshot: error.message }); }
    try { await app?.close(); } catch (error) { report.errors.push({ cleanup: error.message }); }
    server.closeAllConnections();
    if (server.listening) await new Promise(done => server.close(done));
    if (report.errors.length) report.status = 'FAIL';
    report.finishedAt = new Date().toISOString();
    report.requestCount = requests.length;
    report.artifacts = { wire: join(outDir, 'wire-requests.json'), events: join(outDir, 'native-events.json'),
      originals: join(outDir, 'memory-originals.json'), receipt: join(outDir, 'receipt.json') };
    await writeFile(report.artifacts.wire, JSON.stringify(requests, null, 2));
    await writeFile(report.artifacts.events, JSON.stringify(generations, null, 2));
    await writeFile(report.artifacts.originals, JSON.stringify(originalReadback, null, 2));
    await writeFile(report.artifacts.receipt, JSON.stringify(report, null, 2) + '\n');
    await mkdir(join(outDir, 'docs'), { recursive: true });
    await writeFile(join(outDir, 'docs/FUSION6_MEMORY_REQUEST_RESULT.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argument = flag => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const result = await runMemoryRequestCheck({ packageFile: argument('--package'), outDir: argument('--out') });
  console.log(JSON.stringify({ status: result.status, outDir: result.outDir, package: result.package,
    acceptance: result.acceptance, requests: result.requestCount, errors: result.errors }, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
