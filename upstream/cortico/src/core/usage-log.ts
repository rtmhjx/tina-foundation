/** Append-only usage ledger. Failed writes remain queued and are reported to the operator. */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageRecord } from './types.ts';
import { isDeepStrictEqual } from 'node:util';
import { readTextFile } from './util.ts';

/** Local run anchors and display labels can change when one durable attempt is replayed. */
function semanticRecord(record: UsageRecord): unknown {
  const { run, round, label, ...semantic } = record;
  return { ...semantic, recordId: record.recordId ?? record.attempt?.id,
    ts: Number.isFinite(Date.parse(record.ts)) ? new Date(record.ts).toISOString() : record.ts };
}

/** The ledger is read in chunks so its size is not bounded by V8's maximum string length. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** Lines split at the newline byte, which never occurs inside a UTF-8 multibyte sequence. */
function* fileLines(file: string): Generator<string> {
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let rest = Buffer.alloc(0);
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) {
      const buf = rest.length ? Buffer.concat([rest, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let start = 0;
      for (let end = buf.indexOf(10); end !== -1; end = buf.indexOf(10, start)) {
        yield buf.toString('utf8', start, end);
        start = end + 1;
      }
      rest = Buffer.from(buf.subarray(start));
    }
    if (rest.length) yield rest.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export class UsageLog {
  private pending: UsageRecord[] = [];
  private error: string | null = null;
  private reconcile = false;
  private identities: Map<string, UsageRecord> | null = null;
  private clearError: string | null = null;
  private cleared: Map<string, number> | null = null;
  private readonly replaySources = new Map<string, {
    cursor: () => number;
    sequenceOf: (record: UsageRecord) => number | undefined;
  }>();
  constructor(private readonly file: string, private readonly report: (message: string) => void = console.error) {}

  /** Register one durable source, not every request identity. Disposal is owner-scoped. */
  registerReplaySource(source: string, hooks: { cursor: () => number; sequenceOf: (record: UsageRecord) => number | undefined }): () => void {
    this.loadCleared();
    if (this.replaySources.has(source)) throw new Error(`Usage replay source already registered: ${source}`);
    this.replaySources.set(source, hooks);
    return () => { if (this.replaySources.get(source) === hooks) this.replaySources.delete(source); };
  }

  private loadCleared(): Map<string, number> {
    if (this.cleared) return this.cleared;
    const file = this.file + '.replay-clear.json';
    const watermarks = new Map<string, number>();
    if (existsSync(file)) {
      const data = JSON.parse(readTextFile(file)) as { version: number; sources: Array<[string, number]> };
      if (data.version !== 1 || !Array.isArray(data.sources)) throw new Error('Invalid usage replay clear watermark.');
      for (const item of data.sources) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !Number.isSafeInteger(item[1]) || item[1] < -1) {
          throw new Error('Invalid usage replay clear watermark source.');
        }
        watermarks.set(item[0], item[1]);
      }
    }
    return this.cleared = watermarks;
  }

  private wasCleared(record: UsageRecord): boolean {
    const cleared = this.loadCleared();
    for (const [source, hooks] of this.replaySources) {
      const seq = hooks.sequenceOf(record);
      if (seq !== undefined && seq <= (cleared.get(source) ?? -1)) return true;
    }
    return false;
  }

  append(rec: UsageRecord): void {
    if (this.wasCleared(rec)) return;
    const record = structuredClone({ ...rec, version: 2 as const, recordId: rec.recordId ?? rec.attempt?.id ?? crypto.randomUUID() });
    this.identities ??= new Map(this.readAll().map(row => [row.recordId ?? row.attempt?.id ?? '', row]));
    const existing = this.identities.get(record.recordId);
    if (existing) {
      if (!isDeepStrictEqual(semanticRecord(existing), semanticRecord(record))) {
        throw Object.assign(new Error('Usage record identity conflicts with existing observed consumption.'), { code: 'USAGE_RECORD_CONFLICT' });
      }
      this.flush(); return;
    }
    this.identities.set(record.recordId, record);
    this.pending.push(record);
    this.flush();
  }

  flush(): void {
    // Includes a pre-clear attempt which only becomes billable at turn/end.
    this.pending = this.pending.filter(record => !this.wasCleared(record));
    if (!this.pending.length) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (this.reconcile) {
        const records = new Map(this.readDisk().map(record => [record.recordId ?? record.attempt?.id, record]));
        this.pending = this.pending.filter(record => {
          const existing = records.get(record.recordId);
          if (!existing) return true;
          if (!isDeepStrictEqual(semanticRecord(existing), semanticRecord(record))) {
            throw new Error('USAGE_RECORD_CONFLICT: persisted consumption differs from the queued record.');
          }
          return false;
        });
        this.reconcile = false;
      }
      while (this.pending.length) {
        // A newline isolates a prior torn append; damaged lines remain available for inspection.
        appendFileSync(this.file, '\n' + JSON.stringify(this.pending[0]) + '\n', 'utf8');
        this.pending.shift();
      }
      this.error = null;
    } catch (error) { this.reconcile = true; this.note(error); }
  }

  status(): { pending: number; error: string | null } { return { pending: this.pending.length, error: this.clearError ?? this.error }; }

  private note(error: unknown): void {
    const message = `Usage ledger ${this.file}: ${String(error)}`;
    if (message !== this.error) this.report(message);
    this.error = message;
  }

  private readDisk(): UsageRecord[] {
    if (!existsSync(this.file)) return [];
    const out: UsageRecord[] = [];
    const seen = new Set<string>();
    let damaged = 0;
    for (const line of fileLines(this.file)) {
      if (!line.trim()) continue;
      let record: UsageRecord;
      try { record = JSON.parse(line) as UsageRecord; } catch { damaged++; continue; }
      if (!record || record.version !== 2 || typeof record.ts !== 'string') { damaged++; continue; }
      const id = record.recordId ?? record.attempt?.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(record);
    }
    if (damaged) this.note(`${damaged} damaged ledger lines retained on disk`);
    return out;
  }

  readAll(): UsageRecord[] {
    let records: UsageRecord[] = [];
    try { records = this.readDisk(); } catch (error) { this.note(error); }
    const ids = new Set(records.map(record => record.recordId ?? record.attempt?.id));
    return [...records, ...this.pending.filter(record => !ids.has(record.recordId))];
  }

  count(): number { return this.readAll().length; }

  clear(): number {
    const count = this.count();
    let temporary: string | undefined;
    try {
      const watermarks = new Map(this.loadCleared());
      for (const [source, hooks] of this.replaySources) {
        const seq = hooks.cursor();
        if (!Number.isSafeInteger(seq) || seq < -1) throw new Error('Invalid usage replay source cursor.');
        watermarks.set(source, Math.max(watermarks.get(source) ?? -1, seq));
      }
      mkdirSync(dirname(this.file), { recursive: true });
      // Persist the replay barrier first. A crash after truncation cannot revive
      // old usage; a failed watermark write leaves the old ledger untouched.
      if (watermarks.size) {
        temporary = this.file + '.replay-clear.' + crypto.randomUUID() + '.tmp';
        writeFileSync(temporary, JSON.stringify({ version: 1, sources: [...watermarks] }) + '\n', { encoding: 'utf8', flag: 'wx' });
        renameSync(temporary, this.file + '.replay-clear.json');
        temporary = undefined;
      }
      this.cleared = watermarks;
      writeFileSync(this.file, '', 'utf8');
      this.pending = [];
      this.identities = null;
      this.reconcile = false;
      this.error = null;
      this.clearError = null;
      return count;
    } catch (error) {
      this.note(error); this.clearError = this.error;
      throw error;
    } finally {
      if (temporary) try { unlinkSync(temporary); } catch { /* preserve the original clear failure */ }
    }
  }
}
