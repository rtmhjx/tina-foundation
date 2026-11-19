import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { checkedImportPath, createJsonlConnector } from './connectors.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const required = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value; };

/** Every native record is archived. Only actual dialogue text enters extraction. */
export function normalizeNativeRecord(record, context) {
  const event = context.format === 'dsh' && record.event ? record.event : record;
  let message = null, timestamp, id, reasoningItem = null;
  if (context.format === 'codex') {
    id = record.payload?.id ? `${record.type}:${record.payload.type ?? 'record'}:${record.payload.id}` : `record:${context.line}`;
    timestamp = record.timestamp;
    if (record.type === 'response_item' && record.payload?.type === 'message' && ['user', 'assistant'].includes(record.payload.role)) message = record.payload;
    if (record.type === 'response_item' && record.payload?.type === 'reasoning') reasoningItem = record.payload;
  } else if (context.format === 'dsh') {
    id = Number.isSafeInteger(event.seq) ? `seq:${event.seq}` : `record:${context.line}`;
    timestamp = event.time;
    if (event.type === 'user/message' && (!event.data?.source?.kind || event.data.source.kind === 'user')) message = { ...event.data, role: 'user' };
    if (event.type === 'assistant/message') message = { ...event.data?.message, role: 'assistant' };
  } else {
    const candidate = record.message && typeof record.message === 'object' ? record.message : record;
    id = record.id ?? record.uuid ?? candidate.id ?? `record:${context.line}`;
    timestamp = record.timestamp ?? record.createdAt ?? candidate.timestamp ?? candidate.createdAt;
    if (['user', 'assistant'].includes(candidate.role)) message = candidate;
  }
  const result = { id, role: message?.role ?? 'trace', text: '', authority: message ? (message.role === 'user' ? 'source_user_message' : 'assistant_report') : 'native_event_record',
    rawLineBase64: context.originalLineBase64, originalRecord: record };
  if (timestamp !== undefined) result.createdAt = timestamp;
  if (message) {
    result.text = typeof message.text === 'string' ? message.text : typeof message.content === 'string' ? message.content
      : (message.content ?? []).filter(part => ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string').map(part => part.text).join('\n');
    const analysis = message.role === 'assistant' && message.channel === 'analysis';
    const observedReasoning = [
      analysis ? result.text : '',
      typeof message.reasoning === 'string' ? message.reasoning : '',
      typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
      ...(Array.isArray(message.content) ? message.content : [])
        .filter(part => ['thinking', 'reasoning', 'reasoning_text'].includes(part.type))
        .map(part => part.thinking ?? part.text ?? ''),
    ].filter(value => typeof value === 'string' && value);
    if (analysis) { result.text = ''; result.authority = 'assistant_reasoning'; }
    if (context.includeReasoning && message.role === 'assistant' && observedReasoning.length) result.reasoning = observedReasoning.join('\n');
    else if (!analysis && message.role === 'assistant' && typeof message.reasoning === 'string') result.reasoning = message.reasoning;
  } else if (reasoningItem && context.includeReasoning) {
    const observed = [...(reasoningItem.summary ?? []), ...(reasoningItem.content ?? [])]
      .map(part => part.text).filter(text => typeof text === 'string' && text);
    if (typeof reasoningItem.reasoning_text === 'string') observed.push(reasoningItem.reasoning_text);
    if (observed.length) { result.role = 'assistant'; result.authority = 'assistant_reasoning'; result.reasoning = observed.join('\n'); }
  }
  return result;
}

/** Delivery location is deliberately absent: source origin survives every copy. */
export function normalizeIntakeBatch(value) {
  if (value?.format !== 'tina-conversation-batch/1') throw new Error('Unknown conversation batch format');
  const origin = value.origin ?? {};
  const sourceSystem = required(origin.system, 'origin.system');
  const deviceId = required(origin.deviceId, 'origin.deviceId');
  const conversationId = required(origin.sessionId, 'origin.sessionId');
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 1000) throw new Error('Expected 1..1000 source messages');
  const messages = value.messages.map(message => {
    required(message.id, 'message.id'); required(message.role, 'message.role');
    if (typeof message.text !== 'string') throw new Error('message.text must be original text');
    return structuredClone(message);
  });
  return { sourceSystem, deviceId, conversationId, epoch: origin.epoch ?? '1', messages };
}

