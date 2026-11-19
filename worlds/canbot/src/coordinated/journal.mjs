import { open, mkdir, readFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Durable, bounded per-intent journal; a partial or uncertain entry fails closed. */
export class ArbitrationJournal {
  constructor(folder, { maxReceipts = 128, maxRetired = 65536 } = {}) {
    if (!folder || !Number.isInteger(maxReceipts) || maxReceipts < 1 || !Number.isInteger(maxRetired) || maxRetired < 1) throw Error('journal_folder_required');
    this.folder = folder; this.maxReceipts = maxReceipts; this.maxRetired = maxRetired;
  }
  async init() { await mkdir(this.folder, { mode: 0o700, recursive: true }); }
  path(id) { if (!UUID.test(id)) throw Error('request_id_invalid'); return join(this.folder, `${id}.json`); }
  async syncDir() { const dir = await open(this.folder, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  async read(id) {
    let value; try { value = JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw Error('arbitration_journal_invalid');
      const retired = await this.retired(); const old = retired.find(entry => entry.requestId === id);
      return old ? { version: 1, ...old, state: 'rejected', reason: 'receipt_retired_no_replay' } : null;
    }
    if (value?.version !== 1 || value.requestId !== id || !/^[0-9a-f]{64}$/.test(value.payloadHash ?? '')
      || !['pending', 'completed', 'rejected', 'unknown'].includes(value.state)) throw Error('arbitration_journal_invalid');
    return value;
  }
  async retired() {
    let data; try { data = await readFile(join(this.folder, 'retired-ids.log'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (data && !data.endsWith('\n')) throw Error('retired_journal_invalid');
    return data.split('\n').filter(Boolean).map(line => {
      const value = JSON.parse(line);
      if (!UUID.test(value.requestId ?? '') || !/^[0-9a-f]{64}$/.test(value.payloadHash ?? '')) throw Error('retired_journal_invalid');
      return value;
    });
  }
  async compact(keepId) {
    const names = (await readdir(this.folder)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    if (names.length <= this.maxReceipts) return;
    const retired = await this.retired(); const known = new Set(retired.map(r => r.requestId));
    const records = []; for (const name of names) { const r = await this.read(name.slice(0, -5));
      if (r?.requestId !== keepId && (r?.state === 'completed' || r?.state === 'rejected')) records.push({ record: r, time: (await stat(this.path(r.requestId))).mtimeMs }); }
    records.sort((a, b) => a.time - b.time || a.record.requestId.localeCompare(b.record.requestId));
    const remove = records.slice(0, Math.min(records.length, names.length - this.maxReceipts)).map(item => item.record);
    const extra = remove.filter(r => !known.has(r.requestId));
    if (retired.length + extra.length > this.maxRetired) throw Error('retired_journal_capacity');
    if (extra.length) {
      const f = await open(join(this.folder, 'retired-ids.log'), 'a', 0o600);
      try { await f.writeFile(extra.map(r => JSON.stringify({ requestId: r.requestId, payloadHash: r.payloadHash }) + '\n').join('')); await f.sync(); }
      finally { await f.close(); }
      await this.syncDir();
    }
    for (const r of remove) await unlink(this.path(r.requestId));
    if (remove.length) await this.syncDir();
  }
  async reserve(id, payloadHash) {
    if (!/^[0-9a-f]{64}$/.test(payloadHash ?? '')) throw Error('payload_hash_invalid');
    const prior = await this.read(id);
    if (prior) { if (prior.payloadHash !== payloadHash) throw Error('request_id_conflict'); return { created: false, record: prior }; }
    const entries = (await readdir(this.folder)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    if (entries.length >= 4096) throw Error('arbitration_journal_capacity');
    if (entries.length >= this.maxReceipts && (await this.retired()).length >= this.maxRetired) throw Error('retired_journal_capacity');
    for (const name of entries) { const entry = await this.read(name.slice(0, -5));
      if (!entry || entry.state === 'pending' || entry.state === 'unknown') throw Error('previous_arbitration_unsettled'); }
    const record = { version: 1, requestId: id, payloadHash, state: 'pending', phase: 'reserved' };
    let latch;
    try { latch = await open(join(this.folder, 'active.json'), 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw Error('previous_arbitration_unsettled'); throw e; }
    try { await latch.writeFile(JSON.stringify({ version: 1, requestId: id, payloadHash })); await latch.sync(); } finally { await latch.close(); }
    await this.syncDir();
    const file = await open(this.path(id), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    await this.syncDir(); return { created: true, record };
  }
  async write(record) {
    const path = this.path(record.requestId), tmp = `${path}.${randomUUID()}.tmp`;
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    try { await rename(tmp, path); await this.syncDir(); } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
  }
  async clearActive(id) {
    let active; try { active = JSON.parse(await readFile(join(this.folder, 'active.json'), 'utf8')); }
    catch { throw Error('arbitration_latch_invalid'); }
    const record = await this.read(id);
    if (active?.requestId !== id || !record || !['completed', 'rejected'].includes(record.state)) throw Error('arbitration_latch_not_releasable');
    await unlink(join(this.folder, 'active.json')); await this.syncDir();
    await this.compact(id);
  }
}
