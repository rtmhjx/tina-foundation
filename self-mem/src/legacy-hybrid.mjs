import { readFileSync, statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { VectorStore } from '../vendor/cwm027/vector-store.mjs';

const CHANNEL = 'legacy-memory:vector-memory';
const CACHE_SIZE = 8;
export const POOL_SCOPE = '__legacy_recall_pool__';
const fail = (code, message) => Object.assign(new Error(message), { code });

export function legacySnapshotIdentity(indexFile) {
  const stat = statSync(indexFile, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function vectorProblem(vector, dimensions) {
  if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) return 'invalidVector';
  if (!vector.length || (dimensions && vector.length !== dimensions)) return 'dimensionMismatch';
  let norm = 0;
  for (const number of vector) {
    if (typeof number !== 'number' || !Number.isFinite(number) || !Number.isFinite(Math.fround(number))) return 'nonFinite';
    norm += number * number;
  }
  return !Number.isFinite(norm) ? 'nonFinite' : norm === 0 ? 'zeroNorm' : null;
}

export function classifyLegacyVector(encoded, dimensions) {
  if (encoded === null || encoded === undefined || encoded === '') return 'absent';
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) return 'invalidBase64';
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length % 2 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return 'invalidBase64';
  if (dimensions && bytes.length / 2 !== dimensions) return 'dimensionMismatch';
  // All finite fp16 values are exactly representable in fp32. Check the bit
  // pattern without allocating a typed array for every vector component.
  let nonzero = false;
  for (let offset = 0; offset < bytes.length; offset += 2) {
    const bits = bytes[offset] | (bytes[offset + 1] << 8);
    if ((bits & 0x7c00) === 0x7c00) return 'nonFinite';
    if (bits & 0x7fff) nonzero = true;
  }
  return nonzero ? null : 'zeroNorm';
}

export function createLegacyRecallPool(rows, model) {
  const refs = Object.create(null);
  for (const row of rows) {
    (refs[row.scope] ??= []).push(row);
  }
  // Preserve upstream hybridSearchAll's scope enumeration and stable tie order.
  const ordered = Object.values(refs).flat();
  const data = { vectors: { [POOL_SCOPE]: ordered.map(row => ({ ...row.original, vector: row.vectorProblem ? null : row.original.vector })) }, model_name: model };
  const write = () => { throw new Error('Legacy recall snapshot is read-only'); };
  const backend = { kind: 'json', readJson: stem => stem === 'vector-memory' ? data : null, writeJson: write, removeJson: write, migrateFromJson: write, flush: write };
  return { store: new VectorStore('', backend), ordered };
}

export function loadLegacyRecallIndex(indexFile) {
  const identity = legacySnapshotIdentity(indexFile);
  const index = JSON.parse(readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, ''));
  if (legacySnapshotIdentity(indexFile) !== identity) throw fail('LEGACY_INDEX_STALE', 'Legacy index changed while loading; recreate the adapter.');
  if (index.format !== 'cwm-legacy-recall' || index.version !== 1 || !Array.isArray(index.rows)) throw new Error('Unsupported legacy recall index');
  const space = index.vectorSpace ?? {};
  const known = space.confirmed === true && typeof space.id === 'string' && !!space.id && typeof space.model === 'string' && !!space.model && Number.isSafeInteger(space.dimensions) && space.dimensions > 0;
  const excluded = {};
  const refs = new Set();
  const rows = index.rows.map(row => {
    if (typeof row.ref !== 'string' || !row.ref.startsWith('src:') || refs.has(row.ref) || typeof row.original?.text !== 'string') throw new Error('Legacy recall rows require distinct src refs and text');
    refs.add(row.ref);
    const problem = classifyLegacyVector(row.original.vector, space.dimensions);
    if (problem) excluded[problem] = (excluded[problem] ?? 0) + 1;
    return { ...row, scope: row.scope ?? 'main', agentId: row.agentId ?? index.instance, channel: row.channel ?? CHANNEL, vectorProblem: problem };
  });
  delete index.rows; // Keep metadata, but let close() release the original rows.
  return { index, space, known, rows, identity, stats: { totalRows: rows.length, validVectorRows: rows.filter(row => !row.vectorProblem).length, excludedVectors: excluded } };
}

