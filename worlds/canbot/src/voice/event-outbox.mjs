import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, rename, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

async function save(folder, name, value) {
  const tmp = join(folder, `.${randomUUID()}.tmp`), file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(tmp, join(folder, name));
  const directory = await open(folder, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

export class EventOutbox {
  constructor({ folder, host }) { if (!folder || typeof host?.pushEvent !== 'function') throw Error('outbox_ports_required'); Object.assign(this, { folder, host }); }
  async push(event, options = { trigger: 'flush' }) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(k => !['deliver', 'trigger'].includes(k))
      || ('deliver' in options && typeof options.deliver !== 'boolean')
      || ('trigger' in options && !['flush', 'piggyback'].includes(options.trigger))) throw Error('event_options_invalid');
    await mkdir(this.folder, { mode: 0o700, recursive: true });
    const id = randomUUID(), name = `${id}.json`, text = JSON.stringify(event);
    const record = { id, state: 'pending_outcome_unknown', eventSha256: createHash('sha256').update(text).digest('hex'), event, options };
    await save(this.folder, name, record); // write before the one and only submission
    const result = await this.host.pushEvent(event, options);
    if ((!Number.isSafeInteger(result?.cursor) || result.cursor < 1)) throw Error('event_outcome_unknown');
    await save(this.folder, name, { ...record, state: 'confirmed', cursor: result.cursor });
    await this.compactConfirmed();
    return result;
  }
  async compactConfirmed() {
    const names = (await readdir(this.folder)).filter(n => /^[0-9a-f-]{36}\.json$/.test(n));
    const confirmed = [];
    for (const name of names) {
      try {
        const value = JSON.parse(await readFile(join(this.folder, name), 'utf8'));
        if (value.state === 'confirmed' && Number.isSafeInteger(value.cursor) && value.cursor >= 1) confirmed.push({ name, mtime: (await stat(join(this.folder, name))).mtimeMs });
      } catch { /* retain unreadable/unknown entries */ }
    }
    confirmed.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    for (const item of confirmed.slice(0, Math.max(0, confirmed.length - 128))) await unlink(join(this.folder, item.name));
  }
  async markProcessingComplete(streamId) {
    await mkdir(this.folder, { mode: 0o700, recursive: true });
    await save(this.folder, 'processing.json', { state: 'complete', streamId });
  }
}
