import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { pressureUsageOf } from '../lib/types/pressure-usage.js';
import { contextPressureProjectionDefinition as pressure, tokenUsageProjectionDefinition as billing } from '../lib/types/usage-projection.js';
import TokenMeter from '../lib/index.js';

const require = createRequire(pathToFileURL(resolve('runtime/dsh-0.1.5-rc.2/package.json')));
const load = async name => import(pathToFileURL(require.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, createMessage } = await load('@deepseek-ai/dsh-llm');
const { default: SessionStore, Session, SessionId } = await load('@deepseek-ai/dsh-session');
const { default: ProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection');
const total = { inputTokens: 3000, outputTokens: 60, cacheReadTokens: 1000, cacheWriteTokens: 0 };
const response = lastRequestUsage => ({ kind: 'cortico-response-v1', lastRequestUsage });
const known = { basis: 'last-provider-attempt', input: 1200, output: 20, cachedInput: 200 };
const event = (last, usage = total) => ({ type: 'assistant/message', data: {
  turn: 1, step: 1, stream: [], usage, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'fixture', model: 'fixture', replayState: { response: response(last) } } },
} });

test('last request drives pressure; billing still counts all attempts', () => {
  const e = event(known);
  assert.deepEqual(pressureUsageOf(e, total), { inputTokens: 1200, outputTokens: 20 });
  const ps = pressure.apply(pressure.init(), e);
  assert.equal(ps.pressureTokens, 1200);
  const bs = billing.apply(billing.init(), e);
  assert.equal(bs.totals.uncachedInputTokens, 3000);
  assert.equal(bs.totals.cacheReadTokens, 1000);
  assert.equal(bs.totals.outputTokens, 60);
});

test('unknown last attempt clears pressure instead of reusing totals or prior sample', () => {
  let s = pressure.apply(pressure.init(), event(known));
  s = pressure.apply(s, event({ basis: 'last-provider-attempt', input: null, output: null }));
  assert.equal(s.pressureTokens, undefined);
  assert.equal(s.sampledSurfaceTokens, undefined);
  assert.equal(pressureUsageOf(event({ basis: 'no-generation-attempt', input: 1200, output: 20 }), total), undefined);
  const interrupted = { type: 'assistant/message', data: { interrupted: true, stream: [], usage: total, message: { source: {} } } };
  assert.equal(pressureUsageOf(interrupted, total), undefined);
});

test('failed attempt reads last-request metadata from durable finish chunk', () => {
  const e = { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [
    { type: 'chunk', chunk: { type: 'usage', usage: total } },
    { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' }, replayState: { response: { kind: 'cortico-attempts-v1', lastRequestUsage: known } } } },
  ] } };
  assert.equal(pressure.apply(pressure.init(), e).pressureTokens, 1200);
  assert.equal(billing.apply(billing.init(), e).totals.uncachedInputTokens, 3000);
  assert.equal(pressureUsageOf({ type: 'assistant/attempt', data: { stream: [] } }, total), undefined);
});

test('ordinary providers keep their existing per-request samples', () => {
  const e = event(known);
  delete e.data.message.source.replayState;
  assert.equal(pressureUsageOf(e, total), total);
  assert.equal(pressure.apply(pressure.init(), e).pressureTokens, 4000);
});

test('projected prompt pressure includes only the head change since sampling', () => {
  const oldMessage = createMessage({ role: 'user', content: [{ type: 'text', text: 'old head' }], source: { kind: 'user' } });
  const newMessage = createMessage({ role: 'user', content: [{ type: 'text', text: 'new head '.repeat(20) }], source: { kind: 'user' } });
  let s = pressure.apply(pressure.init(), { type: 'request/context', data: { requestHead: { messages: [oldMessage] } } });
  s = pressure.apply(s, event(known));
  s = pressure.apply(s, { type: 'request/context', data: { requestHead: { messages: [newMessage] } } });
  const view = pressure.wire.view(s);
  assert.equal(view.projectedTokens, 1200 + s.headTokens - s.sampledHeadTokens);
});

test('actual bundled TokenMeter uses last request anchor and preserves projected billing', () => {
  const ctx = new Context();
  new LlmRuntime(ctx); new SessionStore(ctx); new ProjectionRegistry(ctx); new TokenMeter(ctx);
  assert.equal(TokenMeter.requestHeadAccountingVersion, 1);
  assert.equal(ctx.tokenMeter.requestHeadAccountingVersion, 1);
  const session = Session.create(SessionId('pressure-overlay-fixture'));
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' });
  session.append('request/context', {});
  const message = createMessage(event(known).data.message);
  session.append('assistant/message', { turn: 1, step: 1, message, stream: [], usage: total }, { surfaceOp: 'append' });
  const measurement = ctx.tokenMeter.measure(session);
  assert.equal(measurement.totalTokens, 1220);
  const usage = ctx.sessionProjections.stateOf(session, 'tokenUsage');
  assert.equal(usage.totals.uncachedInputTokens, 3000);
  assert.equal(usage.totals.cacheReadTokens, 1000);
  const projection = ctx.sessionProjections.stateOf(session, 'contextPressure');
  assert.equal(projection.pressureTokens, 1200);
});

