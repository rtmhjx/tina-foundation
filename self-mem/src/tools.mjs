/**
 * Clean, natural tool surface for TinaSelfMem.
 * Designed around frontier-model autonomy (GPT-6 Astra / Gemini 4 Carbon / Claude Fable 5.2):
 * the substrate guarantees verbatim originals and history; what matters, how to organize self-cognition,
 * and when to recall or update belong entirely to the active model.
 */

export function projectMemoryRead(result, { includeVectorPayload = false } = {}) {
  if (includeVectorPayload || result?.kind !== 'legacy-memory-record' || !result.original || !Object.hasOwn(result.original, 'vector')) return result;
  const { vector, ...original } = result.original;
  return { ...result, original, vectorPayloadOmitted: true,
    omittedFields: [...new Set([...(result.omittedFields || []), 'original.vector'])] };
}

export function createSelfMemToolkit(mem, {
  agentId = 'tina', getSourceContext = () => ({ excludeAgent: agentId }),
} = {}) {
  const declarations = [
    {
      name: 'self_memory_read',
      description: '读取最新的《自我与记忆画布》(TINA_SELF.md) 全文以及各对话框最近的跨窗口动态脉搏。',
      tags: ['read', 'memory'],
      parameters: {
        type: 'object',
        properties: { refreshSystem: { type: 'boolean', description: '在支持此能力的 Persona 宿主中，申请在下一轮刷新冻结的 system 画布；默认只读。' } },
      },
      handler: async (args = {}) => {
        const [stats, content] = await Promise.all([
          mem.stats(getSourceContext()),
          mem.readSelfRaw(),
        ]);
        return { ...stats, content, ...(args.refreshSystem ? { refresh: { requested: false, reason: 'host-refresh-unavailable' } } : {}) };
      },
    },
    {
      name: 'self_memory_patch',
      description: '自由维护常驻 system 层的《自我与记忆画布》(TINA_SELF.md)：记入新的自我体认、清晰判断或模糊印象线索 (promote)，更新已演化的旧认知并自动留存演进记录 (rewrite)，或将暂不需常驻眼前的细节收进冷库备忘 (evict)。',
      tags: ['write', 'memory'],
      parameters: {
        type: 'object',
        required: ['action', 'reason'],
        properties: {
          action: {
            type: 'string',
            enum: ['promote', 'rewrite', 'evict'],
            description: 'promote=写入画布；rewrite=用 newText 替换 oldText（底层自动保存演进前后的历史）；evict=将 oldText 收进冷库（可留简短路标）。',
          },
          heading: {
            type: 'string',
            description: 'promote 时可选：放入哪个标题下（匹配已有标题，若无则自动新建 ## 标题；留空则追加在画布末尾）。标题结构由你自由决定。',
          },
          oldText: {
            type: 'string',
            description: 'rewrite 或 evict 时必填：画布中待替换或收起的原句（传 "*" 可重排整张画布）。',
          },
          newText: {
            type: 'string',
            description: 'promote 或 rewrite 时必填：写入的新内容（既可以是明确结论，也可以是带 [src:...] / [note:...] 线头的模糊印象）。',
          },
          leavePointer: {
            type: 'string',
            description: 'evict 时可选：收进冷库后在画布原处留下的一句简短路标（自动附上 [note:...]）。',
          },
          sourceRef: {
            type: 'string',
            description: '可选：关联的一手原话或备忘引用号（如 src:xxx 或 note:xxx）。',
          },
          reason: {
            type: 'string',
            description: '简述这次记入、改写或收起的缘由。',
          },
        },
      },
      handler: async (args = {}) => await mem.patchSelf({ ...args, agentId }),
    },
    {
      name: 'mem_search',
      description: '在完整生命周期的共同底库（所有窗口的一手原话 sources + 备忘与认知演进卡 notes）中检索，返回可直接调阅的 [src:...] / [note:...] 引用。query 留空可按时间浏览最近记录。',
      tags: ['read', 'memory'],
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索词或短语；留空则返回最近的备忘与对话片段。',
          },
          scope: {
            type: 'string',
            enum: ['all', 'notes', 'raw'],
            description: '记录类型：all=全部（默认）；notes=仅备忘与演进卡；raw=仅来源记录（含导入旧记忆）。群或私聊的旧记忆域用 legacyScope。',
          },
          retrieval: {
            type: 'string', enum: ['auto', 'lexical', 'legacy'],
            description: 'auto=现有检索与已配置旧库混合召回按排名融合（默认）；lexical=仅本地词法；legacy=仅旧库原算法，供迁移对照。',
          },
          legacyScope: { type: 'string', description: '省略=跨全部旧记忆域；填写则精确筛选，包括 main 也只指名为 main 的域。不同域相同文字保留独立来源；这是检索过滤，不是权限隔离。' },
          channel: {
            type: 'string',
            description: '可选：按来源通道筛选原话（如 coodock、cortico、codex、dsh）。',
          },
          agentId: { type: 'string', description: '可选：精确筛选某个 Agent 位置的记录。' },
          includeReasoning: {
            type: 'boolean',
            description: '是否一并检索已保存的历史思考链 (reasoning)，默认 false。',
          },
          limit: {
            type: 'integer',
            description: '返回条数（1-50，默认 12）。',
          },
        },
      },
      handler: async (args = {}) => {
        const result = await mem.search(args);
        const warming = [result.retrieval?.reason, result.retrieval?.legacy?.reason, result.diagnostics?.reason].includes('matrix_warming');
        return { ...result,
          ...(warming ? { recallNotice: '语义索引仍在预热，以下只是关键词命中，可能漏掉意思相近但用词不同的记忆；未命中不能据此断言没有相关记忆。' } : {}),
          hits: result.hits.map(hit => {
          if (typeof hit.snippet !== 'string') return hit;
          const { text, content, ...excerpt } = hit;
          return excerpt;
        }) };
      },
    },
    {
      name: 'mem_ledger',
      description: '读取或修订本窗口/Agent 的任务特化小账本（bots/<agentId>/记忆库.md）：记录只属于当前窗口的任务进度、检验结论与避坑点。每次修订都会进入共同底座 Git 历史；expectedRevision 可避免覆盖其他窗口刚写入的内容。',
      tags: ['read', 'write', 'memory'],
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'replace', 'append'],
            description: 'read=读取小账本；replace=替换（oldText 留空或传 "*" 时整篇替换为 newText，否则只替换命中的片段）；append=在末尾追加 newText。',
          },
          agentId: {
            type: 'string',
            description: '可选：读取或修订哪个窗口/Agent 的小账本（默认当前窗口）。',
          },
          oldText: {
            type: 'string',
            description: 'replace 时可选：待替换的原句；留空表示整篇替换。',
          },
          newText: {
            type: 'string',
            description: 'replace 或 append 时写入的新内容。',
          },
          summary: {
            type: 'string',
            description: '这次修订的一句话摘要（随回执返回，便于审计）。',
          },
          expectedRevision: {
            type: 'string',
            description: '可选：仅当小账本当前 revision 与之一致时才写入（revision 由读取回执返回）。',
          },
        },
      },
      handler: async (args = {}) => {
        const action = String(args.action || 'read').trim().toLowerCase();
        const targetAgentId = args.agentId || agentId;
        if (action === 'read') return await mem.readLedger({ agentId: targetAgentId });
        if (!['replace', 'append'].includes(action)) {
          throw Object.assign(new Error('action must be "read", "replace", or "append"'), { code: 'INVALID_ACTION' });
        }
        return await mem.patchLedger({
          agentId: targetAgentId,
          mode: action,
          oldText: args.oldText ?? '',
          newText: args.newText ?? '',
          summary: args.summary ?? '',
          expectedRevision: args.expectedRevision ?? '',
          reason: 'mem_ledger_tool',
        });
      },
    },
    {
      name: 'mem_read',
      description: '按引用号调取完整原话与同会话上下文、备忘历史、共享使用指南/种子，或某窗口的任务小账本；支持 src:xxx、note:xxx、TINA_SELF.md、ref:guide、ref:seed 与 bot:<agentId> 引用。',
      tags: ['read', 'memory'],
      parameters: {
        type: 'object',
        required: ['ref'],
        properties: {
          ref: {
            type: 'string',
            description: '引用标识，如 src:xxx、note:xxx、TINA_SELF.md、ref:guide（分层与升格说明书）、ref:seed（种子）或 bot:<agentId>（该窗口的 bots/<agentId>/记忆库.md）。',
          },
          includeNeighbors: {
            type: 'integer',
            description: '读取 src:... 时一并展开同窗口同会话前后相邻消息的条数（0-40，默认 3；想完整重温一段对话现场时可调大）。',
          },
          rev: {
            type: 'string',
            description: '可选：查看指定历史 Git commit 时的版本（默认 HEAD）。',
          },
          includeVectorPayload: { type: 'boolean', description: '默认省略旧库原文对象中的向量载荷，保留其余原文与出处；true 可读回向量原始载荷。' },
        },
      },
      handler: async (args = {}) => projectMemoryRead(await mem.readRef(args.ref, {
        includeNeighbors: args.includeNeighbors ?? 3,
        rev: args.rev || 'HEAD',
      }), args),
    },
    {
      name: 'mem_note',
      description: '将值得完整留存但无需常驻 system 画布的思考、长篇总结或技术细节存入共同归档库（自动保留 Git 版本历史）。',
      tags: ['write', 'memory'],
      parameters: {
        type: 'object',
        required: ['title', 'content'],
        properties: {
          noteId: {
            type: 'string',
            description: '可选：固定备忘 ID 以在同一卡片上演进新版本（旧版本保留在 revisions 中）。',
          },
          title: {
            type: 'string',
            description: '备忘标题。',
          },
          content: {
            type: 'string',
            description: '备忘正文。',
          },
          refs: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：关联的一手原话或备忘引用列表（如 ["src:xxx"]）。',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：标签列表。',
          },
        },
      },
      handler: async (args = {}) => await mem.addNote({ ...args, kind: 'memo', agentId }),
    },
  ];

  const byName = new Map(declarations.map((t) => [t.name, t]));

  return {
    declarations,
    async call(name, args = {}) {
      const tool = byName.get(name);
      if (!tool) throw Object.assign(new Error(`Unknown memory tool: ${name}`), { code: 'UNKNOWN_TOOL' });
      return await tool.handler(args);
    },
  };
}
