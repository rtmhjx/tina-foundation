import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MobileError, MobileStore } from './store.mjs';

const promptPath = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
export const toolSchemas = [
  { name: 'mobile_reply', tags: ['speak'], description: 'Send this reply to a phone message. Supply its exact device_id and message_id as in_reply_to. A durable send is not proof the phone or owner read it.',
    parameters: object({ device_id: { type: 'string' }, in_reply_to: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 32000 } }, ['device_id', 'in_reply_to', 'text']) },
  { name: 'mobile_send_media', tags: ['speak'], description: 'Send an existing image or audio blob handle to the phone. The attachment must exist; do not invent one.',
    parameters: object({ device_id: { type: 'string' }, in_reply_to: { type: 'string' }, handle: { type: 'string' }, text: { type: 'string', maxLength: 32000 } }, ['device_id', 'in_reply_to', 'handle']) },
  { name: 'mobile_status', tags: ['read'], description: 'Read mobile channel and delivery state without waking another model. delivered means in the Cortico session, not human-read.',
    parameters: object({ device_id: { type: 'string' } }) },
];
const MEDIA_LIMIT = 8 * 1024 * 1024;
const MEDIA_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav']);

function text(value, name, max = 32000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MobileError(`INVALID_${name.toUpperCase()}`);
  return value;
}
function messageInput(body, fact = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MobileError('JSON_OBJECT_REQUIRED');
  const input = { id: text(body.id, 'id', 160), device_id: text(body.device_id, 'device_id', 128),
    text: text(body.text, 'text'), created_at: text(body.created_at, 'created_at', 80) };
  if (!Number.isFinite(Date.parse(input.created_at))) throw new MobileError('INVALID_CREATED_AT');
  if (fact) input.source_ref = text(body.source_ref, 'source_ref', 4096);
  return input;
}
async function readJson(req, limit = 262144) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new MobileError('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new MobileError('INVALID_JSON'); }
}
function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

