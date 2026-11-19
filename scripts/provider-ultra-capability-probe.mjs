// Explicit one-request API capability probe. It does not claim Codex Ultra orchestration.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = join(root, '.tina-fusion-dev', 'provider-acceptance');
const request = { model: 'gpt-6-astra', reasoning: { effort: 'ultra' },
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply exactly: TINA_ULTRA_API_PROBE_OK.' }] }] };
const plan = { package: 'cortico-provider-chatgpt@0.1.6', dependency: 'cortico-provider-coo@0.3.0',
  auth: 'Existing plugin-owned SIWC endpoint; package may refresh its own token.',
  endpoint: 'https://api.openai.com/v1/responses', method: 'POST',
  request: { ...request, store: false, stream: true, include: ['reasoning.encrypted_content'] },
  nativeOptions: { diagnostic: true }, maxInferenceHttpRequests: 1, tools: 0,
  memoryOrSessionInputs: false, fallbackModel: null, fallbackEffort: null,
  claimScope: 'API acceptance/returned metadata only; not Codex multi-agent execution.',
};
if (!process.argv.includes('--execute')) {
  console.log(JSON.stringify({ execute: false, plan }, null, 2));
  process.exit(0);
}

const owner = JSON.parse(await readFile(join(stateDir, 'provider-acceptance-owner.json'), 'utf8'));
if (owner.kind !== 'tina-market-provider-acceptance-v1') throw new Error('Probe state ownership differs.');
const observed = JSON.parse(await readFile(join(stateDir, 'authenticated-model-capability.json'), 'utf8'));
if (observed.model?.slug !== request.model || !observed.model.supported_reasoning_levels?.some(level => level.effort === 'ultra')) {
  throw new Error('The authenticated model catalog does not advertise the exact requested effort.');
}
process.env.CORTICO_HOME = stateDir;
const resultFile = join(root, 'artifacts', 'provider-market', 'ultra-api-probe-result.json');
const receipt = { startedAt: new Date().toISOString(), plan, wire: null, http: null, terminal: null,
  inferenceHttpRequests: 0, blockedAdditionalRequests: 0, outcomes: [], attempts: [],
  apiAccepted: false, returnedEffortConfirmed: false, codexUltraOrchestrationValidated: false };
const redact = text => String(text ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED_SECRET]')
  .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED_SECRET]')
  .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED_SECRET]').slice(0, 1000);
const errorFacts = error => error ? { code: error.code ?? null, type: error.type ?? null,
  param: error.param ?? null, message: redact(error.message) } : null;
const responseFacts = response => response ? { id: response.id ?? null, model: response.model ?? null,
  status: response.status ?? null, reasoning: response.reasoning ? { effort: response.reasoning.effort ?? null } : null,
  error: errorFacts(response.error), incompleteReason: response.incomplete_details?.reason ?? null } : null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (/\/(?:responses|chat\/completions)$/.test(url.pathname)) {
    if (receipt.inferenceHttpRequests) { receipt.blockedAdditionalRequests++; throw Object.assign(new Error('This reviewed probe permits one inference HTTP request.'), { code: 'PROBE_RETRY_BLOCKED' }); }
    const wire = JSON.parse(options.body);
    if (url.href !== plan.endpoint || wire.model !== 'gpt-6-astra' || wire.reasoning?.effort !== 'ultra'
      || wire.multi_agent !== undefined || wire.tools?.length || wire.store !== false || wire.stream !== true
      || JSON.stringify(wire.input) !== JSON.stringify(request.input)) throw new Error('Provider wire differs from the reviewed exact-model/effort synthetic probe.');
    receipt.wire = { endpoint: url.href, model: wire.model, reasoning: wire.reasoning, store: wire.store, stream: wire.stream,
      include: wire.include ?? [], inputMessages: wire.input.length, tools: wire.tools?.length ?? 0,
      fields: Object.keys(wire).sort(), prompt: request.input[0].content[0].text };
    receipt.inferenceHttpRequests++;
    const response = await originalFetch(input, options);
    receipt.http = { status: response.status, requestId: response.headers.get('x-request-id') };
    if (!response.ok) {
      const text = await response.clone().text();
      try { const body = JSON.parse(text); receipt.http.error = errorFacts(body.error ?? body); }
      catch { receipt.http.error = { code: null, message: redact(text) }; }
    }
    return response;
  }
  // Token renewal is still performed by the existing market package. No bearer
  // credential, authorization header or OAuth response is inspected or recorded.
  return originalFetch(input, options);
};
const { loadMarketProviderModule } = await import('../src/fusion-market-provider.mjs');
const loaded = await loadMarketProviderModule({ packageDir: join(stateDir, 'extensions', 'node_modules', 'cortico-provider-chatgpt') });
const entry = JSON.parse(await readFile(join(stateDir, 'providers', 'chatgpt-acceptance', 'config.json'), 'utf8'));
const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const instance = loaded.module.create('chatgpt-acceptance', entry, { stateDir: join(stateDir, 'providers', 'chatgpt-acceptance'),
  readBlob: () => null, keepThinking: () => true, log, currentEntry: () => entry });
const saveAttempts = attempts => {
  receipt.attempts = (attempts ?? []).map(attempt => ({ id: attempt.id, ordinal: attempt.ordinal, purpose: attempt.purpose,
    status: attempt.status, outcome: attempt.outcome, elapsedMs: attempt.elapsedMs,
    requestId: attempt.requestId, responseId: attempt.responseId,
    meters: Object.fromEntries(['input', 'output', 'total', 'cachedInput', 'uncachedInput', 'reasoning'].map(key => [key, attempt.meters?.[key] ?? null])) }));
};
try {
  if (!instance.control.status().signedIn) throw new Error('The original market endpoint is not signed in.');
  const generation = await instance.client.respond(request, { diagnostic: true,
    onEvent(event) {
      if (event.type === 'response.created' || ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
        const facts = { event: event.type, response: responseFacts(event.response) };
        receipt.outcomes.push(facts);
        if (event.type !== 'response.created') receipt.terminal = facts;
      }
    },
  });
  receipt.returnedResponse = responseFacts(generation.response);
  receipt.apiAccepted = generation.response.status === 'completed' && receipt.http?.status === 200;
  receipt.returnedEffortConfirmed = generation.response.reasoning?.effort === 'ultra';
  receipt.outputText = generation.response.output.filter(item => item.type === 'message')
    .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
  saveAttempts(generation.attempts);
} catch (error) {
  receipt.failure = { name: error.name, code: error.code ?? null, status: error.status ?? null, message: redact(error.message) };
  if (error.partial) receipt.partial = responseFacts(error.partial);
  saveAttempts(error.attempts);
} finally {
  await instance.stop?.(); loaded.dispose(); globalThis.fetch = originalFetch;
  receipt.finishedAt = new Date().toISOString();
  await mkdir(dirname(resultFile), { recursive: true });
  await writeFile(resultFile, JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify({ resultFile, apiAccepted: receipt.apiAccepted,
  returnedEffortConfirmed: receipt.returnedEffortConfirmed, inferenceHttpRequests: receipt.inferenceHttpRequests,
  codexUltraOrchestrationValidated: false }, null, 2));
