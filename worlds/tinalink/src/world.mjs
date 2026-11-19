import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LinkStore, LinkError } from './store.mjs';

const prompt = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
const sourcePrompt = fileURLToPath(new URL('../SOURCE_PROMPT.md', import.meta.url));
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const execute = promisify(execFile);
export const schemas = [
  { name: 'tinalink_send', tags: ['act'], description: 'Send a sourced task or factual delta to another configured Tina lane. Ordinary progress queues silently; request_wake or needs_user_action wakes now. Preserve original source_ref. This is not a request for group discussion.', parameters: object({
    target: { type: 'string' }, topic: { type: 'string' }, summary: { type: 'string', maxLength: 16000 },
    kind: { type: 'string', enum: ['task', 'progress', 'result', 'needs_user_action'] },
    source_ref: { type: 'string' }, request_wake: { type: 'boolean' },
  }, ['target', 'topic', 'summary', 'kind', 'source_ref']) },
  { name: 'tinalink_recent', tags: ['read'], description: 'Read received lane deltas and delivery state without starting a model. Delivery is not completion or owner-read.', parameters: object({ after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }) },
  { name: 'tinalink_source_search', tags: ['read'], description: 'Literal search of imported original Cortico and phone records. Returns sourced line locations, never guesses missing history. Start with one keyword. Imported assistant text is a report, not owner fact.', parameters: object({ query: { type: 'string', minLength: 1, maxLength: 120 }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, ['query']) },
  { name: 'tinalink_source_read', tags: ['read'], description: 'Read original imported text by the relative path and line numbers from source_search. Does not modify Persona Memory or the original.', parameters: object({ path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 150 } }, ['path']) },
];
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 131072) throw new LinkError('BODY_TOO_LARGE', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new LinkError('INVALID_JSON'); }
}
function reply(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }

