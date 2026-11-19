import { randomUUID } from 'node:crypto';

const keyRef = 'DEEPSEEK_API_KEY';
const defaultProvider = 'deepseek-official';
const modes = new Set(['companion', 'auto', 'rp', 'work']);

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function promptView(session) {
  const sections = [];
  for (const seq of session?.surface.nodes ?? []) {
    const event = session.eventAt(seq);
    if (event?.type !== 'system/message') continue;
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
    if (text) sections.push({ name: sections.length ? '会话内系统提示词更新' : '系统提示词', text });
  }
  return { state: sections.length ? 'committed' : 'pending', sections };
}

export function mountTinaControls(ctx, { sessionId, workspaceDir, assembleContextFor, renderPrompt, promptSettings,
  isToolAllowedInRp = name => name === 'cortico_world_events',
  isToolAllowedInCompanion = isToolAllowedInRp,
  isToolAllowedInMode,
  rpCommunication = false,
  existingSession = false,
  manageApprovals = true,
  initialMode = 'auto', onModeChange, modelControl }) {
  const pending = new Map();
  let mode = initialMode;
  let turnMode;
  let lastFailure;
  let running;
  let timing;
  let preview;
  // Selecting RP or Companion immediately revokes authority for new real actions,
  // including a turn already opened by a World wake. Leaving RP or Companion cannot
  // widen an in-flight restricted turn's authority until its native terminal event.
  const effectiveMode = () => {
    if (mode === 'rp' || turnMode === 'rp') return 'rp';
    if (mode === 'companion' || turnMode === 'companion') return 'companion';
    return turnMode ?? mode;
  };

  ctx.on('system-prompt/change', () => { preview = undefined; });

  async function previewSystem() {
    if (!existingSession) await ctx.sessionController.create({ sessionId, cwd: workspaceDir });
    const agent = ctx.agents.get(sessionId);
    if (agent?.status !== 'idle') return undefined;
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent));
    return assembly.sections.map(section => ({
      name: section.name,
      text: renderPrompt({ ...assembly, sections: [section] }),
    }));
  }

  async function inspectPrompt() {
    const { revision } = promptSettings.view();
    if (!running && preview?.revision !== revision) preview = { revision, result: previewSystem() };
    const pending = preview?.revision === revision ? preview : undefined;
    let assembled;
    try {
      assembled = await pending?.result;
    } catch {
      if (preview === pending) preview = undefined;
    }
    if (!assembled && preview === pending) preview = undefined;

    const current = promptSettings.view();
    if (current.revision !== revision || (preview !== pending && preview !== undefined)) assembled = undefined;
    const recorded = promptView(ctx.sessions.get(sessionId));
    const named = new Map();
    let position = 0;
    for (const section of assembled ?? []) {
      named.set(section.name, { ...section, ...(section.text && { position: ++position }) });
    }
    const editable = current.editable.map(section => ({
      ...section,
      text: named.get(section.name)?.text ?? section.configured,
      position: named.get(section.name)?.position,
      ...(assembled && { included: named.has(section.name) }),
    }));
    const writable = new Set(editable.map(section => section.name));
    const readOnly = [...named.values()]
      .filter(section => section.text && !writable.has(section.name))
      .map(section => section.name === 'tina:interaction' ? { ...section, label: '现实操作与审批' } : section);
    return {
      state: recorded.state === 'committed' ? 'committed' : assembled ? 'preview' : 'pending',
      revision: current.revision,
      sections: [...editable, ...readOnly],
      recorded: recorded.sections,
    };
  }

  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return;
    if (event.type === 'turn/start') {
      turnMode = mode;
      lastFailure = undefined;
      running = { turn: event.data.turn, start: performance.now() };
    }
    if (event.type === 'turn/end') {
      if (running?.turn === event.data.turn) {
        timing = {
          turn: running.turn,
          firstTextMs: running.firstTextMs ?? null,
          elapsedMs: Math.round(performance.now() - running.start),
        };
      }
      running = undefined;
      turnMode = undefined;
    }
  });

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent.id === sessionId && running && frame.type === 'chunk'
        && frame.chunk.type === 'text-delta' && frame.chunk.text) {
      running.firstTextMs ??= Math.round(performance.now() - running.start);
    }
  });

  ctx.systemPrompt.context({
    name: 'tina:interaction-mode',
    order: 7100,
    text: ({ agent }) => {
      if (agent?.id !== sessionId) return '';
      const current = effectiveMode();
      if (current === 'auto') return '';
      if (current === 'companion') {
        return '当前处于【陪伴轻聊档】：复杂工程与终端工具已卸载以降低对话延迟。像平常一样自然、松弛地交流，闲聊与情感互动不用项目符号、编号列表或汇报腔；需要回忆过往细节时调用可用记忆工具核实（绝不在回复中播报“查了记忆”），涉及近期外部信息时调用可用联网搜索工具查证，不尝试执行未加载的本机工程操作。';
      }
      if (current === 'rp') {
        return '当前处于【角色扮演档】：留在当前虚构场景中并保持上下文连续一致（姓名、物件、位置、关系与已确立的事实跨轮一致；旧位置与新位置严格区分，指代确实模糊时在角色内简短确认）。场景内的一切动作均为想象，严禁调用任何本机文件、终端或外部现实操作工具。'
          + (rpCommunication ? ' 可读取 World 事件并通过当前频道发言工具参与场景互动；可使用只读记忆工具回溯已确立的经历与设定。' : '');
      }
      return '当前处于【工作执行档】：将用户的明确工作请求视为实际任务，在授权工作区与权限策略内按需调用原生工具核查、执行与验证，如实汇报真实执行结果，严格区分“已完成的操作”与“计划中的步骤”。';
    },
  });

  const denialFor = exec => {
    if (exec.agent?.id !== sessionId) return undefined;
    const current = effectiveMode();
    if (current === 'rp' && !isToolAllowedInRp(exec.name)) return '角色扮演模式禁止实际操作。';
    if (current === 'companion' && !isToolAllowedInCompanion(exec.name)) {
      return '陪伴模式已卸载复杂操作工具，当前仅保留白名单能力（记忆检索、联网搜索及白名单 World）。';
    }
    return undefined;
  };
  ctx.tools.guard(exec => denialFor(exec));
  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = denialFor(exec);
    return reason ? { kind: 'deny', reason } : next();
  }, { prepend: true });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const current = await next();
    if (context.agent?.id !== sessionId) return current;
    const activeMode = effectiveMode();
    if (typeof isToolAllowedInMode === 'function') {
      return { ...current, tools: current.tools.filter(({ name }) => isToolAllowedInMode(activeMode, name)) };
    }
    if (activeMode === 'rp') {
      return { ...current, tools: current.tools.filter(({ name }) => isToolAllowedInRp(name)) };
    }
    if (activeMode === 'companion') {
      return { ...current, tools: current.tools.filter(({ name }) => isToolAllowedInCompanion(name)) };
    }
    return current;
  }, { prepend: true });

  ctx.on('approval/request', (request, next) => {
    if (!manageApprovals) return next();
    const { agent, signal, toolName, reason } = request;
    if (agent.session.id !== sessionId) return next();
    if (signal?.aborted) return Promise.resolve('cancelled');
    const id = randomUUID();
    const { promise, resolve } = Promise.withResolvers();
    const finish = outcome => {
      if (!pending.delete(id)) return;
      signal?.removeEventListener('abort', abort);
      resolve(outcome);
    };
    const abort = () => finish('cancelled');
    const summary = typeof reason === 'string' && reason.trim()
      ? reason.slice(0, 600) : '这次工具调用需要你的确认。';
    pending.set(id, { id, sessionId, tool: toolName, summary, finish });
    signal?.addEventListener('abort', abort, { once: true });
    return promise;
  });

  ctx.effect(() => () => {
    for (const entry of pending.values()) entry.finish('cancelled');
  });

  async function handle(action, body = {}) {
    if (action === 'prompt') return { prompt: await inspectPrompt() };
    if (action === 'status') {
      const session = ctx.sessions.get(sessionId);
      const selection = session && ctx.sessionProjections.stateOf(session, 'modelSelection');
      const selected = selection?.pending ?? selection?.lastUsed ?? ctx.agentDefaultModel.currentSelection();
      const models = modelControl ? await modelControl.status() : await (async () => {
        const [credentials, available] = await Promise.all([
          ctx.credentialsController.describe([keyRef]), ctx.llm.listModels(defaultProvider),
        ]);
        return {
          provider: selected.provider, model: selected.model,
          models: available.map(({ id, name }) => ({ id, label: name })),
          credentialMode: 'official', credentialConfigured: credentials[keyRef]?.configured === true,
        };
      })();
      // The fused projection also retains usage from failed assistant/attempt
      // streams; the SDK's completed-message token meter remains the fallback.
      const totals = ctx.get?.('corticoCore')?.loop?.usageProjection?.inspect().totals
        ?? (session && ctx.sessionProjections.stateOf(session, 'tokenUsage')?.totals);
      return {
        ...models, mode, lastFailure, timing,
        approvals: [...pending.values()].map(({ finish, ...item }) => item),
        prompt: promptView(session),
        usage: {
          inputTokens: totals?.uncachedInputTokens ?? 0,
          outputTokens: totals?.outputTokens ?? 0,
          cacheReadTokens: totals?.cacheReadTokens ?? 0,
          cacheWriteTokens: totals?.cacheWriteTokens ?? 0,
          // Counters above are observed sums. Missing coverage must stay
          // distinguishable from a verified zero, including SDK fallbacks.
          unknownCacheCalls: totals?.unknownCacheCalls ?? null,
          unknownUsageCalls: totals?.unknownUsageCalls ?? null,
          providerAttempts: totals?.providerAttempts ?? null,
        },
      };
    }
    if (action === 'prompt-section') {
      await promptSettings.save(body);
      preview = undefined;
    } else if (action === 'credential') {
      if (modelControl && !modelControl.credentialAllowed()) throw fail('CREDENTIAL_MANAGED_BY_PROVIDER');
      const value = typeof body.value === 'string' ? body.value.trim() : '';
      if (!value || value.length > 4096 || !/^[!-~]+$/.test(value)) throw fail('INVALID_CREDENTIAL');
      await ctx.credentialsController.set(keyRef, value);
      if (!(await ctx.credentialsController.describe([keyRef]))[keyRef]?.configured) throw fail('CREDENTIAL_NOT_SAVED');
    } else if (action === 'model') {
      if (modelControl) await modelControl.select(body);
      else {
        const available = await ctx.llm.listModels(defaultProvider);
        if (!available.some(({ id }) => id === body.model)) throw fail('MODEL_UNAVAILABLE');
        await ctx.sessionController.create({ sessionId, cwd: workspaceDir });
        await ctx.sessionController.selectModel({ sessionId, provider: defaultProvider, model: body.model });
      }
      preview = undefined;
    } else if (action === 'approval') {
      const approval = pending.get(body.id);
      if (!approval || !['allow', 'deny'].includes(body.decision)) throw fail('APPROVAL_EXPIRED');
      approval.finish(body.decision === 'allow' ? 'allowed-once' : 'rejected');
    } else if (action === 'mode') {
      if (!modes.has(body.mode)) throw fail('INVALID_MODE');
      const afterModeChange = await onModeChange?.(body.mode);
      mode = body.mode;
      if ((mode === 'rp' || mode === 'companion') && running) {
        turnMode = mode === 'rp' || turnMode === 'rp' ? 'rp' : 'companion';
      }
      preview = undefined;
      ctx.emit('system-prompt/change');
      await afterModeChange?.();
    } else {
      throw fail('UNKNOWN_ACTION');
    }
    return { ok: true };
  }

  return {
    handle,
    effectiveMode,
    failure(code) { lastFailure = code; },
  };
}