export function createHttpIntake({ endpoint, token, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  const url = new URL(required(endpoint, 'endpoint'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP endpoint without URL credentials');
  return { async ingestConversation(batch) {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(batch), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      // Do not echo an upstream body: it can contain source text or credentials.
      let body; try { body = await response.json(); } catch { /* Non-JSON errors are intentionally omitted. */ }
      const code = typeof body?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(body.code) ? body.code : 'IMPORT_HTTP_ERROR';
      const explanations = { PAYLOAD_TOO_LARGE: 'source exceeds the event byte budget', EVENT_CONFLICT: 'original identity already contains different bytes' };
      throw Object.assign(new Error(`Memory import returned HTTP ${response.status}${explanations[code] ? ': ' + explanations[code] : ''}`), { code, httpStatus: response.status });
    }
    const receipt = await response.json();
    if (!Array.isArray(receipt.sourceIds) || receipt.sourceIds.length !== batch.messages.length || !Number.isSafeInteger(receipt.added))
      throw new Error('Memory import did not return a complete source receipt');
    return receipt;
  } };
}

/** Oversized native records use existing source storage, not an external blob service.
 * Chunks are acknowledged before their manifest; retry IDs do not depend on bytes.
 */
export function createBoundedNativeIntake(sink, forceIds = new Set()) {
  const chunkBytes = 192 * 1024;
  return { async ingestConversation(batch) {
    const receipt = { sourceIds: [], added: 0, jobIds: [] };
    let pending = [];
    const flush = async () => {
      if (!pending.length) return;
      let result;
      try { result = await sink.ingestConversation({ ...batch, messages: pending }); }
      catch (error) {
        if (error.code !== 'PAYLOAD_TOO_LARGE') throw error;
        // Resolve the precise server limit only when necessary, without changing
        // any previously accepted record's representation on copied-file replay.
        result = { sourceIds: [], added: 0, jobIds: [] };
        for (const message of pending) {
          const one = await createBoundedNativeIntake(sink, pending.length === 1 ? new Set([message.id]) : new Set())
            .ingestConversation({ ...batch, messages: [message] });
          result.sourceIds.push(...one.sourceIds); result.added += one.added; result.jobIds.push(...one.jobIds);
        }
      }
      receipt.sourceIds.push(...result.sourceIds); receipt.added += result.added;
      receipt.jobIds.push(...(result.jobIds ?? [])); pending = [];
    };
    for (const message of batch.messages) {
      const payloadBytes = Buffer.byteLength(JSON.stringify({ text: message.text, role: message.role,
        sourceTimestamp: message.createdAt ?? message.timestamp ?? null, original: message, authority: message.authority,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}) }));
      if (payloadBytes <= 1048576 && !forceIds.has(message.id)) { pending.push(message); continue; }
      await flush();
      if (typeof message.rawLineBase64 !== 'string') throw Object.assign(new Error('Oversized native source lacks original bytes'), { code: 'NATIVE_BYTES_MISSING' });
      const bytes = Buffer.from(message.rawLineBase64, 'base64'), chunks = [], semanticSources = [];
      let anyAdded = false;
      for (let offset = 0, index = 0; offset < bytes.length; offset += chunkBytes, index++) {
        const part = bytes.subarray(offset, offset + chunkBytes), sha256 = hash(part);
        const result = await sink.ingestConversation({ ...batch, messages: [{
          id: `${message.id}:native-part:${index}`, role: 'trace', text: '', authority: 'native_event_record',
          nativePart: { format: 'tina-native-part/1', parentMessageId: message.id, index, offset, byteLength: part.length, sha256, base64: part.toString('base64') },
        }] });
        anyAdded ||= result.added > 0;
        chunks.push({ sourceId: result.sourceIds[0], offset, byteLength: part.length, sha256 });
      }
      // Large actual messages still enter extraction in exact, bounded text spans.
      // Trace/compaction/tool rows never become dialogue or model tasks.
      for (const field of ['text', 'reasoning']) {
        const text = message[field]; if (typeof text !== 'string' || !text) continue;
        for (let start = 0; start < text.length;) {
          let end = Math.min(start + 80_000, text.length);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          const fragment = { id: `${message.id}:native-${field}:${start}`, role: message.role, text: field === 'text' ? text.slice(start, end) : '', authority: message.authority,
            nativeSpan: { parentMessageId: message.id, field, start, end, unit: 'utf16',
              nativeArchive: { format: 'tina-native-record/1', encoding: 'utf8-jsonl', byteLength: bytes.length, sha256: hash(bytes), chunks } } };
          if (message.createdAt !== undefined) fragment.createdAt = message.createdAt;
          if (field === 'reasoning') fragment.reasoning = text.slice(start, end);
          const result = await sink.ingestConversation({ ...batch, messages: [fragment] });
          anyAdded ||= result.added > 0; receipt.jobIds.push(...(result.jobIds ?? []));
          semanticSources.push({ sourceId: result.sourceIds[0], field, start, end }); start = end;
        }
      }
      const manifest = { id: message.id, role: 'trace', text: '', authority: 'native_event_record',
        nativeArchive: { format: 'tina-native-record/1', encoding: 'utf8-jsonl', nativeRole: message.role,
          byteLength: bytes.length, sha256: hash(bytes), chunks, semanticSources } };
      if (message.createdAt !== undefined) manifest.createdAt = message.createdAt;
      const result = await sink.ingestConversation({ ...batch, messages: [manifest] });
      receipt.sourceIds.push(result.sourceIds[0]); receipt.added += anyAdded || result.added > 0 ? 1 : 0;
    }
    await flush(); return receipt;
  } };
}

