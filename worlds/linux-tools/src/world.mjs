import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SOCKET = '/run/tina-linux-tools/broker.sock';
const decls = [
  { name: 'linux_run', interruptible: true, tags: ['write'], description: '无需审批，直接运行 Linux Bash/Python/Node 命令。可自由读写 /workspace（持久，容量512MiB），/tmp 临时。宿主服务、其他目录、密钥、记忆、磁盘设备、网络均不可达；命令看到的是隔离环境。用于文件处理、计算、脚本和小任务；服务器真实状态用 linux_status。退出不为0请检查 stderr；超时或取消不会回滚已写的文件。不要将已完成命令重复提交。',
    parameters: { type: 'object', additionalProperties: false, required: ['command'], properties: {
      command: { type: 'string', minLength: 1, maxLength: 16000 },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 120, default: 60 },
    } } },
  { name: 'linux_status', tags: ['read'], description: '只读取得宿主服务器的时间、负载、内存、磁盘和自主工具边界，以及最近命令执行回执。这里的服务器指标来自宿主，不是命令隔离环境。无需审批，不唤醒其他 Agent。',
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
];

export function request(path, body, { signal, socketPath = SOCKET } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {}, signal }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; if (text.length > 600000) res.destroy(new Error('Broker response too large')); });
      res.on('error', reject);
      res.on('end', () => {
        try { const data = JSON.parse(text); res.statusCode < 300 ? resolve(data) : reject(new Error(data.error ?? `HTTP ${res.statusCode}`)); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(130000, () => req.destroy(new Error('Execution receipt unknown: query linux_status; do not repeat blindly')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export class LinuxToolsWorld {
  id = 'linux-tools';
  calls = new Map();
  constructor(ctx) { this.ctx = ctx; }
  async start() {
    const status = await request('/health');
    if (status.boundary !== 'bwrap-v1' || status.approval !== 'none') throw new Error('Linux executor boundary unavailable');
    this.active = true;
  }
  async stop() {
    this.active = false;
    const ids = [...this.calls.keys()];
    await Promise.allSettled(ids.map(id => request('/cancel', { id })));
    await Promise.allSettled([...this.calls.values()]);
  }
  envPromptVars() { return {}; }
  webUi() { return {
    label: 'Linux 自主工具',
    badges: [{ label: '审批', value: '无需', tone: 'on' }, { label: '执行范围', value: '/workspace · 512MiB · 无网络', tone: 'plain' }],
    lamps: [{ label: '隔离执行器', state: this.active ? 'online' : 'offline', hint: '独立账户、只读系统、进程与网络隔离' }],
    promptDocs: [{ key: 'worlds.linux-tools.envPrompt', title: 'Linux 工具使用边界', path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)), role: 'envPrompt' }],
  }; }
  tools() { return decls.map(d => ({ ...d, handler: (args, call = {}) => this.invoke(d.name, args, call) })); }
  async invoke(name, args, call) {
    if (!this.active) return { text: 'Linux tools are stopped', failed: true };
    if (name === 'linux_status') {
      try { return { text: JSON.stringify(await request('/status', undefined, { signal: call.signal })) }; }
      catch (e) { return { text: `Status unavailable: ${e.message}`, failed: true }; }
    }
    const id = createHash('sha256').update(JSON.stringify([this.ctx.botDir, call.role, call.callId ?? randomUUID()])).digest('hex');
    if (call.signal?.aborted) return { text: 'Cancelled before submission', failed: true };
    const onAbort = () => { void request('/cancel', { id }).catch(() => {}); };
    call.signal?.addEventListener('abort', onAbort, { once: true });
    // Keep receipt collection alive after cancellation; the broker confirms the final process state.
    const work = request('/run', { id, command: args.command, timeout_seconds: args.timeout_seconds ?? 60 });
    this.calls.set(id, work);
    try {
      const result = await work;
      return { text: JSON.stringify(result), ...(result.state !== 'completed' || result.exit_code !== 0 ? { failed: true } : {}) };
    } catch (e) {
      return { text: JSON.stringify({ id, state: 'unknown', error: e.message, next: 'linux_status; do not resubmit blindly' }), failed: true };
    } finally { this.calls.delete(id); call.signal?.removeEventListener('abort', onAbort); }
  }
}

export default {
  id: 'linux-tools', label: 'Linux 自主工具', defaults: () => ({ enabled: false }),
  create: ctx => new LinuxToolsWorld(ctx),
  describe: { tools: decls.map(d => ({ ...d, summary: { zh: d.description, en: d.description } })), events: [] },
};
