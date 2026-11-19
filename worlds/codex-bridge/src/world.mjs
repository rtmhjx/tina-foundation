import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const promptPath = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const guidePath = fileURLToPath(new URL('./GUIDE.md', import.meta.url));
const object = (properties = {}, required = []) => ({ type:'object', additionalProperties:false, properties, required });
const operationId = { type:'string', minLength:1, maxLength:80, description:'A previously returned operation ID. Reuse the exact ID after an uncertain response.' };
const threadId = { type:'string', minLength:1, maxLength:2048, description:'Exact native threadId returned by a bridge-owned operation.' };
const limit = { type:'integer', minimum:1, maximum:100, description:'Page size, default 50. Follow next to read more.' };
const tools = [
  { name:'codexbridge_health', tags:['read'], description:'Read worker health; includeGuide=true adds the full guide only when needed.', parameters:object({includeGuide:{type:'boolean',description:'Read the full bridge guide on demand; omitted by default.'}}) },
  { name:'codexbridge_submit', tags:['act'], description:'Queue a Windows Codex task. Reuse its operation ID after uncertainty; never submit a replacement.', parameters:object({
    workspace:{ type:'string', minLength:1, maxLength:1024, description:'Existing absolute Windows directory within an allowed root.' },
    prompt:{ type:'string', minLength:1, maxLength:16000, description:'Task, boundaries and completion criteria.' }, operationId,
  },['workspace','prompt']) },
  { name:'codexbridge_status', tags:['read'], description:'Read one exact operation state and bounded result.', parameters:object({operationId},['operationId']) },
  { name:'codexbridge_events', tags:['read'], description:'Read an owned thread\'s current event table, including unchanged items; model reports, not verified facts.', parameters:object({threadId, limit, after:{type:'string',description:'Last event ID returned as next; omit for first page.'}},['threadId']) },
  { name:'codexbridge_history', tags:['read'], description:'Read one owned event\'s revisions and source locators.', parameters:object({threadId,eventId:{type:'string',minLength:1,maxLength:2048},limit,after:{type:'integer',minimum:0,description:'Last revision returned as next; omit for first page.'}},['threadId','eventId']) },
];

function validHost(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253 || value.trim() !== value) return false;
  if (isIP(value)) return !value.includes('%');
  const dns = value.endsWith('.') ? value.slice(0,-1) : value;
  return dns.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

/** Configurable destination with the same fixed identity/command and strict host-key verification. */
export function codexBridgeSshArgs(c) {
  if (!validHost(c.host) || c.user !== 'tina' || c.remoteCommand !== 'node C:/Users/tina/AppData/Local/TinaCodexBridge/windows/client.mjs') throw new Error('INVALID_SSH_TARGET');
  const alias = c.hostKeyAlias === undefined || c.hostKeyAlias === '' ? null : c.hostKeyAlias;
  if (alias !== null && !validHost(alias)) throw new Error('INVALID_SSH_HOST_KEY_ALIAS');
  return ['-F','/dev/null','-T','-o','BatchMode=yes','-o','ConnectTimeout=6','-o','ConnectionAttempts=1',
    '-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${c.knownHostsFile}`,
    ...(alias ? ['-o',`HostKeyAlias=${alias}`] : []),'-o','IdentitiesOnly=yes',
    '-o','ClearAllForwardings=yes','-o','ForwardAgent=no','-i',c.identityFile,`${c.user}@${c.host}`,c.remoteCommand];
}