/** readSource is the existing GET /api/sources/:id capability. No native file needed. */
export async function readNativeRecord(sourceId, readSource) {
  const source = await readSource(sourceId), original = source.original ?? source.source?.original;
  if (original?.rawLineBase64) return Buffer.from(original.rawLineBase64, 'base64');
  const manifest = original?.nativeArchive ?? original?.nativeSpan?.nativeArchive;
  if (manifest?.format !== 'tina-native-record/1') throw new Error('Source is not a native record');
  const parts = []; let offset = 0;
  for (const entry of manifest.chunks) {
    const source = await readSource(entry.sourceId), part = (source.original ?? source.source?.original)?.nativePart;
    const bytes = Buffer.from(part?.base64 ?? '', 'base64');
    if (part?.format !== 'tina-native-part/1' || entry.offset !== offset || bytes.length !== entry.byteLength || hash(bytes) !== entry.sha256)
      throw Object.assign(new Error('Native source chunk failed verification'), { code: 'NATIVE_HASH_MISMATCH' });
    parts.push(bytes); offset += bytes.length;
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length !== manifest.byteLength || hash(bytes) !== manifest.sha256) throw Object.assign(new Error('Native source failed verification'), { code: 'NATIVE_HASH_MISMATCH' });
  return bytes;
}