test('actual bundled TokenMeter estimates when last output or last input is unknown', () => {
  const ctx = new Context();
  new LlmRuntime(ctx); new SessionStore(ctx); new ProjectionRegistry(ctx); new TokenMeter(ctx);
  const session = Session.create(SessionId('pressure-overlay-unknown'));
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' });
  const message = createMessage(event({ ...known, output: null }).data.message);
  session.append('assistant/message', { turn: 1, step: 1, message, stream: [], usage: total }, { surfaceOp: 'append' });
  assert.ok(ctx.tokenMeter.measure(session).totalTokens < 1000);
  assert.equal(ctx.sessionProjections.stateOf(session, 'contextPressure').pressureTokens, 1200);
});

test('effective request accounts for changed head once, including removal', () => {
  const ctx = new Context();
  new LlmRuntime(ctx); new SessionStore(ctx); new ProjectionRegistry(ctx); new TokenMeter(ctx);
  const session = Session.create(SessionId('pressure-overlay-head'));
  const oldMessage = createMessage({ role: 'user', content: [{ type: 'text', text: 'old head text' }], source: { kind: 'user' } });
  const newMessage = createMessage({ role: 'user', content: [{ type: 'text', text: 'new head content '.repeat(30) }], source: { kind: 'user' } });
  const oldHead = { sessionId: session.id, messages: [oldMessage] };
  const newHead = { sessionId: session.id, messages: [newMessage] };
  const oldCost = ctx.tokenMeter.estimateMessage(oldMessage), newCost = ctx.tokenMeter.estimateMessage(newMessage);
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' });
  session.append('request/context', { requestHead: oldHead });
  session.append('assistant/message', { turn: 1, step: 1, message: createMessage(event(known).data.message), stream: [], usage: total }, { surfaceOp: 'append' });
  const same = ctx.tokenMeter.measure(session, undefined, { requestContext: { requestHead: oldHead } });
  assert.equal(same.baseline.kind, 'usage');
  assert.equal(same.totalTokens, 1220);
  assert.equal(same.headDeltaTokens, 0);
  const changed = ctx.tokenMeter.measure(session, undefined, { requestContext: { requestHead: newHead } });
  assert.equal(changed.totalTokens, 1220 + newCost - oldCost);
  const removed = ctx.tokenMeter.measure(session, undefined, { requestContext: {} });
  assert.equal(removed.totalTokens, 1220 - oldCost);
  assert.equal(removed.headDeltaTokens, -oldCost);
});

test('old logs with no request/context use full current-head estimation', () => {
  const ctx = new Context();
  new LlmRuntime(ctx); new SessionStore(ctx); new ProjectionRegistry(ctx); new TokenMeter(ctx);
  const session = Session.create(SessionId('pressure-overlay-old'));
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' });
  session.append('assistant/message', { turn: 1, step: 1, message: createMessage(event(known).data.message), stream: [], usage: total }, { surfaceOp: 'append' });
  const head = createMessage({ role: 'user', content: [{ type: 'text', text: 'current head' }], source: { kind: 'user' } });
  const measurement = ctx.tokenMeter.measure(session, undefined, { requestContext: { requestHead: { sessionId: session.id, messages: [head] } } });
  assert.equal(measurement.baseline.kind, 'estimated');
  assert.equal(measurement.headDeltaTokens, ctx.tokenMeter.estimateMessage(head));
  assert.ok(measurement.totalTokens < 1000);
});

test('provider anchor smaller than estimated old head falls back when head is removed', () => {
  const ctx = new Context();
  new LlmRuntime(ctx); new SessionStore(ctx); new ProjectionRegistry(ctx); new TokenMeter(ctx);
  const session = Session.create(SessionId('pressure-overlay-large-old-head'));
  const oldHead = createMessage({ role: 'user', content: [{ type: 'text', text: 'large historical head '.repeat(1000) }], source: { kind: 'user' } });
  const surface = createMessage({ role: 'user', content: [{ type: 'text', text: 'persistent current surface' }], source: { kind: 'user' } });
  session.append('turn/start', { turn: 1 });
  session.append('user/message', surface, { surfaceOp: 'append' });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' });
  session.append('request/context', { requestHead: { sessionId: session.id, messages: [oldHead] } });
  session.append('assistant/message', { turn: 1, step: 1, message: createMessage(event(known).data.message), stream: [], usage: total }, { surfaceOp: 'append' });
  const measurement = ctx.tokenMeter.measure(session, undefined, { requestContext: {} });
  assert.equal(measurement.baseline.kind, 'estimated');
  assert.ok(measurement.surfaceTokens > 0);
  assert.ok(measurement.totalTokens >= measurement.surfaceTokens);
  assert.equal(measurement.headTokens, 0);
});
