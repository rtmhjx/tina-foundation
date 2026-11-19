import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./stream_guard.py', import.meta.url));

export class StreamGuard {
  constructor({ stateDir, python = '/usr/bin/python3', spawnImpl = spawn }) {
    if (!stateDir) throw Error('guard_state_required');
    Object.assign(this, { stateDir, python, spawnImpl }); this.child = null; this.lines = null;
  }
  async exchange(message) {
    if (!this.child || this.child.exitCode !== null) throw Error('guard_process_unknown');
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error('guard_timeout_unknown')); }, 5000);
      const onLine = line => { cleanup(); try { resolve(JSON.parse(line)); } catch { reject(Error('guard_response_invalid')); } };
      const onExit = () => { cleanup(); reject(Error('guard_process_unknown')); };
      const cleanup = () => { clearTimeout(timer); this.lines.off('line', onLine); this.child.off('exit', onExit); this.child.off('error', onExit); };
      this.lines.once('line', onLine); this.child.once('exit', onExit); this.child.once('error', onExit);
    });
    this.child.stdin.write(JSON.stringify(message) + '\n');
    const response = await result;
    if (response.ok !== true) throw Error('guard_busy_or_unsettled');
  }
  async reserve(operation) {
    if (!this.child) this.open();
    await this.exchange({ action: 'reserve', operation });
  }
  open() {
    if (this.child) throw Error('guard_already_started');
    this.child = this.spawnImpl(this.python, [script], { env: { ...process.env, CANBOT_AUDIO_STATE: this.stateDir },
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.lines = createInterface({ input: this.child.stdout });
  }
  async lock() { this.open(); await this.exchange({ action: 'lock' }); }
  async recover(operationId) { this.open(); await this.exchange({ action: 'recover', operationId }); }
  async settle(operationId, outcome) {
    await this.exchange({ action: 'settle', operationId, outcome });
    this.child.stdin.end();
  }
  async quarantine(operationId, newInstanceId) {
    await this.exchange({ action: 'quarantine', operationId, newInstanceId }); this.child.stdin.end();
  }
  async waitReleased(timeoutMs = 5000) {
    const child = this.child;
    if (!child) return false;
    if (child.exitCode !== null) return child.exitCode === 0 && child.signalCode === null;
    return await new Promise(resolve => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = ok => { clearTimeout(timer); child.off('exit', onExit); child.off('error', onError); resolve(ok); };
      const onExit = (code, signal) => finish(code === 0 && signal === null);
      const onError = () => finish(false);
      child.once('exit', onExit); child.once('error', onError);
      if (child.exitCode !== null) finish(child.exitCode === 0 && child.signalCode === null);
    });
  }
  releaseUnknown() { this.child?.stdin.end(); } // latch intentionally retained
}