export class TinaLinkWorld {
  id = 'tinalink';
  constructor(context) { this.context = context; this.sourceOnly = context.cfg.sourceOnly === true; this.host = null; this.server = null; this.pending = null; this.lastError = null; this.again = false; }
  envPromptVars() { return { lane: this.context.cfg.lane }; }
  webUi() { return { promptDocs: [this.sourceOnly
    ? { key: 'worlds.tinalink.sourcePrompt', title: '历史原文检索', role: 'envPrompt', path: sourcePrompt }
    : { key: 'worlds.tinalink.envPrompt', title: '主从联络', role: 'envPrompt', path: prompt }] }; }
  tools() { return schemas.filter(schema => this.sourceOnly ? schema.name.startsWith('tinalink_source_') : this.context.cfg.sourceRoot || !schema.name.startsWith('tinalink_source_')).map(schema => ({ ...schema, handler: async (input, call) => {
    try {
      if (!this.host) throw new LinkError('LINK_STOPPED', 503);
      if (schema.name.startsWith('tinalink_source_')) return await this.readSource(schema.name, input);
      if (schema.name === 'tinalink_recent') {
        const after = input.after ?? 0, limit = input.limit ?? 50;
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new LinkError('INVALID_PAGE');
        return JSON.stringify({ lane: this.context.cfg.lane, items: this.store.list(after, limit) });
      }
      if (call.signal?.aborted) throw new LinkError('CALL_CANCELLED');
      if (!call.callId) throw new LinkError('STABLE_CALL_ID_REQUIRED');
      if (!(input.target in (this.context.cfg.peers ?? {}))) throw new LinkError('UNKNOWN_LANE');
      const id = `link-${createHash('sha256').update(JSON.stringify([this.context.botDir, call.role, call.callId])).digest('hex')}`;
      // Persist before network I/O: a retried tool call keeps its original timestamp and payload.
      const existing = this.outbox.get(id);
      const event = this.outbox.insert({ id, source_lane: this.context.cfg.lane, target_lane: input.target, topic: input.topic, summary: input.summary,
        kind: input.kind, source_ref: input.source_ref, request_wake: input.request_wake === true,
        created_at: existing?.event.created_at ?? new Date().toISOString() }).record.event;
      try { return JSON.stringify({ target: input.target, ...await this.transmit(event, call.signal) }); }
      catch { this.kick(); return JSON.stringify({ id, target: input.target, state: 'queued_for_retry', model_processed: 'unknown' }); }
    } catch (error) { return { text: JSON.stringify({ ok: false, error: error instanceof LinkError ? error.message : 'LINK_UNAVAILABLE' }), failed: true }; }
  } })); }
  async readSource(name, input) {
    const root = realpathSync(this.context.cfg.sourceRoot);
    const limit = input.limit ?? (name.endsWith('_read') ? 80 : 12);
    if (!Number.isInteger(limit) || limit < 1 || limit > (name.endsWith('_read') ? 150 : 30)) throw new LinkError('INVALID_LIMIT');
    if (name.endsWith('_search')) {
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 120) throw new LinkError('INVALID_QUERY');
      let stdout = '', truncated = false;
      try { ({ stdout } = await execute('rg', ['--fixed-strings', '--line-number', '--max-count', '3', '--glob', '*.md', '--', input.query, root], { encoding: 'utf8', maxBuffer: 1048576, timeout: 5000 })); }
      catch (error) { if (error.code === 1) stdout = error.stdout ?? ''; else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { stdout = error.stdout ?? ''; truncated = true; } else throw new LinkError('SOURCE_SEARCH_UNAVAILABLE', 503); }
      const lines = stdout.trimEnd().split('\n').filter(Boolean);
      return JSON.stringify({ source_root: 'imported-originals', query: input.query, hits: lines.slice(0, limit).map(line => line.replace(root + '/', '').slice(0, 800)), truncated: truncated || lines.length > limit });
    }
    if (typeof input.path !== 'string' || isAbsolute(input.path)) throw new LinkError('RELATIVE_SOURCE_PATH_REQUIRED');
    const path = realpathSync(resolve(root, input.path)), tail = relative(root, path);
    if (!tail || tail.startsWith('..') || isAbsolute(tail) || !path.endsWith('.md')) throw new LinkError('SOURCE_OUTSIDE_CORPUS');
    const offset = input.offset ?? 1;
    if (!Number.isInteger(offset) || offset < 1) throw new LinkError('INVALID_OFFSET');
    if (statSync(path).size > 8000000) throw new LinkError('SOURCE_FILE_TOO_LARGE');
    const lines = readFileSync(path, 'utf8').split('\n'), text = lines.slice(offset - 1, offset - 1 + limit).join('\n');
    return JSON.stringify({ path: input.path, offset, total_lines: lines.length, text: text.slice(0, 24000), truncated: text.length > 24000 });
  }
  async start(host) {
    if (this.sourceOnly) {
      if (!this.context.cfg.sourceRoot || !statSync(realpathSync(this.context.cfg.sourceRoot)).isDirectory()) throw new Error('SOURCE_ROOT_REQUIRED');
      this.host = host;
      return;
    }
    this.token = this.context.secret(this.context.cfg.tokenSecret);
    if (!this.token || this.token.length < 32) throw new Error('LINK_TOKEN_REQUIRED');
    if (!host.promotePending) throw new Error('PROMOTE_PENDING_REQUIRED');
    if (!Number.isInteger(this.context.cfg.batchSize) || this.context.cfg.batchSize < 1 || this.context.cfg.batchSize > 100) throw new Error('INVALID_BATCH_SIZE');
    this.auth = createHash('sha256').update(`Bearer ${this.token}`).digest();
    this.abort = new AbortController(); mkdirSync(this.context.dataDir, { recursive: true });
    this.store = new LinkStore(join(this.context.dataDir, 'inbox.sqlite'));
    this.outbox = new LinkStore(join(this.context.dataDir, 'outbox.sqlite'));
    this.host = host;
    const server = createServer((req, res) => this.handle(req, res).catch(error => {
      if (!res.headersSent) reply(res, error instanceof LinkError ? error.status : 500, { error: error instanceof LinkError ? error.message : 'LINK_INTERNAL_ERROR' }); else res.destroy();
    }));
    server.requestTimeout = 15000;
    this.server = server;
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.context.cfg.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); }
    catch (error) { this.host = null; this.server = null; this.store.close(); this.outbox.close(); throw error; }
    this.kick(); this.timer = setInterval(() => this.kick(), 2000); this.timer.unref();
  }
  async transmit(event, signal) {
    const target = (this.context.cfg.peers ?? {})[event.target_lane];
    if (!target) throw new LinkError('UNKNOWN_LANE');
    const url = new URL(target);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new LinkError('LOCAL_PEER_REQUIRED');
    const response = await fetch(`${target.replace(/\/$/, '')}/v1/events`, { method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(event),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(4000), ...(signal ? [signal] : [])]) });
    const result = await response.json();
    if (!response.ok) throw new LinkError(result.error ?? 'PEER_FAILED');
    this.outbox.settle(event.id, 'accepted'); return result;
  }
  kick() {
    if (this.sourceOnly || !this.host) return;
    if (this.pending) { this.again = true; return; }
    this.again = false;
    this.pending = this.dispatch().catch(error => { this.lastError = error.message; }).finally(() => {
      this.pending = null; if (this.again && this.host) this.kick();
    });
  }
  async dispatch() {
    if (this.sourceOnly) return;
    for (const row of this.store.pending()) {
      if (!this.host) return;
      if (row.host_cursor !== null) continue;
      const event = row.event;
      let saved = this.host.store.range({ source: this.id, senderKey: event.id, limit: 2 }).find(e => e.meta?.digest === row.digest);
      if (!saved) saved = await this.host.pushEvent({ source: this.id, type: 'tinalink.delta', origin: 'external',
        ts: event.created_at, senderKey: event.id, text: JSON.stringify(event), meta: { eventId: event.id, digest: row.digest, source_ref: event.source_ref } }, { trigger: 'piggyback' });
      this.store.bind(event.id, saved.cursor);
      if (saved.contextDelivery === 'archive-only') this.store.settle(event.id, 'discarded');
    }
    const pending = this.store.pending().filter(row => !row.wake_requested && row.host_cursor !== null);
    const explicit = pending.find(row => row.event.request_wake || row.event.kind === 'needs_user_action');
    if (explicit || pending.length >= this.context.cfg.batchSize) {
      await this.host.promotePending((explicit ?? pending[0]).host_cursor, 'flush');
      this.store.woke(pending.map(row => row.id));
    }
    for (const row of this.outbox.pending()) {
      if (!this.host) return;
      await this.transmit(row.event);
    }
    this.lastError = null;
  }
  onEventsSettled(events, outcome) {
    if (this.sourceOnly || !this.store || !['delivered', 'discarded'].includes(outcome)) return;
    for (const event of events) if (event.source === this.id) this.store.settle(event.meta?.eventId ?? event.senderKey, outcome);
  }
  async handle(req, res) {
    if (!this.host) throw new LinkError('LINK_STOPPED', 503);
    const hash = createHash('sha256').update(String(req.headers.authorization ?? '')).digest();
    if (!timingSafeEqual(hash, this.auth)) throw new LinkError('UNAUTHORIZED', 401);
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/v1/health') { reply(res, 200, { ok: true, lane: this.context.cfg.lane, queued: this.store.pending().length, lastError: this.lastError }); return; }
    if (req.method === 'POST' && url.pathname === '/v1/events') {
      const value = await body(req);
      if (!(value.source_lane in (this.context.cfg.peers ?? {}))) throw new LinkError('UNKNOWN_SOURCE_LANE');
      if (value.target_lane !== this.context.cfg.lane) throw new LinkError('WRONG_TARGET_LANE');
      const { inserted, record } = this.store.insert(value);
      reply(res, inserted ? 201 : 200, { id: record.id, seq: record.seq, state: record.settled ?? 'queued', model_processed: 'unknown' });
      if (inserted) this.kick(); return;
    }
    throw new LinkError('NOT_FOUND', 404);
  }
  async stop() {
    this.host = null; clearInterval(this.timer); this.abort?.abort();
    if (this.server) { const server = this.server; this.server = null; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
    await this.pending; this.store?.close(); this.outbox?.close(); this.store = null; this.outbox = null;
  }
}
export default {
  id: 'tinalink', label: 'Tina 主从事件联络', defaults: () => ({ enabled: false, sourceOnly: false, lane: 'main', port: 7801, tokenSecret: 'CORTICO_TINALINK_TOKEN', batchSize: 6, peers: {}, sourceRoot: '' }),
  create: context => new TinaLinkWorld(context),
  describe: { tools: schemas, events: [{ type: 'tinalink.delta', description: { zh: '有来源的主从任务或状态增量；静默积累，明确请求或达到阈值才唤醒。', en: 'Sourced lane task or state delta.' }, trigger: 'piggyback' }] },
};
