import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export class LinkError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function normalize(value) {
  const get = (key, max) => {
    if (typeof value?.[key] !== 'string' || !value[key].trim() || value[key].length > max) throw new LinkError(`INVALID_${key.toUpperCase()}`);
    return value[key];
  };
  if (!['task', 'progress', 'result', 'needs_user_action'].includes(value?.kind)) throw new LinkError('INVALID_KIND');
  const result = { id: get('id', 180), source_lane: get('source_lane', 100), target_lane: get('target_lane', 100), topic: get('topic', 300),
    summary: get('summary', 16000), kind: value.kind, source_ref: get('source_ref', 4096), created_at: get('created_at', 80),
    request_wake: value.request_wake === true };
  if (!Number.isFinite(Date.parse(result.created_at))) throw new LinkError('INVALID_CREATED_AT');
  return result;
}
export class LinkStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL,
        digest TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL,
        host_cursor INTEGER, settled TEXT, wake_requested INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS pending ON events(settled,seq);`);
  }
  insert(value) {
    const event = normalize(value), payload = JSON.stringify(event);
    const digest = createHash('sha256').update(payload).digest('hex');
    const existing = this.db.prepare('SELECT * FROM events WHERE id=?').get(event.id);
    if (existing && existing.digest !== digest) throw new LinkError('EVENT_ID_CONFLICT', 409);
    if (!existing) this.db.prepare('INSERT INTO events(id,digest,payload,received_at) VALUES(?,?,?,?)').run(event.id, digest, payload, new Date().toISOString());
    return { inserted: !existing, record: this.get(event.id) };
  }
  decode(row) { return row ? { ...row, event: JSON.parse(row.payload) } : null; }
  get(id) { return this.decode(this.db.prepare('SELECT * FROM events WHERE id=?').get(id)); }
  list(after = 0, limit = 50) { return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(row => this.decode(row)); }
  pending() { return this.db.prepare('SELECT * FROM events WHERE settled IS NULL ORDER BY seq LIMIT 500').all().map(row => this.decode(row)); }
  bind(id, cursor) { this.db.prepare('UPDATE events SET host_cursor=? WHERE id=? AND host_cursor IS NULL').run(cursor, id); }
  settle(id, outcome) { this.db.prepare('UPDATE events SET settled=? WHERE id=? AND settled IS NULL').run(outcome, id); }
  woke(ids) { const stmt = this.db.prepare('UPDATE events SET wake_requested=1 WHERE id=?'); for (const id of ids) stmt.run(id); }
  close() { this.db.close(); }
}
