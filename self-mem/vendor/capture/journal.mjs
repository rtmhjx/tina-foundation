import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = value => createHash('sha256').update(value).digest('hex');

/** Durable local intake exists before SharedGitMem can touch an unavailable authority. */
export class CaptureJournal {
  constructor(path, {reasoningExtractor}={}) {
    this.reasoningExtractor=reasoningExtractor;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS captures(source_id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replicated(source_id TEXT PRIMARY KEY,head TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prefixes(session_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs(handle TEXT PRIMARY KEY,mime TEXT NOT NULL,data BLOB NOT NULL);
      CREATE TRIGGER IF NOT EXISTS capture_no_update BEFORE UPDATE ON captures BEGIN SELECT RAISE(ABORT,'immutable capture'); END;
      CREATE TRIGGER IF NOT EXISTS capture_no_delete BEFORE DELETE ON captures BEGIN SELECT RAISE(ABORT,'immutable capture'); END;`);
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('instance', randomUUID());
    this.instance = this.meta('instance');
    this.revision = 0;
  }
  meta(key, value) {
    if (value !== undefined) this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
    return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
  }
  capture({ kind, sessionId, key, raw, content, ...metadata }) {
    const extracted=metadata.reasoning??this.reasoningExtractor?.(raw?.item??raw);
    if(extracted)metadata.reasoning=extracted;
    const original = canonical(raw);
    const sourceId = `${kind}:${digest(canonical([this.instance, sessionId, key, digest(original),...(metadata.reasoning?[digest(metadata.reasoning)]:[])]))}`;
    const record = { sourceId, kind, sessionId, sourceSystem: 'cortico-api7', deviceId: this.instance,
      content, original: structuredClone(raw), ...metadata };
    const payload = canonical(record), sha = digest(payload);
    const inserted = this.db.prepare('INSERT OR IGNORE INTO captures VALUES (?,?,?)').run(sourceId, payload, sha);
    if (this.db.prepare('SELECT digest FROM captures WHERE source_id=?').get(sourceId)?.digest !== sha)
      throw new Error('CAPTURE_ID_CONFLICT');
    if (inserted.changes) ++this.revision;
    return `src:${sourceId}`;
  }
  rows(pending = false) {
    return this.db.prepare(`SELECT payload FROM captures ${pending ? 'WHERE source_id NOT IN (SELECT source_id FROM replicated)' : ''} ORDER BY rowid`).all().map(row => JSON.parse(row.payload));
  }
  pendingCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM captures WHERE source_id NOT IN (SELECT source_id FROM replicated)').get().n; }
  acknowledge(records, head) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) this.db.prepare('INSERT OR REPLACE INTO replicated VALUES (?,?)').run(record.sourceId, head);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  prefix(sessionId, value) {
    if (value !== undefined) this.db.prepare('INSERT OR REPLACE INTO prefixes VALUES (?,?)').run(sessionId, canonical(value));
    const row = this.db.prepare('SELECT payload FROM prefixes WHERE session_id=?').get(sessionId);
    return row ? JSON.parse(row.payload) : null;
  }
  put(nameHint, bytes, mime) {
    const data = Buffer.from(bytes), handle = `mem:tina/${digest(Buffer.concat([Buffer.from(mime + '\0'), data]))}`;
    this.db.prepare('INSERT OR IGNORE INTO blobs VALUES (?,?,?)').run(handle, mime, data);
    return handle;
  }
  get(handle) {
    const row = this.db.prepare('SELECT mime,data FROM blobs WHERE handle=?').get(handle);
    return row ? { mime: row.mime, bytes: new Uint8Array(row.data) } : null;
  }
  list(prefix = '') {
    return this.db.prepare('SELECT handle,mime,length(data) AS size FROM blobs ORDER BY handle').all().filter(row => row.handle.startsWith(prefix));
  }
  close() { this.db.close(); }
}
