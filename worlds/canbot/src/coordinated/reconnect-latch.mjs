import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Write-ahead latch: uncertain reconnects require explicit reconciliation, not
// another automatic start after a network flap or process restart.
export class ReconnectLatch {
  constructor(folder) { this.folder = folder; this.path = join(folder, 'reconnect-pending.json'); }
  async pending() {
    try { const value = JSON.parse(await readFile(this.path, 'utf8')); return value?.state === 'pending_outcome_unknown' ? value : { state: 'pending_outcome_unknown' }; }
    catch (error) { if (error.code === 'ENOENT') return null; return { state: 'pending_outcome_unknown' }; }
  }
  async syncDir() { const d = await open(this.folder, 'r'); try { await d.sync(); } finally { await d.close(); } }
  async begin() {
    const f = await open(this.path, 'wx', 0o600);
    try { await f.writeFile(JSON.stringify({ requestId: randomUUID(), state: 'pending_outcome_unknown' })); await f.sync(); }
    finally { await f.close(); }
    await this.syncDir();
  }
  async confirm() { await unlink(this.path); await this.syncDir(); }
}
