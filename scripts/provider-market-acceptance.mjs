// Credential/UI acceptance only. This launcher never performs model inference.
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const value = flag => process.argv.find(arg => arg.startsWith(flag + '='))?.slice(flag.length + 1);
const stateDir = resolve(value('--state') ?? join(root, '.tina-fusion-dev', 'provider-acceptance'));
const inside = relative(join(root, '.tina-fusion-dev'), stateDir);
if (!inside || inside.startsWith('..') || /^[a-z]:/i.test(inside)) throw new Error('Acceptance state must be a private child of this candidate .tina-fusion-dev directory.');
const marker = join(stateDir, 'provider-acceptance-owner.json');
try {
  await stat(stateDir);
  const owner = JSON.parse(await readFile(marker, 'utf8'));
  if (owner.kind !== 'tina-market-provider-acceptance-v1') throw new Error('State ownership differs.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // Refuse an existing unmarked directory instead of adopting somebody's state.
  if (await stat(stateDir).then(() => true, () => false)) throw new Error('Existing acceptance directory has no ownership marker.');
  await mkdir(stateDir, { recursive: true });
  await writeFile(marker, JSON.stringify({ kind: 'tina-market-provider-acceptance-v1', requestedModel: 'gpt-6-astra', requestedMode: 'ultra', inferenceEnabled: false }, null, 2), { flag: 'wx' });
}
process.env.CORTICO_HOME = stateDir;
const installed = join(root, 'artifacts', 'provider-market', 'installed');
if (!await stat(join(stateDir, 'extensions', 'package.json')).then(() => true, () => false)) {
  await cp(installed, join(stateDir, 'extensions'), { recursive: true, errorOnExist: true, force: false });
  for (const name of ['cortico-provider-chatgpt-0.1.6.tgz', 'cortico-provider-coo-0.3.1.tgz']) {
    await cp(join(root, 'artifacts', 'provider-market', name), join(stateDir, name), { errorOnExist: true, force: false });
  }
}
const endpoint = 'chatgpt-acceptance';
const providerDir = join(stateDir, 'providers', endpoint);
await mkdir(providerDir, { recursive: true });
const entryFile = join(providerDir, 'config.json');
if (!await stat(entryFile).then(() => true, () => false)) {
  // A saved but unconfigured endpoint has no effective model/effort. Inference
  // remains disabled until the requested execution mode is actually supported.
  await writeFile(entryFile, JSON.stringify({ kind: 'chatgpt', baseUrl: 'https://api.openai.com/v1',
    spec: { model: '', thinking: false }, multimodal: true }, null, 2), { flag: 'wx' });
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (/\/(?:responses|chat\/completions)$/.test(url.pathname)) {
    throw Object.assign(new Error('This acceptance launcher is authentication-only; model inference is disabled.'), { code: 'MODEL_REQUESTS_DISABLED' });
  }
  const result = await originalFetch(input, options);
  if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/models' && result.ok) {
    const body = await result.clone().json();
    const model = body.models?.find(model => model.slug === 'gpt-6-astra');
    const fields = ['slug', 'display_name', 'visibility', 'supported_reasoning_levels', 'default_reasoning_level',
      'context_window', 'tool_mode', 'multi_agent_version', 'multi_agent_reasoning_effort'];
    await writeFile(join(stateDir, 'authenticated-model-capability.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), source: 'SIWC authenticated GET /v1/models', modelFound: !!model,
      model: model ? Object.fromEntries(fields.filter(key => key in model).map(key => [key, model[key]])) : null,
      inferencePerformed: false, ultraValidated: false,
    }, null, 2), { mode: 0o600 });
  }
  return result;
};
const { openFusionApp } = await import('../src/fusion-app.mjs');
const app = await openFusionApp({ stateDir, port: Number(value('--port') ?? 0), autonomousWork: false,
  beforeStart({ bot, ctx }) {
    bot.core.bus.setPaused(true);
    ctx.on('llm/stream', () => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_REQUESTS_DISABLED', message: 'Authentication-only acceptance.' } } };
    })(), { global: true, prepend: true });
  },
});
const hub = app.bot.providerHub;
const invoke = async method => {
  const detail = hub.detail(endpoint, 'zh');
  return (await hub.preview(endpoint, detail.entry, 'chatgpt', method, [endpoint], 'zh')).result;
};
const statusFile = join(stateDir, 'acceptance-status.json');
await writeFile(statusFile, JSON.stringify({ pid: process.pid, origin: app.origin, stateDir, endpoint,
  requestedModel: 'gpt-6-astra', requestedMode: 'ultra', inferenceEnabled: false, ultraValidated: false }, null, 2));
console.log(JSON.stringify({ origin: app.origin, statusFile, stateDir, inferenceEnabled: false }));
if (process.argv.includes('--sign-in')) {
  const status = await invoke('state');
  if (!status.signedIn) {
    const auth = await invoke('signIn');
    const authFile = join(stateDir, 'authorization-link.json');
    await writeFile(authFile, JSON.stringify({ authorizationUrl: auth.url }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ phase: 'waiting-for-browser', authorizationLinkFile: authFile }));
  }
}
let refreshing = false;
const timer = setInterval(async () => {
  if (refreshing) return;
  refreshing = true;
  try {
    const status = await invoke('state');
    await writeFile(join(stateDir, 'login-status.json'), JSON.stringify({ signedIn: status.signedIn === true,
      phase: status.phase, checkedAt: new Date().toISOString() }, null, 2));
    if (status.signedIn && !await stat(join(stateDir, 'authenticated-model-capability.json')).then(() => true, () => false)) {
      await app.bot.core.providers.resolve(endpoint).listModels();
    }
  } catch (error) {
    console.error(JSON.stringify({ code: error.code ?? 'AUTH_STATUS_CHECK_FAILED', phase: 'status-check' }));
  } finally { refreshing = false; }
}, 2000);
let closing;
const close = () => closing ??= (async () => { clearInterval(timer); await app.close(); globalThis.fetch = originalFetch; })();
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