export function createIntakeState(path) {
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS intake_cursor(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  return {
    load(id) { const row = db.prepare('SELECT body FROM intake_cursor WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; },
    save(id, value) { db.prepare('INSERT INTO intake_cursor(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify(value)); },
    close() { db.close(); },
  };
}

function filesUnder(root, exclude = []) {
  if (!root || !existsSync(root)) return [];
  root = checkedImportPath(root);
  const files = [];
  function walk(path) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, item.name);
      if (item.isSymbolicLink() || exclude.some(part => file.includes(part))) continue;
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) files.push(checkedImportPath(file));
    }
  }
  walk(root); return files.sort();
}

function firstRecord(path) {
  // Session headers are small; reading a full giant Codex history just to learn
  // its native identity would defeat incremental collection.
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(65536), count = readSync(fd, buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, count), end = data.indexOf(10);
    if (end < 0 && count === buffer.length) throw new Error('Native session header exceeds 64 KiB');
    return JSON.parse(data.subarray(0, end < 0 ? data.length : end).toString('utf8').replace(/^\uFEFF/, ''));
  } finally { closeSync(fd); }
}

/** Materialize a read-only DSH snapshot using its own frame scanner/decoder.
 * Only this collector's cache changes; it never invokes DSH recovery/migration.
 */
export async function stageDshLog({ path, cachePath, codec }) {
  const bytes = readFileSync(checkedImportPath(path));
  const scan = codec.scanZstdFrames(bytes);
  const chunks = [];
  for (const frame of scan.frames) chunks.push(await codec.decompressZstdFrame(bytes.subarray(frame.start, frame.end)));
  const decoded = Buffer.concat(chunks);
  if (decoded.length && decoded.at(-1) !== 10) throw new Error('Complete DSH frames ended inside a JSONL record');
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  const old = existsSync(cachePath) ? readFileSync(cachePath) : Buffer.alloc(0);
  if (decoded.length >= old.length && decoded.subarray(0, old.length).equals(old)) {
    if (decoded.length > old.length) appendFileSync(cachePath, decoded.subarray(old.length), { mode: 0o600 });
  } else writeFileSync(cachePath, decoded, { mode: 0o600 });
  if (!existsSync(cachePath)) writeFileSync(cachePath, decoded, { mode: 0o600 });
  return { partial: scan.tornStart !== undefined, completeFrames: scan.frames.length };
}

function resolveOpencodeDbPaths(source) {
  const rawInput = source.path ?? source.root;
  if (!rawInput || !existsSync(rawInput)) return [];
  const raw = checkedImportPath(rawInput);
  if (!existsSync(raw)) return [];
  const stat = statSync(raw);
  if (stat.isFile()) return [raw];
  const candidate = join(raw, 'opencode.db');
  if (existsSync(candidate) && statSync(candidate).isFile()) return [checkedImportPath(candidate)];
  return filesUnder(raw, source.exclude ?? []).filter(file => /(?:^|[\\/])opencode[^\\/]*\.db$/.test(file));
}

