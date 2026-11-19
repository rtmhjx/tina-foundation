import { TinaSelfMem } from './core.mjs';
import { createSelfMemToolkit } from './tools.mjs';

export function createCorticoSelfMemFacet({
  mem,
  sharedMem = null,
  dataDir = '',
  authorityDir = '',
  deviceDir = '',
  agentId = 'cortico-tina',
  maxSelfChars = 16000,
  pulseLimit = 6,
  captureReasoning = true,
  legacyRecall = null,
  getSourceContext,
} = {}) {
  const ownsMem = !mem;
  const store = mem || new TinaSelfMem({
    sharedMem,
    dataDir,
    authorityDir,
    deviceDir,
    defaultBotId: agentId,
    maxSelfChars,
    pulseLimit,
    legacyRecall,
  });

  const toolkit = createSelfMemToolkit(store, { agentId, getSourceContext });
  const corticoTools = toolkit.declarations.map((decl) => ({
    ...decl,
    execute: decl.handler,
    handler: async (args = {}) => {
      const res = await decl.handler(args);
      return typeof res === 'string' ? res : JSON.stringify(res);
    },
  }));

  return {
    mem: store,
    toolkit,
    tools: corticoTools,

    async buildSystemPrompt({ seed = '', sessionId = 'main', forceRefresh = false } = {}) {
      const snap = await store.getSystemBlock({ sessionId, agentId, forceRefresh });
      return seed ? `${seed.trim()}\n\n${snap.text}` : snap.text;
    },

    async buildSystemSegments({ seed = '', sessionId = 'main', forceRefresh = false, worlds = [] } = {}) {
      const snap = await store.getSystemBlock({ sessionId, agentId, forceRefresh });
      const segments = [];
      if (seed && seed.trim()) segments.push({ title: '部署种子', text: seed });
      segments.push({ title: '自我与记忆画布', text: snap.text });
      for (const w of worlds) {
        segments.push({ title: w.id, text: w.envPrompt, ...(w.sourceKey ? { sourceKey: w.sourceKey } : {}) });
      }
      return { headCommit: snap.headCommit, segments };
    },

    async onSessionCompact(sessionId = 'main') {
      return await store.refreshSession(sessionId, { agentId });
    },

    async ingestTurn({ sessionId = 'main', channel = 'cortico', messages = [] } = {}) {
      const receipts = [];
      for (const m of messages) {
        if (!m || ['system', 'developer'].includes(m.role)) continue;
        const content = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content) ? m.content.map((p) => p.text ?? '').join('') : '';
        const reasoning = captureReasoning ? (m.reasoning || m.thinking || null) : null;
        receipts.push(await store.ingestSource({
          sourceId: m.id ? `${channel}_${agentId}_${sessionId}_${m.id}` : undefined,
          agentId,
          sessionId,
          channel,
          role: m.role || 'user',
          content,
          reasoning,
          original: m,
          kind: m.role ? 'conversation' : 'context',
          ...(m.createdAt || m.ts ? { createdAt: m.createdAt || m.ts } : {}),
        }));
      }
      return receipts;
    },

    async status() {
      return { agentId, ...(await store.stats({ excludeAgent: agentId })) };
    },

    async close() {
      if (ownsMem && typeof store.close === 'function') await store.close();
    },
  };
}