export class CodexBridgeWorld {
  id = 'codexbridge';
  constructor(context) { this.context = context; this.host = undefined; this.pending = undefined; this.timer = undefined; this.children = new Set(); this.lastError = undefined; }
  envPromptVars() { return {}; }
  webUi() { return { promptDocs:[{ key:'worlds.codexbridge.envPrompt', title:'Windows Codex Bridge', description:'Direct task delegation and result events.', role:'envPrompt', path:promptPath }] }; }
  request(input) {
    const c = this.context.cfg;
    const args = codexBridgeSshArgs(c);
    return new Promise((resolve,reject) => {
      const child = spawn('ssh',args,{ stdio:['pipe','pipe','pipe'] });
      this.children.add(child);
      let out = '', oversized = false, settled = false;
      const finish = (error,value) => { if (settled) return; settled = true; clearTimeout(timeout); this.children.delete(child); error ? reject(error) : resolve(value); };
      const timeout = setTimeout(() => { child.kill(); finish(new Error('SSH_TIMEOUT')); },25000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { out += chunk; if (out.length > 512000) { oversized = true; child.kill(); } });
      child.stderr.resume(); child.stdin.on('error',()=>{});
      child.on('error',()=>finish(new Error('SSH_UNAVAILABLE')));
      child.on('close',()=> {
        if (oversized) return finish(new Error('RESPONSE_TOO_LARGE'));
        try {
          const payload = JSON.parse(out.trim());
          if (!payload.ok) return finish(new Error(/^[A-Z][A-Z0-9_]{1,90}$/.test(payload.error) ? payload.error : 'REMOTE_ERROR'));
          finish(null,payload.result);
        } catch { finish(new Error('SSH_OR_RESPONSE_ERROR')); }
      });
      child.stdin.end(JSON.stringify(input),'utf8');
    });
  }
  tools() {
    return tools.map(def => ({ ...def, handler: async (input, call) => {
      let id = typeof input.operationId === 'string' ? input.operationId : undefined;
      try {
        if (!this.context.cfg.allowedRoles.includes(call.role)) throw new Error('ROLE_NOT_PREAUTHORIZED');
        let result;
        if (def.name === 'codexbridge_health') {
          result = await this.request({ method:'health' });
          if (input.includeGuide === true) result = { ...result, guide:readFileSync(guidePath, 'utf8') };
        }
        if (def.name === 'codexbridge_submit') {
          if (call.signal?.aborted) throw new Error('CALL_CANCELLED_BEFORE_DISPATCH');
          if (!id && !call.callId) throw new Error('STABLE_CALL_OR_OPERATION_ID_REQUIRED');
          id ||= `cti-${createHash('sha256').update(JSON.stringify([this.context.botDir,call.role,call.callId])).digest('hex').slice(0,40)}`;
          result = await this.request({ method:'submit', operationId:id, workspace:input.workspace, prompt:input.prompt });
        }
        if (def.name === 'codexbridge_status') result = await this.request({ method:'status', operationId:id });
        if (def.name === 'codexbridge_events') result = await this.request({ method:'conversation_events', threadId:input.threadId, limit:input.limit, after:input.after });
        if (def.name === 'codexbridge_history') result = await this.request({ method:'conversation_event_history', threadId:input.threadId, eventId:input.eventId, limit:input.limit, after:input.after });
        return JSON.stringify({ ok:true, result });
      } catch (e) {
        const error = /^[A-Z][A-Z0-9_]{1,90}$/.test(e?.message || '') ? e.message : 'BRIDGE_UNAVAILABLE';
        return { text:JSON.stringify({ ok:false, operationId:id, error, recovery:id ? 'Query this exact operation ID; do not submit a new one for the same task.' : 'No operation ID was created by this call.' }), isError:true };
      }
    }}));
  }
  async poll() {
    if (!this.host) return;
    const events = await this.request({method:'events'});
    if (!Array.isArray(events)) throw new Error('INVALID_EVENTS');
    for (const e of events) {
      const host = this.host; if (!host) return;
      if (!e || typeof e.id !== 'string' || !e.receipt || typeof e.receipt.operationId !== 'string') throw new Error('INVALID_EVENT');
      let saved = host.store.range({source:this.id,senderKey:e.id,limit:2}).find(x => x.meta?.revision === e.receipt.revision);
      if (!saved) {
        const summary = {...e.receipt, result:typeof e.receipt.result === 'string' ? e.receipt.result.slice(0,6000) : e.receipt.result};
        saved = await host.pushEvent({source:this.id,type:'codexbridge.result',origin:'external',ts:e.receipt.updatedAt,
          senderKey:e.id,text:JSON.stringify(summary),meta:{operationId:e.receipt.operationId,eventId:e.id,revision:e.receipt.revision}}, {trigger:'flush'});
      }
      await this.request({method:'ack',eventId:e.id,cursor:saved.cursor});
    }
    this.lastError = undefined;
  }
  async start(host) {
    this.host = host;
    const tick = () => {
      if (!this.host || this.pending) return;
      this.pending = this.poll().catch(e => { this.lastError = e?.message || 'BRIDGE_UNAVAILABLE'; }).finally(()=>{this.pending=undefined;});
    };
    tick(); this.timer = setInterval(tick,Math.max(2000,Math.min(60000,this.context.cfg.pollMs)));
  }
  async stop() {
    this.host = undefined; clearInterval(this.timer);
    for (const child of this.children) child.kill();
    await this.pending;
  }
}
const CODEXBRIDGE = {
  id:'codexbridge', label:'Windows Codex Bridge',
  defaults:() => ({ enabled:false, host:'127.0.0.1', hostKeyAlias:'', user:'tina', identityFile:'/home/tina/.ssh/id_ed25519',
    knownHostsFile:'/home/tina/.ssh/known_hosts', remoteCommand:'node C:/Users/tina/AppData/Local/TinaCodexBridge/windows/client.mjs', allowedRoles:['main'], pollMs:5000 }),
  create:context => new CodexBridgeWorld(context),
  describe:{ tools, events:[{type:'codexbridge.result',description:{zh:'带原任务编号的 Codex 原生结果或恢复不确定状态。',en:'Native result or uncertain recovery state for the original operation.'},trigger:'flush'}] },
};
export default CODEXBRIDGE;