function normalizeOpencodeRow(row, partRows, { includeReasoning = false, schema = 'v1' } = {}) {
  let msgData = {};
  try { msgData = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {}); } catch {}
  const rawRole = schema === 'v2' ? (row.type ?? msgData.role) : (msgData.role ?? row.type);
  const role = ['user', 'assistant'].includes(rawRole) ? rawRole : 'trace';
  const textParts = [];
  const reasoningParts = [];

  if (typeof msgData.text === 'string' && msgData.text) textParts.push(msgData.text);
  if (Array.isArray(msgData.content)) {
    for (const item of msgData.content) {
      if (!item || typeof item !== 'object') continue;
      if (['text', 'input_text', 'output_text'].includes(item.type) && typeof item.text === 'string' && item.text) {
        textParts.push(item.text);
      } else if (['reasoning', 'thinking', 'reasoning_text'].includes(item.type)) {
        const r = item.text ?? item.thinking ?? '';
        if (typeof r === 'string' && r) reasoningParts.push(r);
      }
    }
  }
  for (const partRow of partRows ?? []) {
    let pData = {};
    try { pData = typeof partRow.data === 'string' ? JSON.parse(partRow.data) : (partRow.data ?? {}); } catch {}
    const pType = partRow.type ?? pData.type;
    if (['text', 'input_text', 'output_text'].includes(pType) && typeof pData.text === 'string' && pData.text) {
      textParts.push(pData.text);
    } else if (['reasoning', 'thinking', 'reasoning_text'].includes(pType)) {
      const r = pData.text ?? pData.thinking ?? '';
      if (typeof r === 'string' && r) reasoningParts.push(r);
    }
  }

  const text = textParts.join('\n');
  const reasoning = includeReasoning && role === 'assistant' && reasoningParts.length ? reasoningParts.join('\n') : undefined;
  const authority = role === 'user' ? 'source_user_message' : role === 'assistant' ? (text ? 'assistant_report' : (reasoning ? 'assistant_reasoning' : 'native_event_record')) : 'native_event_record';
  const rawLineObj = {
    schema: `opencode-sqlite/${schema}`,
    id: row.id,
    session_id: row.session_id,
    ...(row.type !== undefined ? { type: row.type } : {}),
    ...(row.seq !== undefined ? { seq: row.seq } : {}),
    time_created: row.time_created,
    time_updated: row.time_updated,
    data: msgData,
    ...(partRows?.length ? { parts: partRows.map(p => ({ id: p.id, ordinal: p.ordinal, type: p.type, time_created: p.time_created, time_updated: p.time_updated, data: p.data })) } : {}),
  };
  const rawLineBytes = Buffer.from(JSON.stringify(rawLineObj), 'utf8');
  return {
    id: String(row.id),
    role,
    text,
    ...(reasoning ? { reasoning } : {}),
    authority,
    createdAt: row.time_created ?? msgData.time?.created ?? row.time_updated,
    rawLineBase64: rawLineBytes.toString('base64'),
    originalRecord: rawLineObj,
  };
}

async function pollOpencodeSqlite({ source, dbPath, nativeSink, state, cacheDir, maxRecords, batchSize, maxBatchChars, deadline }) {
  const key = `${source.id}:${hash(dbPath)}`;
  const cursorKey = `opencode:${key}`;
  const result = { id: key, path: dbPath, processed: 0, added: 0, readLines: 0, ignored: 0 };
  const prior = state.load(cursorKey) ?? {
    v1: { timeUpdated: 0, id: '' },
    v2: { timeUpdated: 0, id: '' },
  };
  const stageRoot = join(resolve(cacheDir || tmpdir()), 'opencode-stage', hash(dbPath));
  mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  const stagedDb = join(stageRoot, 'opencode.db');
  for (const suffix of ['', '-wal', '-shm']) {
    const srcFile = dbPath + suffix;
    const dstFile = stagedDb + suffix;
    if (existsSync(srcFile)) copyFileSync(srcFile, dstFile);
    else if (existsSync(dstFile)) rmSync(dstFile, { force: true });
  }
  const db = new DatabaseSync(stagedDb);
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    );
    const schemas = [];
    if (tables.has('message')) schemas.push('v1');
    if (tables.has('session_message')) schemas.push('v2');

    for (const schema of schemas) {
      if (result.readLines >= maxRecords || Date.now() >= deadline) break;
      const cur = prior[schema] ?? { timeUpdated: 0, id: '' };
      const limit = Math.max(1, maxRecords - result.readLines);
      const rows = schema === 'v1'
        ? db.prepare(
            'SELECT id, session_id, time_created, time_updated, data FROM message WHERE time_updated > ? OR (time_updated = ? AND id > ?) ORDER BY time_updated ASC, id ASC LIMIT ?'
          ).all(cur.timeUpdated, cur.timeUpdated, cur.id, limit)
        : db.prepare(
            'SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message WHERE time_updated > ? OR (time_updated = ? AND id > ?) ORDER BY time_updated ASC, id ASC LIMIT ?'
          ).all(cur.timeUpdated, cur.timeUpdated, cur.id, limit);

      const selectParts = schema === 'v1' && tables.has('part')
        ? db.prepare('SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC')
        : schema === 'v2' && tables.has('session_part')
          ? db.prepare('SELECT message_id, session_id, ordinal, type, call_id, time_created, time_updated, data FROM session_part WHERE message_id = ? ORDER BY ordinal ASC')
          : null;

      let batchSessionId = null;
      let batchMessages = [];
      let batchChars = 0;
      let lastCursor = { ...cur };

      const flushBatch = async () => {
        if (!batchMessages.length) return;
        const receipt = await nativeSink.ingestConversation({
          sourceSystem: 'opencode',
          conversationId: batchSessionId,
          deviceId: source.originDeviceId,
          messages: batchMessages,
        });
        result.processed += batchMessages.length;
        result.added += receipt.added ?? 0;
        prior[schema] = { ...lastCursor };
        state.save(cursorKey, prior);
        batchMessages = [];
        batchChars = 0;
      };

      for (const row of rows) {
        if (result.readLines >= maxRecords || Date.now() >= deadline) break;
        const partRows = selectParts ? selectParts.all(row.id) : [];
        const normalized = normalizeOpencodeRow(row, partRows, {
          includeReasoning: source.includeReasoning === true,
          schema,
        });
        const sessionId = String(row.session_id || source.conversationId || 'opencode-default');
        const msgChars = (normalized.text?.length ?? 0) + (normalized.reasoning?.length ?? 0) + 128;
        if (
          batchMessages.length > 0 &&
          (batchSessionId !== sessionId || batchMessages.length >= batchSize || batchChars + msgChars > maxBatchChars)
        ) {
          await flushBatch();
        }
        batchSessionId = sessionId;
        batchMessages.push(normalized);
        batchChars += msgChars;
        lastCursor = { timeUpdated: Number(row.time_updated ?? 0), id: String(row.id) };
        result.readLines++;
      }
      await flushBatch();
    }
  } finally {
    db.close();
  }
  return result;
}

