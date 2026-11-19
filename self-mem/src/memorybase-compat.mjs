import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const nonempty = (value, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw fail('INVALID_INPUT', `${field} must be nonempty text`);
  return value;
};
// Foundation sorts JSON keys lexically, including numeric-looking keys. A
// JSON.stringify replacer would re-order those keys and break existing IDs.
export function foundationCanonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(foundationCanonical).join(',') + ']';
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + foundationCanonical(value[key])).join(',') + '}';
  throw fail('INVALID_JSON', 'Only finite JSON data is accepted');
}
export const foundationSourceId = (eventId, instance = 'tina-main', ownerId = 'local-owner') =>
  'legacy-foundation:event:' + hash(foundationCanonical([instance, ownerId, eventId]));

export function foundationInput(batch, raw) {
  const conversationId = nonempty(batch.conversationId, 'conversationId');
  const sourceSystem = nonempty(batch.sourceSystem ?? 'manual', 'sourceSystem');
  const deviceId = nonempty(batch.deviceId ?? 'local', 'deviceId');
  const epoch = nonempty(batch.epoch ?? '1', 'epoch');
  const original = JSON.parse(foundationCanonical(raw));
  const content = typeof raw.text === 'string' ? raw.text : raw.content;
  if (typeof content !== 'string') throw fail('INVALID_INPUT', 'Message text must be a string');
  const role = nonempty(raw.role, 'message.role');
  const messageId = nonempty(raw.id ?? hash(foundationCanonical({ original, conversationId })), 'message.id');
  const revision = raw.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) throw fail('INVALID_INPUT', 'revision must be a positive integer');
  const sourceTimestamp = raw.createdAt ?? raw.timestamp ?? null;
  const occurredAt = sourceTimestamp === null || sourceTimestamp === '' ? null
    : typeof sourceTimestamp === 'number' ? sourceTimestamp : Date.parse(sourceTimestamp);
  if (occurredAt !== null && (!Number.isSafeInteger(occurredAt) || occurredAt < 0)) throw fail('INVALID_INPUT', 'Invalid timestamp');
  const input = { source: { system: sourceSystem, deviceId, streamId: conversationId, epoch, eventId: messageId },
    revision, scope: 'tina-memory-base', type: 'message', channel: 'conversation',
    payload: { text: content, role, sourceTimestamp, original,
      authority: raw.authority ?? (role === 'user' ? 'direct_user_statement' : 'assistant_report') } };
  if (typeof raw.reasoning === 'string' && raw.reasoning) input.payload.reasoning = raw.reasoning;
  if (occurredAt !== null) input.occurredAt = occurredAt;
  const body = foundationCanonical(input);
  return { input, body, fingerprint: hash(body), eventId: 'evt_' + hash(foundationCanonical({ source: input.source, revision })) };
}

function sourceView(record) {
  const row = record.original?.row;
  if (record.original?.format !== 'foundation-event-row/1' || !row) return { ...record, id: record.sourceId, text: record.content };
  const input = typeof row.body === 'string' ? JSON.parse(row.body) : row.body;
  if (hash(foundationCanonical(input.payload)) !== row.payload_hash) throw fail('SOURCE_READBACK_MISMATCH', 'Stored original checksum differs', 500);
  return { id: row.event_id, text: input.payload.text, role: input.payload.role, authority: input.payload.authority ?? null,
    reasoning: input.payload.reasoning ?? null, original: input.payload.original, createdAt: input.occurredAt ?? null,
    receivedAt: row.recorded_at, source: input.source, revision: input.revision, contentHash: row.payload_hash,
    conversationId: input.source.streamId, sourceSystem: input.source.system, ref: 'src:' + record.sourceId };
}

