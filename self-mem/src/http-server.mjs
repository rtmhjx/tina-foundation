#!/usr/bin/env node
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TinaSelfMem } from './core.mjs';

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE', status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { resolveBody({}); return; }
      try { resolveBody(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { code: 'INVALID_JSON', status: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

export function createSelfMemHttpServer({
  mem,
  dataDir,
  authorityDir,
  deviceDir,
  maxSelfChars = 16000,
  legacyRecall = null,
  token = process.env.TINA_SELF_MEM_TOKEN || '',
} = {}) {
  const ownsMem = !mem;
  const store = mem || new TinaSelfMem({
    ...(authorityDir && deviceDir
      ? { authorityDir: resolve(authorityDir), deviceDir: resolve(deviceDir) }
      : { dataDir: resolve(dataDir) }),
    maxSelfChars,
    legacyRecall,
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Valid Bearer token required' });
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const path = url.pathname;
      const queryFlag = (name) => (url.searchParams.has(name)
        ? ['1', 'true', 'yes', 'on'].includes(String(url.searchParams.get(name)).toLowerCase())
        : undefined);
      const systemBlockArgs = ({ defaultAgent = 'http-agent', includeSeed, includeGuide, includeLedger, includePulse, includeFooter } = {}) => ({
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

      if (req.method === 'GET' && path === '/v1/stats') {
        sendJson(res, 200, await store.stats({
          excludeAgent: url.searchParams.get('excludeAgent') || null,
          excludeSession: url.searchParams.get('excludeSession') || null,
          excludeChannel: url.searchParams.get('excludeChannel') || null,
        }));
        return;
      }
      if (req.method === 'GET' && (path === '/v1/self' || path === '/api/system-block')) {
        // The dedicated /api endpoint exposes the ledger/guide by default for
        // out-of-process agents; /v1/self keeps its historical defaults.
        const defaults = path === '/api/system-block' ? { includeGuide: true, includeLedger: true } : {};
        sendJson(res, 200, await store.getSystemBlock(systemBlockArgs(defaults)));
        return;
      }
      if (req.method === 'GET' && (path === '/v1/tail' || path === '/api/tail-block')) {
        sendJson(res, 200, await store.getTailBlock({
          agentId: url.searchParams.get('agentId') || 'http-agent',
          sourceSessionId: url.searchParams.get('sourceSessionId') ?? url.searchParams.get('sessionId') ?? null,
          channel: url.searchParams.get('channel') || null,
          pulseLimit: url.searchParams.has('pulseLimit') ? Number(url.searchParams.get('pulseLimit')) : undefined,
          includePulse: queryFlag('includePulse') ?? true,
          includeFooter: queryFlag('includeFooter') ?? true,
          includeLedger: queryFlag('includeLedger') ?? false,
          ledgerAgentId: url.searchParams.get('ledgerAgentId') || '',
          extraFooter: url.searchParams.get('extraFooter') || '',
        }));
        return;
      }
      if ((path === '/v1/ledger' || path === '/api/ledger') && (req.method === 'GET' || req.method === 'POST')) {
        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        const agentId = body.agentId || url.searchParams.get('agentId') || 'http-agent';
        const action = req.method === 'POST'
          ? String(body.action || body.mode || 'read').trim().toLowerCase()
          : 'read';
        if (action === 'read') {
          sendJson(res, 200, await store.readLedger({ agentId }));
          return;
        }
        if (!['replace', 'append'].includes(action)) {
          sendJson(res, 400, { error: 'INVALID_ACTION', message: 'action must be read, replace, or append' });
          return;
        }
        sendJson(res, 200, await store.patchLedger({
          agentId,
          mode: action,
          oldText: body.oldText ?? '',
          newText: body.newText ?? '',
          summary: body.summary ?? '',
          expectedRevision: body.expectedRevision ?? '',
          reason: body.reason || 'http_ledger_patch',
        }));
        return;
      }
      if (req.method === 'POST' && path === '/v1/self/refresh') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await store.refreshSession(body.sessionId || null, {
          agentId: body.agentId || 'http-agent', sourceSessionId: body.sourceSessionId ?? body.sessionId,
          channel: body.channel || null,
        }));
        return;
      }
      if (req.method === 'POST' && path === '/v1/self/patch') {
        sendJson(res, 200, await store.patchSelf(await readJsonBody(req)));
        return;
      }
      if (req.method === 'POST' && path === '/v1/sources') {
        const body = await readJsonBody(req);
        if (Array.isArray(body.items)) {
          const receipts = [];
          for (const it of body.items) receipts.push(await store.ingestSource(it));
          sendJson(res, 200, { count: receipts.length, receipts });
        } else {
          sendJson(res, 200, await store.ingestSource(body));
        }
        return;
      }
      if (req.method === 'POST' && path === '/v1/notes') {
        sendJson(res, 200, await store.addNote(await readJsonBody(req)));
        return;
      }
      if (req.method === 'GET' && path === '/v1/search') {
        sendJson(res, 200, await store.search({
          query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? '',
          scope: url.searchParams.get('scope') || 'all',
          retrieval: url.searchParams.get('retrieval') || 'auto',
          legacyScope: url.searchParams.get('legacyScope'),
          includeReasoning: ['1', 'true'].includes(url.searchParams.get('includeReasoning')),
          limit: Number(url.searchParams.get('limit') || 12),
          agentId: url.searchParams.get('agentId') || null,
          channel: url.searchParams.get('channel') || null,
        }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/read') {
        sendJson(res, 200, await store.readRef(url.searchParams.get('ref') || '', {
          includeNeighbors: Number(url.searchParams.get('includeNeighbors') ?? 3),
          includeReasoning: !['0', 'false'].includes(url.searchParams.get('includeReasoning')),
          rev: url.searchParams.get('rev') || 'HEAD',
        }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/history') {
        sendJson(res, 200, { history: await store.history(Number(url.searchParams.get('limit') || 20)) });
        return;
      }
      if (req.method === 'POST' && path === '/v1/rollback') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await store.rollback(body.commit, body));
        return;
      }

      sendJson(res, 404, { error: 'NOT_FOUND', message: `Unknown route: ${req.method} ${path}` });
    } catch (err) {
      const status = err.status || (err.code === 'NOT_FOUND' ? 404
        : ['SELF_MEMORY_FULL', 'SELF_CANVAS_CONFLICT', 'OPERATION_CONFLICT', 'LEDGER_FULL', 'LEDGER_REVISION_CONFLICT'].includes(err.code) ? 409
        : err.code === 'UNVERIFIED_SOURCE_REF' ? 422 : 400);
      sendJson(res, status, { error: err.code || 'BAD_REQUEST', message: err.message });
    }
  });

  return {
    server,
    mem: store,
    async listen(port = 8896, host = '127.0.0.1') {
      await new Promise((res, rej) => { server.once('error', rej); server.listen(port, host, res); });
      const addr = server.address();
      return { host: addr.address, port: addr.port, url: `http://${addr.address}:${addr.port}` };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((res) => server.close(() => res()));
      if (ownsMem) await store.close();
    },
  };
}

export class RemoteTinaSelfMemClient {
  constructor({ baseUrl, token = '' } = {}) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async _req(method, path, body) {
    const headers = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { code: data.error || 'HTTP_ERROR' });
    return data;
  }

  async stats({ excludeAgent = '', excludeSession = '', excludeChannel = '' } = {}) {
    const qs = new URLSearchParams({
      ...(excludeAgent ? { excludeAgent } : {}),
      ...(excludeSession ? { excludeSession } : {}),
      ...(excludeChannel ? { excludeChannel } : {}),
    });
    return await this._req('GET', `/v1/stats${qs.size ? `?${qs}` : ''}`);
  }
  async readSelfRaw() { return (await this._req('GET', '/v1/read?ref=TINA_SELF.md')).content; }
  async getSystemBlock({
    sessionId = '', sourceSessionId = sessionId, channel = '', agentId = 'remote', forceRefresh = false,
    includeSeed, includeGuide, includeLedger, includePulse, includeFooter, ledgerAgentId = '',
  } = {}) {
    const qs = new URLSearchParams({ agentId, ...(sessionId ? { sessionId } : {}),
      ...(sourceSessionId ? { sourceSessionId } : {}), ...(channel ? { channel } : {}),
      ...(ledgerAgentId ? { ledgerAgentId } : {}), ...(forceRefresh ? { refresh: '1' } : {}) });
    for (const [key, value] of [
      ['includeSeed', includeSeed],
      ['includeGuide', includeGuide],
      ['includeLedger', includeLedger],
      ['includePulse', includePulse],
      ['includeFooter', includeFooter],
    ]) {
      if (value !== undefined) qs.set(key, String(Boolean(value)));
    }
    return await this._req('GET', `/v1/self?${qs}`);
  }
  async getTailBlock({
    agentId = 'remote', sourceSessionId = '', channel = '', pulseLimit,
    includePulse, includeFooter, includeLedger, ledgerAgentId = '', extraFooter = '',
  } = {}) {
    const qs = new URLSearchParams({
      agentId,
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(channel ? { channel } : {}),
      ...(pulseLimit !== undefined ? { pulseLimit: String(pulseLimit) } : {}),
      ...(ledgerAgentId ? { ledgerAgentId } : {}),
      ...(extraFooter ? { extraFooter } : {}),
    });
    for (const [key, value] of [
      ['includePulse', includePulse],
      ['includeFooter', includeFooter],
      ['includeLedger', includeLedger],
    ]) {
      if (value !== undefined) qs.set(key, String(Boolean(value)));
    }
    return await this._req('GET', `/v1/tail?${qs}`);
  }
  async refreshSession(sessionId, { agentId = 'remote', sourceSessionId = sessionId, channel = '' } = {}) {
    return await this._req('POST', '/v1/self/refresh', { sessionId, agentId, sourceSessionId, channel });
  }
  async readLedger({ agentId = 'remote' } = {}) {
    return await this._req('GET', `/v1/ledger?${new URLSearchParams({ agentId })}`);
  }
  async patchLedger({
    agentId = 'remote', mode = 'replace', oldText = '', newText = '', summary = '',
    expectedRevision = '', reason = 'agent_ledger_patch',
  } = {}) {
    return await this._req('POST', '/v1/ledger', {
      agentId, action: mode, oldText, newText, summary, expectedRevision, reason,
    });
  }
  async patchSelf(args) { return await this._req('POST', '/v1/self/patch', args); }
  async ingestSource(args) { return await this._req('POST', '/v1/sources', args); }
  async addNote(args) { return await this._req('POST', '/v1/notes', args); }
  async search({ query = '', scope = 'all', includeReasoning = false, limit = 12, agentId = '', channel = '', retrieval = 'auto', legacyScope = null } = {}) {
    const qs = new URLSearchParams({
      q: query,
      scope,
      includeReasoning: String(includeReasoning),
      limit: String(limit),
      retrieval,
      ...(legacyScope !== null ? { legacyScope } : {}),
      ...(agentId ? { agentId } : {}),
      ...(channel ? { channel } : {}),
    });
    return await this._req('GET', `/v1/search?${qs}`);
  }
  async readRef(ref, { includeNeighbors = 3, includeReasoning = true, rev = 'HEAD' } = {}) {
    const qs = new URLSearchParams({ ref, includeNeighbors: String(includeNeighbors), includeReasoning: String(includeReasoning), rev });
    return await this._req('GET', `/v1/read?${qs}`);
  }
  async history(limit = 20) { return (await this._req('GET', `/v1/history?limit=${limit}`)).history; }
  async rollback(commit, opts = {}) { return await this._req('POST', '/v1/rollback', { commit, ...opts }); }
  async close() {}
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();
if (isMain) {
  const opt = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  const dataDir = opt('--dir') || process.env.TINA_SELF_MEM_DIR || join(homedir(), '.tina-self-mem');
  const authorityDir = opt('--authority-dir') || process.env.TINA_AUTHORITY_DIR || '';
  const deviceDir = opt('--device-dir') || process.env.TINA_DEVICE_DIR || '';
  const token = opt('--token') || process.env.TINA_SELF_MEM_TOKEN || '';
  const port = Number(opt('--port') || process.env.TINA_SELF_MEM_PORT || 8896);
  const host = opt('--host') || '127.0.0.1';
  createSelfMemHttpServer({
    ...(authorityDir && deviceDir ? { authorityDir, deviceDir } : { dataDir }),
    token,
  }).listen(port, host).then((info) => {
    console.log(`[tina-self-mem] HTTP server listening on ${info.url} (dir=${resolve(authorityDir || dataDir)})`);
  });
}