/** One invocation scans explicitly configured source roots and imports only new rows.
 * Existing native IDs are preserved; copied histories must keep originDeviceId.
 */
export async function collectAgentSources({ sources, sink, state, cacheDir, dshCodecModule,
  maxRecords = 1000, maxRecordsPerFile = 200, maxDurationMs = 45_000, batchSize = 50, maxBatchChars = 200_000, maxFiles = Infinity } = {}) {
  if (![maxRecords, maxRecordsPerFile, maxDurationMs, batchSize, maxBatchChars].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Collector budgets must be positive integers');
  if (maxFiles !== Infinity && (!Number.isSafeInteger(maxFiles) || maxFiles < 1)) throw new Error('maxFiles must be a positive integer');
  const report = { added: 0, processed: 0, readLines: 0, sources: [], errors: [], unsupported: 0, budgetExhausted: false };
  const deadline = Date.now() + maxDurationMs;
  const nativeSink = createBoundedNativeIntake(sink);
  let visitedFiles = 0;
  const exhausted = () => report.readLines >= maxRecords || Date.now() >= deadline || visitedFiles >= maxFiles;
  let codec;
  for (const source of sources ?? []) {
    if (exhausted()) { report.budgetExhausted = true; break; }
    try {
      if (source.kind === 'batches') {
        const connector = createJsonlConnector({ id: required(source.id, 'source.id'), path: source.path,
          sourceSystem: 'transport', conversationId: source.id, cursorStore: state,
          maxRecords: Math.min(maxRecordsPerFile, maxRecords - report.readLines), deadline,
          ingestRecord: record => sink.ingestConversation(normalizeIntakeBatch(record)) });
        const result = await connector.poll(); report.sources.push(result); report.added += result.added; report.processed += result.processed; report.readLines += result.readLines;
        if (result.error) report.errors.push({ id: source.id, ...result.error });
        continue;
      }
      if (source.kind === 'opencode') {
        required(source.originDeviceId, 'originDeviceId'); required(source.id, 'source.id');
        const dbPaths = resolveOpencodeDbPaths(source);
        for (const dbPath of dbPaths) {
          if (exhausted()) { report.budgetExhausted = true; break; }
          visitedFiles++;
          try {
            const result = await pollOpencodeSqlite({
              source, dbPath, nativeSink, state, cacheDir,
              maxRecords: Math.min(maxRecordsPerFile, maxRecords - report.readLines),
              batchSize, maxBatchChars, deadline,
            });
            report.sources.push(result);
            report.added += result.added;
            report.processed += result.processed;
            report.readLines += result.readLines;
          } catch (error) {
            report.errors.push({ id: source.id, code: error.code ?? 'SOURCE_IMPORT_FAILED', message: error.message });
          }
        }
        continue;
      }
      if (!['codex', 'dsh', 'generic'].includes(source.kind)) throw new Error('Unknown native source kind');
      required(source.originDeviceId, 'originDeviceId'); required(source.id, 'source.id');
      const files = filesUnder(source.root, source.exclude ?? []).filter(file => source.kind !== 'dsh'
        ? file.endsWith('.jsonl') : /session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(file))
        .map(path => ({ path, mtime: statSync(path).mtimeMs })).sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).map(x => x.path);
      const prior = state.load('schedule:' + source.id), start = Math.max(0, files.indexOf(prior?.nextPath));
      const candidates = [...files.slice(start), ...files.slice(0, start)];
      for (const originalPath of candidates) {
        if (exhausted()) { report.budgetExhausted = true; break; }
        visitedFiles++;
        try {
          if (source.kind === 'dsh' && !originalPath.endsWith('session.v4.jsonl.zstd')) { report.unsupported++; continue; }
          let path = originalPath, partial = false;
          const key = `${source.id}:${hash(originalPath)}`;
          if (source.kind === 'dsh') {
            codec ??= await import(dshCodecModule ? pathToFileURL(dshCodecModule).href
              : new URL('../vendor/dsh-session-codec-0.2.1-rc.2/zstd.mjs', import.meta.url).href);
            path = join(resolve(cacheDir), hash(originalPath) + '.jsonl');
            const stat = statSync(originalPath, { bigint: true });
            const signature = `${stat.size}:${stat.mtimeNs}`;
            const old = state.load('stage:' + key);
            if (old?.signature !== signature || !existsSync(path)) {
              const staged = await stageDshLog({ path: originalPath, cachePath: path, codec });
              partial = staged.partial; state.save('stage:' + key, { signature, partial });
            } else partial = old.partial;
          }
          const header = firstRecord(path);
          const nativeId = source.kind === 'codex' ? (header.type === 'session_meta' ? header.payload?.id : null)
            : source.kind === 'dsh' ? (header.type === 'session' ? header.id : null) : (header.sessionId ?? header.session_id);
          const conversationId = nativeId ?? source.conversationId ?? (source.allowMissingHeader ? `file:${hash(originalPath)}` : null);
          required(conversationId, 'native session id');
          const connector = createJsonlConnector({ base: nativeSink, cursorStore: state, id: key, path,
            sourceSystem: source.kind, conversationId, deviceId: source.originDeviceId, format: source.kind === 'generic' ? 'messages' : source.kind,
            normalize: (record, context) => normalizeNativeRecord(record, { ...context, includeReasoning: source.includeReasoning === true }),
            maxRecords: Math.min(maxRecordsPerFile, maxRecords - report.readLines), batchSize, maxBatchChars, deadline, requireFinalNewline: true });
          const result = await connector.poll();
          report.sources.push({ ...result, partialNativeTail: partial }); report.added += result.added; report.processed += result.processed; report.readLines += result.readLines;
          if (result.error) report.errors.push({ id: key, ...result.error });
        } catch (error) { report.errors.push({ id: source.id, code: error.code ?? 'SOURCE_IMPORT_FAILED', message: error.message }); }
        finally { state.save('schedule:' + source.id, { nextPath: files[(files.indexOf(originalPath) + 1) % files.length] }); }
      }
    } catch (error) { report.errors.push({ id: source.id, code: error.code ?? 'SOURCE_DISCOVERY_FAILED', message: error.message }); }
  }
  return report;
}