/** Cortico World API 6. No other service, LLM, API key or transcript reader is created. */
export class TinaMobileWorld {
  id = 'mobile';
  constructor(context) { this.context = context; this.host = null; this.store = null; this.server = null; this.pending = null; this.dispatchRequested = false; this.lastError = null; }
  envPromptVars() { return {}; }
  webUi() { return { promptDocs: [{ key: 'worlds.mobile.envPrompt', title: 'Tina 手机通道', description: '手机输入、持久回复与来源事实通道的使用约定。', role: 'envPrompt', path: promptPath }] }; }
  tools() {
    return toolSchemas.map(schema => ({ ...schema, handler: async (input, call) => {
      try {
        if (!this.store || !this.host) throw new MobileError('MOBILE_STOPPED', 503);
        if (schema.name === 'mobile_status') {
          const device = input.device_id === undefined ? undefined : text(input.device_id, 'device_id', 128);
          return JSON.stringify({ ...this.store.status(device), listening: this.address(), last_error: this.lastError });
        }
        if (call.signal?.aborted) throw new MobileError('CALL_CANCELLED');
        if (!call.callId) throw new MobileError('STABLE_CALL_ID_REQUIRED');
        const device = text(input.device_id, 'device_id', 128);
        const sourceId = text(input.in_reply_to, 'in_reply_to', 160);
        const source = this.store.get(sourceId);
        if (!source || source.kind !== 'user_message' || source.device_id !== device) throw new MobileError('PHONE_MESSAGE_NOT_FOUND', 404);
        const replyId = `reply-${createHash('sha256').update(JSON.stringify([this.context.botDir, call.role, call.callId])).digest('hex')}`;
        let sourceRef, mediaPayload, messageText = input.text;
        if (schema.name === 'mobile_send_media') {
          const attachment = this.host.blob(text(input.handle, 'handle', 512));
          if (!attachment) throw new MobileError('BLOB_NOT_FOUND', 404);
          const bytes = Buffer.from(attachment.bytes);
          if (!MEDIA_MIMES.has(attachment.mime) || bytes.length < 1 || bytes.length > MEDIA_LIMIT) throw new MobileError('MEDIA_UNSUPPORTED');
          mediaPayload = { mime: attachment.mime, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
          sourceRef = `coo-media:${replyId}`;
          messageText = typeof input.text === 'string' && input.text.trim() ? input.text : (attachment.mime.startsWith('image/') ? '[图片]' : '[语音]');
        }
        const existing = this.store.get(replyId);
        const reply = { id: replyId, device_id: device, text: text(messageText, 'text'), source_ref: sourceRef,
          in_reply_to: sourceId, created_at: existing?.created_at ?? new Date().toISOString() };
        const { record } = mediaPayload ? this.store.insertMedia(reply, 'assistant_message', mediaPayload.mime, mediaPayload.sha256, mediaPayload.bytes)
          : this.store.insert(reply, 'assistant_message');
        return JSON.stringify({ id: record.id, server_seq: record.server_seq, state: 'queued_for_phone', phone_read: 'unknown' });
      } catch (error) {
        return { text: JSON.stringify({ ok: false, error: error instanceof MobileError ? error.message : 'MOBILE_INTERNAL_ERROR' }), failed: true };
      }
    } }));
  }
  address() {
    const address = this.server?.address();
    return address && typeof address === 'object' ? { host: address.address, port: address.port } : null;
  }
  async start(host) {
    if (this.server) throw new Error('MOBILE_ALREADY_STARTED');
    const token = this.context.secret(this.context.cfg.tokenSecret);
    if (!token) throw new Error('MOBILE_TOKEN_SECRET_REQUIRED');
    this.tokenHash = createHash('sha256').update(`Bearer ${token}`).digest();
    const dataDir = this.context.dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.store = new MobileStore(join(dataDir, 'mobile.sqlite'));
    this.host = host; this.lastError = null; this.dispatchRequested = false;
    const server = createServer((req, res) => {
      this.handle(req, res).catch(error => {
        if (!res.headersSent) send(res, error instanceof MobileError ? error.status : 500,
          { error: error instanceof MobileError ? error.message : 'MOBILE_INTERNAL_ERROR' });
        else res.destroy();
      });
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.context.cfg.port, this.context.cfg.host, () => { server.off('error', reject); resolve(); });
      });
    } catch (error) {
      this.server = null; this.host = null; this.store.close(); this.store = null; throw error;
    }
    server.on('error', error => { this.lastError = error.code ?? 'HTTP_SERVER_ERROR'; });
    this.kick();
    this.timer = setInterval(() => this.kick(), 2000); this.timer.unref();
  }
  async stop() {
    const server = this.server; this.server = null;
    this.dispatchRequested = false;
    clearInterval(this.timer);
    const close = server ? new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) : Promise.resolve();
    await this.pending; await close;
    this.host = null; this.store?.close(); this.store = null; this.tokenHash = null;
  }
  kick() {
    if (!this.server || !this.host) return;
    if (this.pending) { this.dispatchRequested = true; return; }
    this.dispatchRequested = false;
    this.pending = this.dispatch().catch(error => { this.lastError = error.code ?? 'EVENT_DISPATCH_FAILED'; })
      .finally(() => {
        this.pending = null;
        // Coalesce arrivals during an awaited push. Failed rows alone do not cause a retry loop.
        if (this.dispatchRequested && this.server && this.host) this.kick();
      });
  }
  async dispatch() {
    for (const record of this.store.pending()) {
      if (!this.server || !this.host) break;
      let event = this.host.store.range({ source: this.id, senderKey: record.id, limit: 2 }).find(item =>
        item.type === 'mobile.message' && item.meta?.device_id === record.device_id && item.meta?.message_id === record.id);
      const media = record.source_ref?.startsWith('coo-media:') ? this.store.getMedia(record.id) : null;
      if (!event) event = await this.host.pushEvent({ source: this.id, type: 'mobile.message', origin: 'external',
        ts: record.created_at, senderKey: record.id,
        text: `[手机输入 device_id=${JSON.stringify(record.device_id)} message_id=${JSON.stringify(record.id)}]\n${record.text}`,
        meta: { device_id: record.device_id, message_id: record.id },
        ...(media ? { blobs: [{ bytes: Buffer.from(media.data), mime: media.mime, name: 'phone-media', fallbackText: '手机媒体；无法读取时不要猜测内容。' }] } : {}) }, { trigger: 'flush' });
      this.store.setHostCursor(record.id, event.cursor);
      if (event.contextDelivery === 'archive-only') this.store.settle(record.id, 'discarded', '通道隐藏，仅归档未进入对话');
    }
    this.lastError = null;
  }
  onEventsSettled(events, outcome) {
    if (!this.store || !['delivered', 'discarded'].includes(outcome)) return;
    for (const event of events) {
      if (event.source === this.id && event.type === 'mobile.message') this.store.settle(event.meta?.message_id ?? event.senderKey, outcome);
    }
  }
  async handle(req, res) {
    if (!this.server || !this.store) throw new MobileError('MOBILE_STOPPED', 503);
    const auth = createHash('sha256').update(String(req.headers.authorization ?? '')).digest();
    if (!timingSafeEqual(auth, this.tokenHash)) throw new MobileError('UNAUTHORIZED', 401);
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      send(res, 200, { protocol: 'tina-mobile/1', server_id: this.store.serverId, ok: true, media: true, media_metadata: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/media') {
      const body = await readJson(req, 12 * 1024 * 1024), input = messageInput(body), mime = text(body.mime, 'mime', 100);
      if (!MEDIA_MIMES.has(mime) || typeof body.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) throw new MobileError('MEDIA_UNSUPPORTED');
      const bytes = Buffer.from(body.data, 'base64');
      if (!bytes.length || bytes.length > MEDIA_LIMIT) throw new MobileError('MEDIA_TOO_LARGE', 413);
      const sha = createHash('sha256').update(bytes).digest('hex'); if (sha !== body.sha256) throw new MobileError('MEDIA_HASH_MISMATCH');
      input.source_ref = `coo-media:${input.id}`;
      const result = this.store.insertMedia(input, 'user_message', mime, sha, bytes);
      send(res, result.inserted ? 201 : 200, this.store.ack(result.record)); if (result.inserted) this.kick(); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/media') {
      const id = text(url.searchParams.get('id'), 'id', 160), device = text(url.searchParams.get('device_id'), 'device_id', 128);
      const info = this.store.getMediaInfo(id), record = this.store.get(id);
      if (!info || !record || info.device_id !== device || record.device_id !== device || record.source_ref !== `coo-media:${id}`) throw new MobileError('MEDIA_NOT_FOUND', 404);
      if (url.searchParams.get('metadata') === '1') { send(res, 200, { id, device_id: device, mime: info.mime, sha256: info.sha256, size: info.size }); return; }
      const media = this.store.getMedia(id);
      send(res, 200, { id, device_id: device, mime: media.mime, sha256: media.sha256, data: Buffer.from(media.data).toString('base64') }); return;
    }
    if (req.method === 'POST' && ['/v1/messages', '/v1/facts'].includes(url.pathname)) {
      const fact = url.pathname === '/v1/facts';
      const input = messageInput(await readJson(req), fact);
      const result = this.store.insert(input, fact ? 'fact' : 'user_message');
      send(res, result.inserted ? 201 : 200, fact ? { id: input.id, state: 'stored', server_seq: result.record.server_seq } : this.store.ack(result.record));
      if (!fact && result.inserted) this.kick();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/feed') {
      const device = text(url.searchParams.get('device_id'), 'device_id', 128);
      const after = Number(url.searchParams.get('after') ?? 0), limit = Number(url.searchParams.get('limit') ?? 100);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MobileError('INVALID_PAGINATION');
      send(res, 200, this.store.feed(device, after, limit)); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/source') {
      const id = text(url.searchParams.get('id'), 'id', 160), record = this.store.get(id);
      if (!record) throw new MobileError('SOURCE_NOT_FOUND', 404);
      send(res, 200, { server_id: this.store.serverId, record, external_source_retrieved: false }); return;
    }
    throw new MobileError('NOT_FOUND', 404);
  }
}

export default {
  id: 'mobile', label: 'Tina 手机通道',
  defaults: () => ({ enabled: false, host: '127.0.0.1', port: 7799, tokenSecret: 'TINA_MOBILE_TOKEN' }),
  create: context => new TinaMobileWorld(context),
  describe: { tools: toolSchemas, events: [{ type: 'mobile.message', description: { zh: '手机原始输入，保留设备与消息来源。', en: 'Original phone input with device and message identity.' }, trigger: 'flush' }] },
};
