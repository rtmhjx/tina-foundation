#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TinaSelfMem } from './core.mjs';
import { RemoteTinaSelfMemClient } from './http-server.mjs';
import { createSelfMemToolkit } from './tools.mjs';

const SERVER_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.4.6-fusion.next.1';
  } catch {
    return '0.4.6-fusion.next.1';
  }
})();

// External MCP clients get the per-window ledger and a concise usage guide by
// default; the persona seed stays opt-in (session_start accepts includeSeed).
const MCP_SYSTEM_OPTIONS = Object.freeze({ includeLedger: true, includeGuide: true });

function parseArgs(argv) {
  const opts = {
    dir: process.env.TINA_SELF_MEM_DIR || join(homedir(), '.tina-self-mem'),
    authorityDir: process.env.TINA_AUTHORITY_DIR || '',
    deviceDir: process.env.TINA_DEVICE_DIR || '',
    remoteUrl: process.env.TINA_SELF_MEM_URL || '',
    remoteToken: process.env.TINA_SELF_MEM_TOKEN || '',
    agent: process.env.TINA_AGENT_ID || 'mcp-agent',
    maxChars: Number(process.env.TINA_MAX_SELF_CHARS || 16000),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' && argv[i + 1]) opts.dir = argv[++i];
    else if (a === '--authority-dir' && argv[i + 1]) opts.authorityDir = argv[++i];
    else if (a === '--device-dir' && argv[i + 1]) opts.deviceDir = argv[++i];
    else if (a === '--remote-url' && argv[i + 1]) opts.remoteUrl = argv[++i];
    else if (a === '--remote-token' && argv[i + 1]) opts.remoteToken = argv[++i];
    else if (a === '--agent' && argv[i + 1]) opts.agent = argv[++i];
    else if (a === '--max-chars' && argv[i + 1]) opts.maxChars = Number(argv[++i]);
  }
  return opts;
}

export function startMcpStdioServer(options = {}) {
  const opts = { ...parseArgs(process.argv.slice(2)), ...options };
  const mem = opts.remoteUrl
    ? new RemoteTinaSelfMemClient({ baseUrl: opts.remoteUrl, token: opts.remoteToken })
    : new TinaSelfMem({
        ...(opts.authorityDir && opts.deviceDir
          ? { authorityDir: resolve(opts.authorityDir), deviceDir: resolve(opts.deviceDir) }
          : { dataDir: resolve(opts.dir) }),
        defaultBotId: opts.agent,
        maxSelfChars: opts.maxChars,
      });

  const toolkit = createSelfMemToolkit(mem, { agentId: opts.agent });
  let useContentLength = null;

  function send(msg) {
    const json = JSON.stringify(msg);
    if (useContentLength) {
      process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  }

  async function handleRequest(req) {
    if (!req || typeof req !== 'object' || req.id === undefined || req.id === null) return;
    const { id, method, params = {} } = req;

    try {
      switch (method) {
        case 'initialize': {
          const snap = await mem.getSystemBlock({
            sessionId: `mcp-${opts.agent}`,
            agentId: opts.agent,
            ...MCP_SYSTEM_OPTIONS,
            ledgerAgentId: opts.agent,
          });
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: params.protocolVersion || '2024-11-05',
              capabilities: { tools: {}, resources: {}, prompts: {} },
              serverInfo: { name: 'tina-self-mem', version: SERVER_VERSION },
              instructions: snap.text,
            },
          });
          return;
        }
        case 'session_start': {
          const agentId = params.agentId || opts.agent;
          const snap = await mem.getSystemBlock({
            sessionId: params.sessionId || `mcp-${agentId}`,
            sourceSessionId: params.sourceSessionId ?? params.sessionId ?? null,
            channel: params.channel || null,
            agentId,
            forceRefresh: params.forceRefresh !== false,
            includeSeed: params.includeSeed === true,
            includeGuide: params.includeGuide === undefined ? MCP_SYSTEM_OPTIONS.includeGuide : Boolean(params.includeGuide),
            includeLedger: params.includeLedger === undefined ? MCP_SYSTEM_OPTIONS.includeLedger : Boolean(params.includeLedger),
            ledgerAgentId: params.ledgerAgentId || agentId,
          });
          send({ jsonrpc: '2.0', id, result: snap });
          return;
        }
        case 'ping':
          send({ jsonrpc: '2.0', id, result: {} });
          return;
        case 'tools/list':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              tools: toolkit.declarations.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.parameters,
              })),
            },
          });
          return;
        case 'tools/call': {
          try {
            const output = await toolkit.call(params.name, params.arguments || {});
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], isError: false } });
          } catch (toolErr) {
            send({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify({ error: toolErr.code || 'TOOL_ERROR', message: toolErr.message }, null, 2) }],
                isError: true,
              },
            });
          }
          return;
        }
        case 'resources/list':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              resources: [{
                uri: 'tina://self/panorama',
                name: 'Tina 自我与记忆画布 (TINA_SELF.md)',
                description: '跨窗口连续自我画布与近期生命余光',
                mimeType: 'text/markdown',
              }],
            },
          });
          return;
        case 'resources/read': {
          const snap = await mem.getSystemBlock({
            agentId: opts.agent,
            forceRefresh: true,
            ...MCP_SYSTEM_OPTIONS,
            ledgerAgentId: opts.agent,
          });
          send({ jsonrpc: '2.0', id, result: { contents: [{ uri: params.uri || 'tina://self/panorama', mimeType: 'text/markdown', text: snap.text }] } });
          return;
        }
        case 'prompts/list':
          send({ jsonrpc: '2.0', id, result: { prompts: [{ name: 'tina-self', description: '装入当前《自我与记忆画布》、共用指南与本窗口任务小账本，以及跨窗口近期余光' }] } });
          return;
        case 'prompts/get': {
          const snap = await mem.getSystemBlock({
            agentId: opts.agent,
            forceRefresh: true,
            ...MCP_SYSTEM_OPTIONS,
            ledgerAgentId: opts.agent,
          });
          send({ jsonrpc: '2.0', id, result: { description: 'Tina 自我与记忆画布', messages: [{ role: 'user', content: { type: 'text', text: snap.text } }] } });
          return;
        }
        default:
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (err) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message || 'Internal error' } });
    }
  }

  let buf = Buffer.alloc(0);
  let queue = Promise.resolve();
  const enqueue = (parsed) => { queue = queue.then(() => handleRequest(parsed)).catch(() => {}); };

  function drainBuffer() {
    while (buf.length > 0) {
      if (useContentLength === null) {
        const preview = buf.toString('utf8', 0, Math.min(buf.length, 32)).trimStart();
        if (!preview) return;
        useContentLength = /^content-length:/i.test(preview);
      }
      if (useContentLength) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const m = buf.toString('utf8', 0, headerEnd).match(/content-length:\s*(\d+)/i);
        if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
        const total = headerEnd + 4 + Number(m[1]);
        if (buf.length < total) return;
        const body = buf.toString('utf8', headerEnd + 4, total);
        buf = buf.subarray(total);
        try { enqueue(JSON.parse(body)); } catch {}
      } else {
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.toString('utf8', 0, nl).trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue;
        try { enqueue(JSON.parse(line)); } catch {}
      }
    }
  }

  process.stdin.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); drainBuffer(); });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await queue.catch(() => {});
    if (typeof mem.close === 'function') await mem.close();
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { mem, toolkit };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();
if (isMain) startMcpStdioServer();