/** Read-only cwm 0.2.7 ranking. Matrix warmup runs in a worker, never a promise
 * callback on the host thread. Runtime searches use BM25 until it is ready.
 * embedding: {url, model, vectorSpaceId, tokenEnv?, timeoutMs?}.
 */
export function createLegacyHybridRecall({ indexFile, embedding, fetchImpl = globalThis.fetch } = {}) {
  const { index, space, known, rows: originalRows, identity, stats } = loadLegacyRecallIndex(indexFile);
  // The host needs only text for immediate BM25. Vector bytes live in the worker.
  let rows = originalRows.map(row => ({ ...row, original: { text: row.original.text, vector: null } }));
  let all = createLegacyRecallPool(rows, space.model);
  let closed = false;
  const queryCache = new Map();
  let warmupState = known && stats.validVectorRows ? 'warming' : 'disabled';
  let worker = null, readyResolve, readyReject, sequence = 0, readyWaiters = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const assertCurrent = () => {
    let current;
    try { current = legacySnapshotIdentity(indexFile); } catch { current = null; }
    if (current !== identity) throw fail('LEGACY_INDEX_STALE', 'Legacy index changed or was removed; recreate the adapter/Bot to load the new snapshot.');
  };
  const status = () => ({ enabled: !closed, format: index.format, version: index.version, instance: index.instance, manifestSha256: index.manifestSha256, vectorSpace: { ...space }, vectorSpaceConfirmed: known, ...stats, excludedVectors: { ...stats.excludedVectors }, embeddingConfigured: !!embedding, cachedQueries: queryCache.size, warmupState });
  const updateRef = () => { if (readyWaiters || pending.size) worker?.ref(); else worker?.unref(); };
  const workerFailed = error => {
    if (closed) return;
    warmupState = 'failed'; readyReject(error);
    for (const task of pending.values()) task.reject(error);
    pending.clear(); updateRef();
  };
  if (warmupState === 'warming') {
    worker = new Worker(new URL('./legacy-hybrid-worker.mjs', import.meta.url), {
      workerData: { indexFile, identity }, execArgv: [],
    });
    worker.on('message', message => {
      if (closed) return;
      if (message.type === 'ready') { warmupState = 'ready'; readyResolve(); }
      else if (message.type === 'failed') workerFailed(fail(message.code ?? 'LEGACY_WORKER_FAILED', message.message));
      else if (message.type === 'result') {
        const task = pending.get(message.id); pending.delete(message.id);
        if (message.error) task?.reject(fail(message.error.code, message.error.message)); else task?.resolve(message.hits);
      }
      updateRef();
    });
    worker.on('error', workerFailed);
    worker.on('exit', code => { if (!closed) workerFailed(fail('LEGACY_WORKER_EXITED', `Legacy recall worker exited (${code})`)); });
    updateRef();
  } else readyResolve();
  const workerSearch = args => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject }); updateRef();
    worker.postMessage({ type: 'search', id, args });
  });

  async function search({ query = '', legacyScope, limit = 10, queryVector, vectorSpaceId, agentId, channel } = {}) {
    if (closed) throw new Error('Legacy recall is closed');
    assertCurrent();
    if (typeof query !== 'string' || !Number.isSafeInteger(limit) || limit < 1) throw new Error('query must be text and limit a positive integer');
    legacyScope ??= undefined; agentId ??= undefined; channel ??= undefined;
    const eligible = rows.filter(row => (legacyScope === undefined || row.scope === legacyScope) && (agentId === undefined || row.agentId === agentId) && (channel === undefined || row.channel === channel));
    const diagnostics = { ...stats, excludedVectors: { ...stats.excludedVectors }, mode: 'keyword', eligibleRows: eligible.length, vectorSpaceId: space.id ?? null, embeddingRequested: false, cacheHit: false, warmupState };
    let vector = null;
    if (!known) diagnostics.reason = 'vector_space_unconfirmed';
    else if (warmupState !== 'ready' && (queryVector !== undefined || embedding)) diagnostics.reason = warmupState === 'warming' ? 'matrix_warming' : warmupState === 'disabled' ? 'no_eligible_vectors' : 'matrix_failed';
    else if (queryVector !== undefined) {
      if (vectorSpaceId !== space.id) diagnostics.reason = 'query_space_mismatch';
      else {
        const problem = vectorProblem(queryVector, space.dimensions);
        if (problem) diagnostics.reason = `query_${problem}`;
        else vector = Array.from(queryVector);
      }
    } else if (!embedding) diagnostics.reason = 'query_embedding_not_configured';
    else if (embedding.vectorSpaceId !== space.id || embedding.model !== space.model || (vectorSpaceId !== undefined && vectorSpaceId !== space.id)) diagnostics.reason = 'embedding_space_mismatch';
    else if (!eligible.some(row => !row.vectorProblem)) diagnostics.reason = 'no_eligible_vectors';
    else if (!query.trim()) diagnostics.reason = 'empty_query';
    else if (queryCache.has(query)) {
      vector = queryCache.get(query);
      queryCache.delete(query);
      queryCache.set(query, vector);
      diagnostics.cacheHit = true;
    } else {
      const token = embedding.tokenEnv ? process.env[embedding.tokenEnv] : undefined;
      if (embedding.tokenEnv && !token) diagnostics.reason = 'embedding_token_unavailable';
      else if (!embedding.url || typeof fetchImpl !== 'function') diagnostics.reason = 'embedding_endpoint_missing';
      else {
        diagnostics.embeddingRequested = true;
        try {
          const response = await fetchImpl(embedding.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ model: embedding.model, input: query }),
            signal: AbortSignal.timeout(embedding.timeoutMs ?? 30000),
          });
          if (!response.ok) diagnostics.reason = `embedding_http_${response.status}`;
          else {
            const body = await response.json();
            const candidate = body.data?.[0]?.embedding;
            const problem = vectorProblem(candidate, space.dimensions);
            if (body.model && body.model !== space.model) diagnostics.reason = 'embedding_response_model_mismatch';
            else if (problem) diagnostics.reason = `embedding_${problem}`;
            else {
              vector = Array.from(candidate);
              queryCache.set(query, vector);
              if (queryCache.size > CACHE_SIZE) queryCache.delete(queryCache.keys().next().value);
            }
          }
        } catch {
          // Do not surface provider response bodies, URLs or credentials; no retries.
          diagnostics.reason = 'embedding_request_failed';
        }
      }
    }
    if (closed) throw new Error('Legacy recall is closed');
    assertCurrent();
    if (vector) {
      if (eligible.some(row => !row.vectorProblem)) diagnostics.mode = 'hybrid';
      else { vector = null; diagnostics.reason = 'no_eligible_vectors'; }
    }
    let hits;
    if (vector) hits = await workerSearch({ query, queryVector: vector, legacyScope, agentId, channel, limit });
    else {
      const view = eligible.length === rows.length ? all : createLegacyRecallPool(eligible, space.model);
      hits = legacyHits(view, view.store.hybridSearch(POOL_SCOPE, query, null, limit));
    }
    assertCurrent();
    return { hits, diagnostics };
  }

  return { search, status,
    async awaitReady() {
      if (closed) throw new Error('Legacy recall is closed');
      assertCurrent(); readyWaiters++; updateRef();
      try { await ready; assertCurrent(); return status(); }
      finally { readyWaiters--; updateRef(); }
    },
    async close() {
      if (closed) return;
      closed = true; warmupState = 'closed';
      const error = fail('LEGACY_RECALL_CLOSED', 'Legacy recall is closed');
      readyReject(error);
      for (const task of pending.values()) task.reject(error);
      pending.clear(); queryCache.clear(); rows = []; all = null;
      if (worker) { await worker.terminate(); worker = null; }
    },
  };
}

export function legacyHits(view, ranked) {
  return ranked.map(hit => {
    const row = view.ordered[hit.legacyIndex];
    return { ref: row.ref, citation: `[${row.ref}]`, text: hit.text, content: hit.text, snippet: hit.text.slice(0, 240), score: hit.score, via: hit.via, scope: row.scope, agentId: row.agentId, channel: row.channel };
  });
}
