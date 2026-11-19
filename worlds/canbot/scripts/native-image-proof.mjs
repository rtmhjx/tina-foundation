// Version-specific Cortico 0.2.8 probe. No live bot is started and no model is called.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CanbotWorld } from '../src/world.mjs';
import { CANBOT_DEFAULTS } from '../src/config.mjs';

const [frameworkArg, botArg, imageArg, reportArg] = process.argv.slice(2);
if (!reportArg) throw new Error('Usage: native-image-proof.mjs FRAMEWORK_DIR BOT_ENTRY SAMPLE_JPEG REPORT_JSON');
const framework = resolve(frameworkArg), load = path => import(pathToFileURL(join(framework, path)).href);
const { registerFrameworkResolver } = await load('src/extensions/runtime.ts');
registerFrameworkResolver();
const { default: bot } = await import(pathToFileURL(resolve(botArg)).href);
const { MainLoop } = await load('src/core/loop.ts');
const { SessionLog } = await load('src/core/session.ts');
const { LogBlobStore, withBlobLines } = await load('src/core/blobs.ts');
const { JsonlEventStore } = await load('src/core/event-store.ts');
const { CoreState } = await load('src/core/state.ts');
const { WakeBus } = await load('src/core/bus.ts');
const { nullLogger } = await load('src/core/util.ts');
const { responsesInput } = await load('src/providers/transport/responses-input.ts');

const scratch = await mkdtemp(join(framework, 'scratch/canbot-native-image-'));
const config = bot.defaults();
const parts = bot.build({ config, secret: () => '', rootDir: scratch,
  memoryDir: join(scratch, 'workspace'), dataDir: join(scratch, 'data') }, []);
const sessions = parts.persona.declareSessions(), main = sessions.find(session => session.receivesEvents);
assert.equal(sessions.filter(session => session.receivesEvents).length, 1);
assert.ok(main.eventDelivery === undefined || main.eventDelivery === 'tool', 'Main must keep external tool delivery');
const blobStore = new LogBlobStore(scratch), store = new JsonlEventStore({ dataDir: scratch, run: 'canbot-native-image-proof' });
const session = new SessionLog(scratch), state = new CoreState(scratch); state.load();
const bus = new WakeBus(config.batching), log = nullLogger();
const intern = inputs => inputs?.map(input => ({ handle: blobStore.put(input.bytes, input.mime), mime: input.mime,
  name: input.name, fallbackText: input.fallbackText }));
const events = [], jpeg = await readFile(resolve(imageArg)), sha256 = createHash('sha256').update(jpeg).digest('hex');
const world = new CanbotWorld({ cfg: { ...CANBOT_DEFAULTS, headEnabled: true, headUplinkBind: '127.0.0.1', headUplinkPort: 0 },
  avatarToken: () => 'a'.repeat(64), mediaToken: () => 'b'.repeat(64) });
world.head.capture = async () => ({ receipt: { operationId: 'fixture-photo', state: 'complete', settled: true }, sha256,
  blobs: [{ bytes: new Uint8Array(jpeg), mime: 'image/jpeg', name: 'fixture.jpg', fallbackText: 'CANBOT local test image' }] });
world.lifecycle = new AbortController();
world.host = { log, pushEvent: async (event, options) => {
  const refs = intern(event.blobs);
  const saved = store.append({ ...event, text: withBlobLines(event.text, refs), blobs: refs });
  events.push(saved); bus.push({ event: saved }, options); return saved;
} };
const loop = new MainLoop({ cfg: config, decl: main, persona: {}, spec: () => ({ model: 'fixture-vision' }),
  llm: { respond() { throw new Error('No model request is permitted in this probe'); } },
  context: { hardTokens: () => null, estimateTokens: () => 0, contextOverflow: () => false },
  blobs: { intern }, worlds: { all: () => [world], visible: () => [world] }, bus, session, store, state, log });
try {
  const receipt = await world.tools().find(tool => tool.name === 'canbot_capture').handler({ kind: 'photo' }, {});
  assert.equal(receipt.failed, undefined); assert.equal(receipt.blobs, undefined);
  assert.equal(events.length, 1); assert.equal(events[0].origin, 'external');
  assert.equal(events[0].source, 'canbot'); assert.equal(events[0].type, 'canbot.camera');
  // Isolate delivery from all Persona hooks and model execution; this is not a production API.
  assert.equal(await loop.deliverBatch([{ event: events[0] }], 0), true);
  assert.equal(session.records.length, 2);
  const [call, result] = session.records;
  assert.equal(call.item.type, 'function_call'); assert.equal(call.item.name, 'external_event_frame');
  assert.equal(result.item.type, 'function_call_output'); assert.equal(result.item.call_id, call.item.call_id);
  assert.equal(result.context.frame.events[0].source, 'canbot');
  assert.equal(session.records.some(record => record.item.role === 'user'), false);
  const media = { enabled: () => true, read: handle => blobStore.read(handle)?.bytes ?? null };
  const request = { model: 'fixture-vision', input: [] }, options = { context: session.records };
  const wire = responsesInput(request, options, { media }).input;
  const toolOutput = wire.filter(item => item.type === 'function_call_output');
  assert.equal(toolOutput.length, 1); assert.ok(Array.isArray(toolOutput[0].output));
  const images = toolOutput[0].output.filter(part => part.type === 'input_image'); assert.equal(images.length, 1);
  assert.deepEqual(Buffer.from(images[0].image_url.split(',')[1], 'base64'), jpeg);
  assert.equal(wire.some(item => item.role === 'user'), false);
  const textOnly = responsesInput(request, options, { media: { ...media, enabled: () => false } }).input;
  assert.equal(JSON.stringify(textOnly).includes('input_image'), false);
  assert.ok(JSON.stringify(textOnly).includes('CANBOT local test image'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const report = { ok: true, framework: '0.2.8', world: pkg.version, eventType: 'canbot.camera', eventOrigin: events[0].origin,
    eventDelivery: main.eventDelivery ?? 'tool (default)', syntheticToolName: call.item.name,
    responsesImageLocation: 'function_call_output.output', responsesImageParts: images.length, externalUserMessages: 0,
    duplicateToolImages: 0, originalBytesMatch: true, sha256, disabledMediaKeepsFallback: true, mainSessionId: main.id,
    actualUnmodifiedMainDeclarationUsed: true, receivingSessionCount: 1,
    otherSessionIds: sessions.filter(s => !s.receivesEvents).map(s => s.id),
    personaDeliveryHooksExercised: false, peripheralCapture: 'local_fixture', modelRequestSent: false,
    realDeviceUsed: false, liveDeploymentChanged: false, scratch };
  await writeFile(resolve(reportArg), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { loop.stop(); await world.stop(); store.close?.(); }
