import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class MobileError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}

const equalPayload = (a, b) => ['device_id', 'text', 'created_at', 'source_ref', 'in_reply_to']
  .every(key => (a[key] ?? null) === (b[key] ?? null));

/** Immutable originals + append-only feed. Delivery state never means a human read it. */
export class MobileStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, source_ref TEXT,
        in_reply_to TEXT, delivery_state TEXT, host_cursor INTEGER,
        server_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS feed (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        created_at TEXT NOT NULL, source_ref TEXT, in_reply_to TEXT, state TEXT
      );
      CREATE INDEX IF NOT EXISTS feed_device_seq ON feed(device_id, seq);
      CREATE INDEX IF NOT EXISTS records_dispatch ON records(kind, delivery_state, host_cursor);
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL, mime TEXT NOT NULL,
        sha256 TEXT NOT NULL, data BLOB NOT NULL
      );`);
    this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('server_id', randomUUID());
    this.serverId = this.db.prepare('SELECT value FROM meta WHERE key=?').get('server_id').value;
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  sourceRef(id) { return `mobile://${this.serverId}/${encodeURIComponent(id)}`; }
  getMedia(id) { return this.db.prepare('SELECT * FROM media WHERE id=?').get(id) ?? null; }
  getMediaInfo(id) { return this.db.prepare('SELECT id,device_id,mime,sha256,length(data) AS size FROM media WHERE id=?').get(id) ?? null; }
  putMedia(id, device, mime, sha256, data) {
    return this.transaction(() => this.putMediaRow(id, device, mime, sha256, data));
  }
  putMediaRow(id, device, mime, sha256, data) {
    const existing = this.getMedia(id);
    if (existing) {
      if (existing.device_id !== device || existing.mime !== mime || existing.sha256 !== sha256 || !Buffer.from(existing.data).equals(data))
        throw new MobileError('MEDIA_ID_PAYLOAD_CONFLICT', 409);
      return false;
    }
    this.db.prepare('INSERT INTO media(id,device_id,mime,sha256,data) VALUES (?,?,?,?,?)').run(id, device, mime, sha256, data);
    return true;
  }
  get(id) { return this.db.prepare('SELECT * FROM records WHERE id=?').get(id) ?? null; }
  insert(input, kind) {
    return this.transaction(() => this.insertRow(input, kind));
  }
  insertMedia(input, kind, mime, sha256, data) {
    return this.transaction(() => {
      this.putMediaRow(input.id, input.device_id, mime, sha256, data);
      return this.insertRow(input, kind);
    });
  }
  insertRow(input, kind) {
      const existing = this.get(input.id);
      if (existing) {
        if (existing.kind !== kind || !equalPayload(existing, input)) throw new MobileError('ID_PAYLOAD_CONFLICT', 409);
        return { record: existing, inserted: false };
      }
      const state = kind === 'user_message' ? 'accepted' : null;
      this.db.prepare(`INSERT INTO records(id,device_id,kind,text,created_at,source_ref,in_reply_to,delivery_state)
        VALUES (?,?,?,?,?,?,?,?)`).run(input.id, input.device_id, kind, input.text, input.created_at,
        input.source_ref ?? null, input.in_reply_to ?? null, state);
      const result = this.db.prepare(`INSERT INTO feed(id,device_id,kind,text,created_at,source_ref,in_reply_to,state)
        VALUES (?,?,?,?,?,?,?,?)`).run(input.id, input.device_id, kind, input.text, input.created_at,
        input.source_ref ?? this.sourceRef(input.id), input.in_reply_to ?? null, state);
      this.db.prepare('UPDATE records SET server_seq=? WHERE id=?').run(Number(result.lastInsertRowid), input.id);
      return { record: this.get(input.id), inserted: true };
  }
  ack(record) {
    return { id: record.id, state: record.delivery_state === 'delivered' ? 'delivered' : 'accepted', server_seq: record.server_seq };
  }
  pending() {
    return this.db.prepare("SELECT * FROM records WHERE kind='user_message' AND delivery_state='accepted' AND host_cursor IS NULL ORDER BY server_seq").all();
  }
  setHostCursor(id, cursor) {
    this.db.prepare('UPDATE records SET host_cursor=? WHERE id=? AND host_cursor IS NULL').run(cursor, id);
  }
  settle(id, state, explanation = '') {
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || row.kind !== 'user_message' || row.delivery_state !== 'accepted') return false;
      this.db.prepare('UPDATE records SET delivery_state=? WHERE id=?').run(state, id);
      this.db.prepare(`INSERT INTO feed(id,device_id,kind,text,created_at,source_ref,in_reply_to,state)
        VALUES (?,?,?,?,?,?,?,?)`).run(`state-${randomUUID()}`, row.device_id, 'message_state', explanation,
        new Date().toISOString(), this.sourceRef(id), id, state);
      return true;
    });
  }
  feed(device, after, limit) {
    const rows = this.db.prepare('SELECT * FROM feed WHERE device_id=? AND seq>? ORDER BY seq LIMIT ?').all(device, after, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)));
    return { server_id: this.serverId, items, next_cursor: items.at(-1)?.seq ?? after, has_more: hasMore };
  }
  status(device) {
    const rows = device
      ? this.db.prepare('SELECT kind,delivery_state,COUNT(*) AS count FROM records WHERE device_id=? GROUP BY kind,delivery_state').all(device)
      : this.db.prepare('SELECT kind,delivery_state,COUNT(*) AS count FROM records GROUP BY kind,delivery_state').all();
    return { server_id: this.serverId, device_id: device ?? null, counts: rows, dispatch_pending: this.pending().length };
  }
}