/** Legacy HTTP identity/receipt adapter over the Persona's one SharedGitMem authority. */
export function createMemoryBaseCompat({ mem, instance = 'tina-main', ownerId = 'local-owner', onRefresh, clock = Date.now } = {}) {
  if (!mem?.shared || typeof mem.shared.appendSources !== 'function') throw fail('MEMORY_CAPABILITY_UNAVAILABLE', 'Atomic source-batch service is required');
  let tail = Promise.resolve(), stopping = false;
  const serialize = work => { const next = tail.catch(() => {}).then(work); tail = next; return next; };
  async function importConversation(batch) {
    if (batch.draft) throw fail('MEMORY_CAPABILITY_UNAVAILABLE', 'Legacy semantic drafts require an explicit Persona workflow; no job was queued', 409);
    if (!Array.isArray(batch.messages) || !batch.messages.length || batch.messages.length > 1000) throw fail('INVALID_INPUT', 'Import expects 1..1000 messages');
    const normalized = batch.messages.map(raw => foundationInput(batch, raw));
    await mem.ensureReady();
    const prepared = new Map();
    for (const row of normalized) {
      const sourceId = foundationSourceId(row.eventId, instance, ownerId);
      const duplicate = prepared.get(sourceId);
      if (duplicate && duplicate.meta.fingerprint !== row.fingerprint) throw fail('EVENT_CONFLICT', 'Source identity and revision already bind different content', 409);
      let existing;
      try { existing = await mem.shared.readSource(sourceId); } catch (error) { if (error.code !== 'SOURCE_NOT_FOUND') throw error; }
      if (existing) {
        const old = existing.original?.row;
        if (existing.original?.format !== 'foundation-event-row/1' || old?.fingerprint !== row.fingerprint
          || foundationCanonical(JSON.parse(old.body)) !== row.body) throw fail('EVENT_CONFLICT', 'Source identity and revision already bind different content', 409);
        continue;
      }
      if (duplicate) continue;
      const receivedAt = clock();
      const rawRow = { seq: null, owner_id: ownerId, event_id: row.eventId, scope: row.input.scope, body: row.body,
        payload_hash: hash(foundationCanonical(row.input.payload)), fingerprint: row.fingerprint, recorded_at: receivedAt };
      prepared.set(sourceId, { sourceId, kind: 'conversation', sourceSystem: row.input.source.system,
        deviceId: row.input.source.deviceId, agentId: instance, channel: row.input.source.system,
        sessionId: row.input.source.streamId, role: row.input.payload.role, content: row.input.payload.text,
        ...(row.input.payload.reasoning ? { reasoning: row.input.payload.reasoning } : {}),
        createdAt: new Date(row.input.occurredAt ?? receivedAt).toISOString(),
        original: { format: 'foundation-event-row/1', row: rawRow },
        meta: { legacyScope: rawRow.scope, legacyOwner: ownerId, legacyEventId: row.eventId, legacySequence: null,
          payloadHash: rawRow.payload_hash, fingerprint: row.fingerprint, importedAsHistorical: false, previouslyReadByCurrentSession: false } });
    }
    const committed = await mem.shared.appendSources([...prepared.values()], { sync: false });
    await mem.ensureReady();
    for (const row of normalized) sourceView(await mem.shared.readSource(foundationSourceId(row.eventId, instance, ownerId)));
    return { sourceIds: normalized.map(row => row.eventId), added: committed.added, jobIds: [],
      message: `已保存 ${committed.added} 条新原文；自主整理由当前 Persona 决定。`, backend: 'self-mem', semanticJobsQueued: false };
  }
  const readSource = async id => sourceView(await mem.readRef(id.startsWith('evt_')
    ? 'src:' + foundationSourceId(id, instance, ownerId) : id, { includeNeighbors: 0 }));
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw fail('PAYLOAD_TOO_LARGE', 'Import exceeds 8 MiB per request', 413); chunks.push(chunk); }
    try { return bytes ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { throw fail('INVALID_JSON', 'Invalid JSON body'); }
  }
  const server = createServer(async (req, res) => {
    try {
      if (stopping) throw fail('MEMORY_CLOSED', 'Memory ingress is closing', 503);
      const url = new URL(req.url, 'http://127.0.0.1');
      const queryFlag = (name) => {
        if (!url.searchParams.has(name)) return undefined;
        return ['1', 'true', 'yes', 'on'].includes(String(url.searchParams.get(name)).toLowerCase());
      };
      const systemBlockArgs = ({ defaultAgent = instance, includeSeed, includeGuide, includeLedger, includePulse, includeFooter } = {}) => ({
        sessionId: url.searchParams.get('sessionId') || null,
        sourceSessionId: url.searchParams.get('sourceSessionId') ?? url.searchParams.get('sessionId'),
        channel: url.searchParams.get('channel') || null,
        agentId: url.searchParams.get('agentId') || defaultAgent,
        forceRefresh: ['1', 'true'].includes(String(url.searchParams.get('refresh')).toLowerCase()),
        includeSeed: queryFlag('includeSeed') ?? includeSeed,
        includeGuide: queryFlag('includeGuide') ?? includeGuide,
        includeLedger: queryFlag('includeLedger') ?? includeLedger,
        includePulse: queryFlag('includePulse') ?? includePulse,
        includeFooter: queryFlag('includeFooter') ?? includeFooter,
        ledgerAgentId: url.searchParams.get('ledgerAgentId') || '',
      });
      if (req.method === 'GET' && ['/api/health', '/v1/health'].includes(url.pathname)) return json(res, 200, { status: 'ok', ok: true, backend: 'self-mem', processing: false,
        modelConfigured: false, capabilities: { import: true, sources_search: { route: 'api/sources/search', method: 'POST' }, semantic_jobs: false, legacy_review: false },
        ...(await mem.stats()) });
      if (req.method === 'GET' && (url.pathname === '/v1/self' || url.pathname === '/api/system-block')) {
        const defaults = url.pathname === '/api/system-block' ? { includeGuide: true, includeLedger: true } : {};
        return json(res, 200, await mem.getSystemBlock(systemBlockArgs(defaults)));
      }
      if (req.method === 'GET' && (url.pathname === '/v1/tail' || url.pathname === '/api/tail-block')) {
        return json(res, 200, await mem.getTailBlock({
          agentId: url.searchParams.get('agentId') || instance,
          sourceSessionId: url.searchParams.get('sourceSessionId') ?? url.searchParams.get('sessionId') ?? null,
          channel: url.searchParams.get('channel') || null,
          pulseLimit: url.searchParams.has('pulseLimit') ? Number(url.searchParams.get('pulseLimit')) : undefined,
          includePulse: queryFlag('includePulse') ?? true,
          includeFooter: queryFlag('includeFooter') ?? true,
          includeLedger: queryFlag('includeLedger') ?? false,
          ledgerAgentId: url.searchParams.get('ledgerAgentId') || '',
          extraFooter: url.searchParams.get('extraFooter') || '',
        }));
      }
      if (req.method === 'GET' && url.pathname === '/v1/self/raw') {
        return json(res, 200, await mem.readSelfRaw());
      }
      if (req.method === 'POST' && url.pathname === '/v1/self/patch') {
        const payload = await body(req);
        return json(res, 200, await serialize(() => mem.patchSelf(payload)));
      }
      if (req.method === 'GET' && (url.pathname === '/v1/ledger' || url.pathname === '/api/ledger')) {
        return json(res, 200, await mem.readLedger({
          agentId: url.searchParams.get('agentId') || instance,
          targetAgentId: url.searchParams.get('targetAgentId') || '',
          includeGuide: queryFlag('includeGuide') ?? false,
          includeSeed: queryFlag('includeSeed') ?? false,
        }));
      }
      if (req.method === 'POST' && (url.pathname === '/v1/ledger' || url.pathname === '/v1/ledger/patch' || url.pathname === '/api/ledger')) {
        const payload = await body(req);
        if ((payload.action || payload.mode || 'read') === 'read' && !payload.newText && !payload.content && !payload.text) {
          return json(res, 200, await mem.readLedger(payload));
        }
        return json(res, 200, await serialize(() => mem.patchLedger(payload)));
      }
      if (req.method === 'POST' && url.pathname === '/v1/search') {
        const payload = await body(req);
        return json(res, 200, await mem.search(payload));
      }
      if (req.method === 'GET' && url.pathname === '/v1/read') {
        return json(res, 200, await mem.readRef(url.searchParams.get('ref') || '', {
          includeNeighbors: Number(url.searchParams.get('includeNeighbors') ?? 2),
          offset: Number(url.searchParams.get('offset') ?? 0),
          limit: Number(url.searchParams.get('limit') ?? 16000),
        }));
      }
      if (req.method === 'POST' && url.pathname === '/v1/note') {
        const payload = await body(req);
        return json(res, 200, await serialize(() => mem.writeNote(payload)));
      }
      if (req.method === 'POST' && url.pathname === '/v1/sources/ingest') {
        const payload = await body(req);
        if (Array.isArray(payload.sources)) {
          return json(res, 200, await serialize(() => mem.ingestBatch(payload.sources, { sync: payload.sync !== false })));
        }
        return json(res, 200, await serialize(() => mem.ingestSource(payload, { sync: payload.sync !== false })));
      }
      if (req.method === 'POST' && url.pathname === '/v1/sync') {
        const payload = await body(req);
        return json(res, 200, await serialize(() => mem.sync({ pull: payload.pull !== false, push: payload.push !== false })));
      }
      if (req.method === 'POST' && ['/api/import', '/api/turn'].includes(url.pathname)) return json(res, 201, await serialize(() => body(req).then(importConversation)));
      if (req.method === 'GET' && url.pathname.startsWith('/api/sources/')) return json(res, 200, { source: await readSource(decodeURIComponent(url.pathname.slice('/api/sources/'.length))) });
      if (req.method === 'POST' && ['/api/search', '/api/sources/search'].includes(url.pathname)) {
        const input = await body(req);
        return json(res, 200, { ...await mem.search({ ...input, scope: url.pathname === '/api/sources/search' ? 'raw' : input.scope ?? 'all' }), backend: 'self-mem' });
      }
      if (req.method === 'POST' && url.pathname === '/api/context') {
        const input = await body(req);
        const snapshot = await mem.getSystemBlock({ sessionId: input.sessionId ?? null, sourceSessionId: input.sessionId ?? null,
          agentId: input.agentId ?? instance, forceRefresh: input.refresh === true,
          includeSeed: input.includeSeed, includeGuide: input.includeGuide, includeLedger: input.includeLedger,
          includePulse: input.includePulse, includeFooter: input.includeFooter, ledgerAgentId: input.ledgerAgentId ?? '' });
        const hostRefresh = input.refresh && onRefresh ? await onRefresh() : null;
        return json(res, 200, { ...snapshot, sessionId: input.sessionId ?? null, hostRefresh, backend: 'self-mem' });
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') return json(res, 200, {
        ...await mem.stats(), self: await mem.readSelfRaw(), matters: [], jobs: [], decisions: [], sourceGroups: [],
        settings: { autoProcess: false, modelConfigured: false }, backend: 'self-mem', legacyReview: false });
      if (url.pathname === '/' && req.method === 'GET') return json(res, 200, { service: 'Self-Mem memory ingress',
        backend: 'one Persona authority', tools: ['mem_search', 'mem_read', 'mem_note', 'mem_ledger', 'self_memory_read', 'self_memory_patch'],
        notice: '原文采集与读取接口已迁入 Self-Mem。旧语义作业和审阅界面未运行；人格和画布由融合宿主的 System 工作台管理。' });
      if (url.pathname.startsWith('/api/')) throw fail('MEMORY_CAPABILITY_UNAVAILABLE', 'This legacy semantic/review operation is not mounted; no change was made', 409);
      json(res, 404, { code: 'NOT_FOUND' });
    } catch (error) { json(res, error.status ?? (['NOT_FOUND', 'SOURCE_NOT_FOUND'].includes(error.code) ? 404 : 400),
      { code: error.code ?? 'MEMORY_REQUEST_FAILED', error: error.status ? error.message : 'Memory request failed; inspect the local host log.' }); }
  });
  return { server, importConversation: batch => serialize(() => importConversation(batch)), readSource,
    async listen(port = 8895, host = '127.0.0.1') {
      if (!['127.0.0.1', '::1'].includes(host)) throw fail('UNSAFE_MEMORY_BIND', 'Authenticated gateway owns remote access; ingress must use loopback');
      await new Promise((ok, no) => { server.once('error', no); server.listen(port, host, ok); });
      return server.address();
    },
    async close() { stopping = true; const closing = new Promise(resolve => server.close(resolve)); await tail.catch(() => {}); await closing; },
  };
}
