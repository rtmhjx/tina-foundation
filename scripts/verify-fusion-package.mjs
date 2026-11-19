import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackagePayload } from './fusion-package-integrity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateRoot = await mkdtemp(join(tmpdir(), 'tina-fusion-package-verification-'));
const stateDir = join(stateRoot, 'state');
const allowedRoots = [root, stateRoot].map(path => process.platform === 'win32' ? path.toLowerCase() : path);
const guard = registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (result.url.startsWith('file:')) {
      const path = resolve(fileURLToPath(result.url));
      const normalized = process.platform === 'win32' ? path.toLowerCase() : path;
      if (!allowedRoots.some(base => normalized === base || normalized.startsWith(base + sep))) {
        throw new Error('Package imported a file module outside its payload and isolated state: ' + path);
      }
    }
    return result;
  },
});
const started = performance.now();
const result = { format: 1, startedAt: new Date().toISOString(), stateDir, complete: false };
const receipt = join(root, 'PACKAGE_VERIFICATION.json');
await writeFile(receipt, JSON.stringify(result, null, 2) + '\n');
let app;
try {
  const integrityStarted = performance.now();
  result.payloadIntegrity = await verifyPackagePayload(root);
  result.integrityMs = Math.round(performance.now() - integrityStarted);
  result.verifiedFiles = result.payloadIntegrity.verifiedFiles;
  const { setupFusionMemory } = await import('./setup-fusion-memory.mjs');
  const { fusionWorldToolName } = await import('../src/fusion-world.mjs');
  result.memorySetup = await setupFusionMemory({ root, stateDir });
  assert.equal(result.memorySetup.status, 'complete');
  const startupStarted = performance.now();
  const { openFusionApp } = await import('../src/fusion-app.mjs');
  app = await openFusionApp({ stateDir, port: 0 });
  result.startupMs = Math.round(performance.now() - startupStarted);
  assert.ok(app.dsh.homeDir.startsWith(stateDir));
  assert.equal(app.dsh.pid, process.pid);
  assert.equal(app.dsh.ctx.get('webServer'), undefined);
  assert.equal(typeof app.dsh.ctx.agentLoop.registerRequestHead, 'function');
  const prompts = await fetch(app.origin + '/api/prompts').then(response => response.json());
  assert.equal(prompts.application, 'next-turn');
  assert.ok(prompts.prompts.some(prompt => prompt.key === 'tina.identity'));
  const home = await fetch(app.origin);
  assert.equal(home.status, 200);
  const credential = await app.dsh.ctx.credentialsController.describe(['DEEPSEEK_API_KEY']);
  assert.equal(Boolean(credential.DEEPSEEK_API_KEY?.configured), false);
  const sourceLock = JSON.parse(await readFile(join(root, 'vendor', 'cortico-source-lock.json'), 'utf8'));
  const nativeLock = JSON.parse(await readFile(join(root, 'vendor', 'dsh-agent-loop-source-lock.json'), 'utf8'));
  const uploadsLock = JSON.parse(await readFile(join(root, 'vendor', 'dsh-file-upload-source-lock.json'), 'utf8'));
  const toolsLock = JSON.parse(await readFile(join(root, 'vendor', 'dsh-tools-source-lock.json'), 'utf8'));
  const runtimeManifest = JSON.parse(await readFile(join(root, 'runtime', 'dsh-0.1.5-rc.2', 'runtime-manifest.json'), 'utf8'));
  const nativeNode = runtimeManifest.packages.find(node => node.name === '@deepseek-ai/dsh-agent-loop');
  assert.equal(nativeNode?.sourceOverlay?.sourceTreeSha256, nativeLock.sourceTreeSha256);
  const uploadsNode = runtimeManifest.packages.find(node => node.name === '@deepseek-ai/dsh-client-file-upload');
  assert.equal(uploadsNode?.sourceOverlay?.sourceTreeSha256, uploadsLock.sourceTreeSha256);
  const toolsNode = runtimeManifest.packages.find(node => node.name === '@deepseek-ai/dsh-tools');
  assert.equal(toolsNode?.sourceOverlay?.sourceTreeSha256, toolsLock.sourceTreeSha256);
  assert.equal(typeof app.dsh.ctx.tools.hasContentFinalizer, 'function');
  assert.equal(app.bot.parts.persona.constructor.name, 'TinaSelfMemPersona');
  assert.equal(app.bot.parts.persona.sourceSessionId, app.sessionId);
  const defaultWorlds = app.nativeLoop.world.inspect().worlds;
  const consoleTool = fusionWorldToolName('console', 'console_send');
  assert.ok(defaultWorlds.includes('console'), 'First-run deployment must mount its conversation World');
  assert.ok(app.nativeLoop.world.toolSchemas().some(tool => tool.name === consoleTool), 'Console output must be a real registered World tool');
  const previousBot = app.bot;
  const nativeSession = [...app.dsh.ctx.loader.entries()].find(entry => entry.options.id === 'tina-native-session');
  await app.dsh.ctx.loader.update(nativeSession.id, { disabled: true });
  await app.dsh.ctx.loader.await();
  assert.equal(app.dsh.ctx.get('corticoCore'), undefined);
  await app.dsh.ctx.loader.update(nativeSession.id, { disabled: false });
  await app.dsh.ctx.loader.await();
  await app.whenReady();
  assert.notEqual(app.bot, previousBot);
  assert.equal((await fetch(app.origin + '/api/prompts')).status, 200);
  assert.equal(app.nativeLoop.running, true);
  Object.assign(result, {
    origin: app.origin, sourceBuilt: true, sharedBackend: true, credentialConfigured: false, importedModulesIsolated: true,
    promptApplication: prompts.application, promptDocuments: prompts.prompts.length, defaultWorlds, consoleTool,
    sourceTreeSha256: sourceLock.sourceTreeSha256,
    nativeSourceTreeSha256: nativeLock.sourceTreeSha256, runtimeSourceBuilt: true, contextHeadAvailable: true,
    fileUploadsSourceTreeSha256: uploadsLock.sourceTreeSha256, toolsSourceTreeSha256: toolsLock.sourceTreeSha256, coreReactivation: true,
  });
  await app.close();
  app = undefined;
  result.complete = true;
} finally {
  try { await app?.close(); }
  finally {
    guard.deregister();
    result.finishedAt = new Date().toISOString();
    result.elapsedMs = Math.round(performance.now() - started);
    await writeFile(receipt, JSON.stringify(result, null, 2) + '\n');
  }
}
console.log(JSON.stringify(result));
