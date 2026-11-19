import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { createHash } from 'node:crypto';

const FORMATS = ['messages', 'codex', 'dsh'];
// Directories that must never be scanned. Set TINA_PROTECTED_DIRS to a comma-separated list.
const PROTECTED = (process.env.TINA_PROTECTED_DIRS ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function allowedPath(value) {
  const normalized = win32.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase();
  if (PROTECTED.some(root => normalized === root || normalized.startsWith(root + '\\'))) {
    throw failure('PROTECTED_PATH', 'Protected conversation backup paths cannot be imported');
  }
  return value;
}
export function checkedImportPath(value) {
  allowedPath(value);
  const path = allowedPath(resolve(value));
  if (existsSync(path)) allowedPath(realpathSync(path));
  return path;
}
function readAt(fd, start, size) {
  const bytes = Buffer.alloc(size);
  return bytes.subarray(0, readSync(fd, bytes, 0, size, start));
}
function marker(fd, end, max) {
  const size = Math.min(end, max), start = end - size;
  return { start, size, hash: digest(readAt(fd, start, size)) };
}
function matches(fd, mark, size) {
  return !mark || mark.start + mark.size <= size && digest(readAt(fd, mark.start, mark.size)) === mark.hash;
}
function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(part => object(part) && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}
function normalizeRecord(record, context) {
  let message, timestamp, sourceId;
  if (context.format === 'codex') {
    if (record.type !== 'response_item' || record.payload?.type !== 'message') return null;
    message = record.payload; timestamp = record.timestamp; sourceId = message.id;
  } else if (context.format === 'dsh') {
    const event = object(record.event) ? record.event : record;
    if (!['user/message', 'assistant/message'].includes(event.type)) return null;
    if (event.type === 'user/message' && event.data?.source?.kind && event.data.source.kind !== 'user') return null;
    message = event.type === 'user/message' ? event.data : event.data?.message;
    if (!object(message)) throw failure('INVALID_MESSAGE', 'DSH message event has no message payload');
    message = { ...message, role: event.type === 'user/message' ? 'user' : 'assistant' };
    timestamp = event.time;
    sourceId = message.id ?? (Number.isSafeInteger(event.seq) ? `seq:${event.seq}` : undefined);
  } else {
    message = object(record.message) ? record.message : record;
    timestamp = message.createdAt ?? message.timestamp;
    sourceId = message.id;
  }
  if (typeof message.role !== 'string' || !message.role) throw failure('INVALID_MESSAGE', 'Message role is required');
  const result = {
    ...message,
    id: sourceId === undefined || sourceId === null
      ? `line:${context.offset}:${digest(JSON.stringify(record))}` : String(sourceId),
    role: message.role,
    text: typeof message.text === 'string' ? message.text : textOf(message.content),
    originalRecord: record,
  };
  if (timestamp !== undefined) result.createdAt = timestamp;
  // Reasoning is stored as assistant material, never imported as a direct user statement.
  if (result.role === 'user') delete result.reasoning;
  return result;
}

/** Watches one configured JSONL file. It does not discover paths or scan any directory. */
export function createJsonlConnector({ base, cursorStore, id, path: inputPath, sourceSystem, conversationId, deviceId = 'local', format = 'messages', normalize, ingestRecord,
  maxRecords = Infinity, batchSize = 1, maxBatchChars = 200_000, deadline = Infinity, requireFinalNewline = false } = {}) {
  if (typeof base?.ingestConversation !== 'function' && typeof ingestRecord !== 'function') throw new Error('A conversation ingestion capability is required');
  for (const [name, value] of Object.entries({ id, path: inputPath, sourceSystem, conversationId, deviceId })) {
    if (typeof value !== 'string' || !value) throw new Error(`Connector ${name} is required`);
  }
  if (!FORMATS.includes(format)) throw new Error('Unknown JSONL connector format');
  if (!(maxRecords > 0) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000 || !(maxBatchChars > 0)) throw new Error('Invalid intake batch limits');
  const path = checkedImportPath(inputPath);
  const config = { id, path, sourceSystem, conversationId, deviceId, format };
  if (!cursorStore) {
    if (!base.db?.sql) throw new Error('JSONL source needs a cursorStore with synchronous load/save methods');
    const select = base.db.sql.prepare('SELECT body FROM mb_connectors WHERE id=?');
    const write = base.db.sql.prepare('INSERT INTO mb_connectors(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body');
    cursorStore = { load: key => { const row = select.get(key); return row ? JSON.parse(row.body) : null; },
      save: (key, value) => write.run(key, JSON.stringify(value)) };
  }
  if (typeof cursorStore.load !== 'function' || typeof cursorStore.save !== 'function') throw new Error('cursorStore needs synchronous load/save methods');
  const state = () => { const value = cursorStore.load(id); if (value?.then) throw new Error('Cursor load must be synchronous'); return value ? structuredClone(value) : null; };
  const save = value => {
    const encoded = JSON.stringify(value);
    const result = cursorStore.save(id, structuredClone(value));
    if (result?.then) throw new Error('Cursor save must be synchronous');
    if (JSON.stringify(state()) !== encoded) throw failure('CONNECTOR_SAVE_FAILED', 'Connector cursor read-back did not match');
  };
  const previous = state();
  if (previous && Object.keys(config).some(key => previous[key] !== config[key])) {
    throw failure('CONNECTOR_CONFIG_CHANGED', 'Use a new connector id when changing its source configuration');
  }
  if (!previous) save({ ...config, version: 1, offset: 0, line: 0, generation: 0, identity: null, prefix: null, checkpoint: null, partial: null, status: 'idle', error: null });
  let running = null;

  async function performPoll() {
    let cursor = state(), fd;
    const result = { id, processed: 0, added: 0, readLines: 0, ignored: 0, restarted: false };
    try {
      checkedImportPath(path);
      fd = openSync(path, 'r');
      const stat = fstatSync(fd), exactIdentity = fstatSync(fd, { bigint: true });
      const identity = `${exactIdentity.dev}:${exactIdentity.ino}`;
      if (!stat.isFile()) throw failure('NOT_A_FILE', 'Configured JSONL source is not a file');
      const changed = cursor.identity !== null && (cursor.identity !== identity || stat.size < cursor.offset ||
        !matches(fd, cursor.prefix, stat.size) || !matches(fd, cursor.checkpoint, stat.size));
      if (changed) {
        cursor = { ...cursor, offset: 0, line: 0, generation: cursor.generation + 1, partial: null, checkpoint: null };
        result.restarted = true;
      }
      const prefixSize = Math.min(stat.size, 4096);
      cursor = { ...cursor, identity, prefix: { start: 0, size: prefixSize, hash: digest(readAt(fd, 0, prefixSize)) }, status: 'reading', error: null, partial: null };
      let readOffset = cursor.offset, pending = Buffer.alloc(0), scanOffset = cursor.offset, scanLine = cursor.line;
      let queued = [], queuedMessages = [], queuedChars = 0;
      const commit = (end, count = 1) => {
        cursor = { ...cursor, offset: end, line: cursor.line + count, checkpoint: marker(fd, end, 128), partial: null };
        save(cursor); result.readLines += count;
      };
      const flush = async () => {
        if (!queued.length) return;
        if (queuedMessages.length) {
          const receipt = await base.ingestConversation({ sourceSystem, conversationId, deviceId, messages: queuedMessages });
          result.processed += queuedMessages.length; result.added += receipt.added ?? queuedMessages.length;
        }
        result.ignored += queued.filter(item => !item.messages).length;
        commit(queued.at(-1).end, queued.length);
        queued = []; queuedMessages = []; queuedChars = 0;
      };
      const consume = async (record, end, originalLine) => {
        const context = { ...config, offset: scanOffset, line: scanLine + 1, originalLineBase64: originalLine.toString('base64') };
        // Batch transports can reuse the same durable byte cursor without pretending
        // that all lines belong to one source conversation. Never advance on failure.
        if (ingestRecord) {
          const receipt = await ingestRecord(record, context);
          result.processed += receipt.processed ?? receipt.sourceIds?.length ?? 0;
          result.added += receipt.added ?? 0;
          commit(end); scanOffset = end; scanLine++; return;
        }
        let messages = await (normalize ? normalize(record, context) : normalizeRecord(record, context));
        messages = messages == null ? [] : Array.isArray(messages) ? messages : [messages];
        messages = messages.map((message, index) => {
          const value = { ...message, originalRecord: record };
          if (value.id == null) value.id = `line:${scanLine + 1}:${index}`;
          value.id = String(value.id);
          if (value.role === 'user') delete value.reasoning;
          return value;
        });
        const chars = JSON.stringify(messages).length;
        if (queued.length && (queuedMessages.length + messages.length > batchSize || queuedChars + chars > maxBatchChars)) await flush();
        queued.push({ end, messages: messages.length }); queuedMessages.push(...messages); queuedChars += chars;
        scanOffset = end; scanLine++;
        if (queuedMessages.length >= batchSize || queued.length >= batchSize) await flush();
      };
      const budgetReached = () => result.readLines + queued.length >= maxRecords || Date.now() >= deadline;
      while (readOffset < stat.size && !budgetReached()) {
        const chunk = readAt(fd, readOffset, Math.min(65536, stat.size - readOffset));
        if (!chunk.length) break;
        readOffset += chunk.length;
        pending = Buffer.concat([pending, chunk]);
        let newline;
        while (!budgetReached() && (newline = pending.indexOf(10)) !== -1) {
          const bytes = pending.subarray(0, newline), end = scanOffset + newline + 1;
          let record;
          try {
            const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const content = scanLine === 0 ? line.replace(/^\uFEFF/, '') : line;
            if (!content.trim()) { await flush(); commit(end); scanOffset = end; scanLine++; pending = pending.subarray(newline + 1); continue; }
            record = JSON.parse(content);
            if (!object(record)) throw new Error('JSONL record is not an object');
          } catch {
            await flush();
            throw failure('INVALID_JSONL', `JSONL parsing stopped at line ${cursor.line + 1}, byte ${cursor.offset}`);
          }
          await consume(record, end, pending.subarray(0, newline + 1));
          pending = pending.subarray(newline + 1);
        }
      }
      // JSONL permits its last complete object without a final newline. An unfinished object stays pending.
      const paused = budgetReached();
      if (pending.length && !paused && !requireFinalNewline) {
        let record;
        try {
          const line = new TextDecoder('utf-8', { fatal: true }).decode(pending);
          record = JSON.parse(scanLine === 0 ? line.replace(/^\uFEFF/, '') : line);
        } catch { /* Wait for more bytes instead of guessing how to repair an unfinished tail. */ }
        if (object(record)) { await consume(record, scanOffset + pending.length, pending); pending = Buffer.alloc(0); }
      }
      await flush();
      cursor = { ...cursor, status: paused && cursor.offset < stat.size ? 'paused' : pending.length && !paused ? 'partial' : 'idle', partial: pending.length && !paused ? {
        bytes: pending.length, base64: pending.toString('base64'),
      } : null, error: null };
      save(cursor);
    } catch (error) {
      cursor = { ...cursor, status: error.code === 'ENOENT' ? 'unavailable' : 'blocked',
        error: { code: error.code ?? 'IMPORT_FAILED', message: error.message, line: cursor.line + 1, offset: cursor.offset } };
      save(cursor);
    } finally { if (fd !== undefined) closeSync(fd); }
    return { ...result, status: cursor.status, offset: cursor.offset, partialBytes: cursor.partial?.bytes ?? 0, error: cursor.error };
  }

  return {
    state,
    poll() {
      if (!running) running = performPoll().finally(() => { running = null; });
      return running;
    },
  };
}
