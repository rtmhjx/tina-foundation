import type { WebUiClientBundle, WebUiPanelContext } from '../../../web/shared/client-panel.ts';

interface PersonaProfile {
  memoryRead: boolean;
  memoryWrite: boolean;
  webSearch: boolean;
  allowedWorlds: string[];
  stripCliClutter: boolean;
}

interface EngineStatus {
  provider?: string;
  providerName?: string;
  providerKind?: string;
  model?: string;
  models?: Array<{ id: string; label?: string }>;
  thinking?: boolean;
  reasoningEffort?: string;
  reasoningEfforts?: Array<{ id: string; label?: string }>;
  nativeSelection?: { provider: string; model: string; reasoningEffort: string | null; source: 'pending' | 'last-used' | 'default' } | null;
  lastRequestSelection?: { provider: string; model: string; reasoningEffort: string | null; nativeSeq: number } | null;
  reasoningEffortPending?: boolean;
  reasoningEffortError?: string;
  mode?: string;
  autonomousWork?: boolean;
  credentialConfigured?: boolean;
  credentialMode?: 'official' | 'provider' | 'host';
  modelListError?: string;
  approvals?: Array<{ id: string; tool: string; summary?: string }>;
  state?: string;
  activity?: unknown;
  lastFailure?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
    unknownCacheCalls?: number | null; unknownUsageCalls?: number | null; providerAttempts?: number | null };
  timing?: { firstTextMs?: number | null; elapsedMs?: number | null; turn?: number };
  intentions?: {
    revision: number;
    goals: Array<{ id: string; text: string; status: string; wake?: { dueAt: string; stage: string } }>;
  };
  extensions?: Array<{ id: string; state: string; disabled?: boolean }>;
  execution?: {
    revision: number;
    config: { defaultMode: string; maxInlineBytes?: number; routes: Array<{ provider: string; model: string; mode: string }> };
    effective: { mode: string; requestedMode: string; provider: string; model: string; reason?: string };
    pending: boolean;
    runningRevision: number | null;
    presentation?: { wireSchemaCount?: number; wireSchemaBytes?: number; availableSchemaCount?: number; availableSchemaBytes?: number };
  };
  providers?: {
    active: string;
    items: Array<{ id: string; name: string; module: string; moduleTitle: string; model: string | null; baseUrl?: string; active: boolean; readiness: { state: string; reason?: string } }>;
  };
  memory?: {
    agentId: string; authorityDir?: string; selfPath?: string;
    usedChars: number; maxSelfChars: number; remainingChars: number;
    pulseLimit: number; captureReasoning: boolean;
    rounds: { soft: number; hard: number };
    headCommit: string | null; sourceCount: number; noteCount: number;
    pendingCaptures: number; window: number; prefixRevision: number;
    memoryGuidance?: {
      configured: {
        mode: 'minimal' | 'guided';
        rules: {
          retrieveWhenNeeded: boolean;
          verifyChanges: boolean;
          distinguishEvidence: boolean;
          groundReusableNotes: boolean;
        };
      };
      active: {
        version: number;
        mode: 'minimal' | 'guided';
        rules: {
          retrieveWhenNeeded: boolean;
          verifyChanges: boolean;
          distinguishEvidence: boolean;
          groundReusableNotes: boolean;
        };
      } | null;
      applied: boolean;
      applies: string;
    };
    recentPulse?: Array<{ window: string; sessionId: string; turns: number; createdAt: string | null; preview: string; ref: string }>;
  };
  personaProfile?: PersonaProfile;
  worlds?: Array<{ id: string; visible: boolean; whitelisted?: boolean; toolCount: number; hasEnvPrompt: boolean }>;
  systemSummary?: { sectionCount: number; totalChars: number; overriddenCount: number; frozen: boolean };
  workspaceDir?: string;
}

function mountEngine(ctx: WebUiPanelContext): void {
  const { ui, signal } = ctx;
  // Engineering Workbench: full-unfold mode. A future compact beginner fold can set
  // data-workbench-mode="simple" without rewriting the DOM architecture below.
  ctx.root.setAttribute('data-workbench-mode', 'full');
  ctx.root.classList.add('wb-grid');

  // ── 模型与凭据 ────────────────────────────────────────────────────────────
  const account = ui.sheet({ title: '模型与凭据', desc: '当前模型来自所选模型提供商。' });
  const providerSwitcher = ui.h('div', 'wb-provider-list');
  const credentialState = ui.msgline('正在读取配置状态…');
  const key = ui.input({ type: 'password', placeholder: '官方 API Key', cls: 'grow mono' });
  key.autocomplete = 'off';
  key.setAttribute('aria-label', 'DeepSeek 官方 API Key');
  key.spellcheck = false;
  const message = ui.msgline('');
  let refreshing = false;
  let writing = false;
  let cancelling = false;
  const approving = new Set<string>();
  let modelDirty = false;
  let effortDirty = false;
  let modelProvider: string | undefined;
  let configuredModel = '';
  let effortRoute = '';
  let declaredEfforts: Array<{ id: string; label?: string }> = [];
  let credentialMode: 'official' | 'provider' | 'host' = 'provider';
  const model = ui.select({ options: [], cls: 'grow', onChange: () => { modelDirty = true; updateEffortControls(); } });
  model.setAttribute('aria-label', '实际模型');
  const effort = ui.select({ options: [], cls: 'grow', onChange: () => { effortDirty = true; updateEffortControls(); } });
  effort.setAttribute('aria-label', '推理档位');
  const effortState = ui.msgline('正在读取推理档位…');
  const saveEffort = ui.button('应用档位', { onClick: () => {
    if (model.value !== configuredModel || !declaredEfforts.some(item => item.id === effort.value)) return;
    void act('model', { model: configuredModel, provider: modelProvider, reasoningEffort: effort.value }, '档位配置已保存；实际请求档位见下方状态。');
  } });
  const saveKey = ui.button('保存 API Key', { variant: 'primary', onClick: () => { void saveCredential(); } });
  const saveModel = ui.button('应用模型', { onClick: () => { void act('model', { model: model.value, provider: modelProvider }, '模型已应用。'); } });
  const keyRow = ui.rowbar();
  keyRow.append(key, saveKey);
  const modelRow = ui.rowbar();
  modelRow.append(model, saveModel);
  const effortRow = ui.rowbar();
  effortRow.append(effort, saveEffort);
  const credentialField = ui.field('API Key', keyRow);
  const catalogState = ui.msgline('');
  account.body.append(providerSwitcher, credentialState, credentialField, ui.field('模型', modelRow), catalogState,
    ui.field('推理档位', effortRow), effortState);

  function updateEffortControls(): void {
    const locked = writing || model.value !== configuredModel || !declaredEfforts.length || credentialMode === 'host';
    effort.disabled = locked;
    saveEffort.disabled = locked || !declaredEfforts.some(item => item.id === effort.value);
  }

  // ── 行为与任务 ──────────────────────────────────────────────────────────────
  const interaction = ui.sheet({ title: '行为与任务', desc: '角色模式保留场景中的虚构行为。工作能力受原生工具权限约束。' });
  const modes = ui.segmented([
    { value: 'companion', label: '陪伴' },
    { value: 'auto', label: '自动' }, { value: 'rp', label: '角色扮演' }, { value: 'work', label: '工作' },
  ], { value: 'auto', onSelect: value => { void act('mode', { mode: value }, '模式已切换，正在运行的回合保留原有约束。'); } });
  const autonomy = ui.checkbox('允许在授权工作区自主工作', {
    checked: false,
    onChange: enabled => { void act('autonomy', { enabled }, enabled ? '已启用自主工作。' : '已关闭自主工作。'); },
  });
  const cancel = ui.button('请求取消当前任务', {
    variant: 'danger', onClick: () => { void cancelCurrent(); },
  });
  const refresh = ui.button('刷新状态', { onClick: () => { void readStatus(); } });
  const taskState = ui.msgline('正在读取任务状态…');
  const actions = ui.rowbar();
  actions.append(cancel, refresh);

  // ── 陪伴档白名单与基础工具精简 sub-panel ──────────────────────────────────
  const companionPanel = ui.h('div', 'wb-companion-whitelist');
  const companionPanelLabel = ui.h('div', 'wb-companion-whitelist-label', '陪伴档白名单与基础工具精简');
  let profileSaving = false;
  let companionWorldsSnapshot = '';

  const memReadCheck = ui.checkbox('记忆检索', {
    onChange: (c) => { void saveProfile({ memoryRead: c }); },
  });
  const memWriteCheck = ui.checkbox('记忆写入', {
    onChange: (c) => { void saveProfile({ memoryWrite: c }); },
  });
  const webSearchCheck = ui.checkbox('联网搜索', {
    onChange: (c) => { void saveProfile({ webSearch: c }); },
  });
  const stripCliCheck = ui.checkbox('精简冗余 CLI 工具 (Auto/Work)', {
    onChange: (c) => { void saveProfile({ stripCliClutter: c }); },
  });
  const companionWorldsDiv = ui.h('div', 'wb-companion-worlds');
  companionPanel.append(
    companionPanelLabel,
    memReadCheck.el, memWriteCheck.el, webSearchCheck.el, stripCliCheck.el,
    companionWorldsDiv,
  );

  interaction.body.append(modes.el, autonomy.el, taskState, actions, companionPanel);

  // ── 执行策略 ────────────────────────────────────────────────────────────────
  const execution = ui.sheet({ title: '执行策略', desc: '选择当前模型使用工具的方式。保存从下一回合生效，原生权限继续约束实际执行。' });
  let executionDirty = false;
  let executionRevision = 0;
  let executionRoute = '';
  let executionProvider = '';
  let executionModel = '';
  const toolMode = ui.select({ options: [
    { value: 'discover', label: '按需发现' }, { value: 'native', label: '直接调用' },
    { value: 'ptc', label: '代码批量调用' }, { value: 'both', label: '直接与代码调用' },
  ], onChange: () => { executionDirty = true; } });
  toolMode.setAttribute('aria-label', '工具调用方式');
  // 最大内联字节数 + preset chips
  const maxInlineBytesInput = ui.input({ type: 'number', placeholder: '最大内联字节数（如 65536）', cls: 'grow mono',
    onChange: () => { executionDirty = true; } });
  maxInlineBytesInput.setAttribute('aria-label', '最大内联字节数');
  maxInlineBytesInput.min = '1024';
  maxInlineBytesInput.max = '1048576';
  const presetRow = ui.h('div', 'wb-preset-chips');
  for (const [label, bytes] of [['16K', 16384], ['64K', 65536], ['256K', 262144], ['1M', 1048576]] as [string, number][]) {
    const chip = ui.button(label, { size: 'sm', onClick: () => {
      maxInlineBytesInput.value = String(bytes);
      executionDirty = true;
    } });
    chip.classList.add('wb-chip');
    presetRow.append(chip);
  }
  const saveExecution = ui.button('应用于当前模型', { onClick: () => { void act('execution', {
    scope: 'route', provider: executionProvider, model: executionModel, mode: toolMode.value, revision: executionRevision,
  }, '当前模型的执行策略已保存，从下一回合生效。'); } });
  const saveDefaultExecution = ui.button('设为默认', { onClick: () => {
    const bytes = maxInlineBytesInput.value ? Number(maxInlineBytesInput.value) : undefined;
    void act('execution', {
      scope: 'default', mode: toolMode.value, ...(bytes !== undefined && !Number.isNaN(bytes) ? { maxInlineBytes: bytes } : {}), revision: executionRevision,
    }, '默认执行策略已保存，从下一回合生效。');
  } });
  const executionState = ui.msgline('正在读取执行策略…');
  const wireMeter = ui.h('div', 'wb-wire-meter');
  // 路由覆盖表
  const routeTable = ui.table({ head: ['提供商', '模型', '模式', ''] });
  const routeTableWrap = ui.h('div');
  routeTableWrap.append(routeTable.el);
  const executionRow = ui.rowbar();
  executionRow.append(toolMode, saveExecution, saveDefaultExecution);
  const inlineRow = ui.rowbar();
  inlineRow.append(maxInlineBytesInput, presetRow);
  execution.body.append(
    executionRow,
    ui.h('div', 'wb-field-label', '最大内联字节数'),
    inlineRow,
    executionState,
    wireMeter,
    ui.h('div', 'wb-field-label', '路由覆盖'),
    routeTableWrap,
  );

  // ── Self-Mem 运行参数 ─────────────────────────────────────────────────────────
  const selfMem = ui.sheet({ title: 'Self-Mem 运行参数', desc: '自记忆的容量、周期与采集设置。修改后点「保存参数」应用。' });
  const maxSelfCharsInput = ui.input({ type: 'number', placeholder: '最大字符数', cls: 'grow mono' });
  maxSelfCharsInput.setAttribute('aria-label', '最大自记忆字符数');
  const pulseLimitInput = ui.input({ type: 'number', placeholder: '脉冲上限', cls: 'grow mono' });
  pulseLimitInput.setAttribute('aria-label', '脉冲上限');
  const roundsSoftInput = ui.input({ type: 'number', placeholder: '软限制轮数', cls: 'grow mono' });
  roundsSoftInput.setAttribute('aria-label', '软限制轮数');
  const roundsHardInput = ui.input({ type: 'number', placeholder: '硬限制轮数', cls: 'grow mono' });
  roundsHardInput.setAttribute('aria-label', '硬限制轮数');
  const captureReasoningCheck = ui.checkbox('采集推理过程', { checked: false });
  const saveMemConfig = ui.button('保存参数', { variant: 'primary', onClick: () => {
    void act('memoryConfig', {
      maxSelfChars: Number(maxSelfCharsInput.value),
      pulseLimit: Number(pulseLimitInput.value),
      captureReasoning: captureReasoningCheck.checked,
      rounds: { soft: Number(roundsSoftInput.value), hard: Number(roundsHardInput.value) },
    }, '自记忆参数已保存。');
  } });
  const reloadPrefix = ui.button('重载前缀', { onClick: () => {
    void act('memoryReload', {}, '前缀重载已发出，下一回合生效。');
  } });
  const goToPrompts = ui.button('查看系统提示词 →', { size: 'sm', onClick: () => {
    window.location.hash = '#/prompts';
  } });
  // ── 记忆使用引导 (minimal / guided + 4 rules, frozen per session) ──────────
  const guidancePanel = ui.h('div', 'wb-companion-whitelist');
  const guidanceTitle = ui.h('div', 'wb-companion-whitelist-label', '记忆使用引导（按会话冻结 · 清空重开或新会话生效）');
  const guidanceModeSeg = ui.segmented([
    { value: 'minimal', label: '最小引导 (强模型)' },
    { value: 'guided', label: '辅助引导 (四开关)' },
  ], {
    value: 'minimal',
    onSelect: (m) => { void act('memoryConfig', { memoryGuidance: { mode: m } }, '记忆引导档位已保存，下一新会话或清空重开后生效。'); },
  });
  const gRuleRetrieve = ui.checkbox('依赖历史时检索', {
    onChange: (c) => { void act('memoryConfig', { memoryGuidance: { rules: { retrieveWhenNeeded: c } } }, '记忆引导规则已保存（下一会话生效）。'); },
  });
  const gRuleVerify = ui.checkbox('改口冲突核对修订', {
    onChange: (c) => { void act('memoryConfig', { memoryGuidance: { rules: { verifyChanges: c } } }, '记忆引导规则已保存（下一会话生效）。'); },
  });
  const gRuleEvidence = ui.checkbox('区分证据与猜测', {
    onChange: (c) => { void act('memoryConfig', { memoryGuidance: { rules: { distinguishEvidence: c } } }, '记忆引导规则已保存（下一会话生效）。'); },
  });
  const gRuleGround = ui.checkbox('可复用经验附依据', {
    onChange: (c) => { void act('memoryConfig', { memoryGuidance: { rules: { groundReusableNotes: c } } }, '记忆引导规则已保存（下一会话生效）。'); },
  });
  const guidanceStateLine = ui.msgline('');
  guidancePanel.append(
    guidanceTitle,
    (() => { const r = ui.rowbar(); r.append(guidanceModeSeg.el); return r; })(),
    gRuleRetrieve.el, gRuleVerify.el, gRuleEvidence.el, gRuleGround.el,
    guidanceStateLine,
  );
  const memStats = ui.h('div');
  const recentPulseLog = ui.log({ maxHeight: '180px', empty: '暂无最近脉冲记录' });
  selfMem.body.append(
    (() => { const r = ui.rowbar(); r.append(maxSelfCharsInput); return ui.field('最大字符数', r); })(),
    (() => { const r = ui.rowbar(); r.append(pulseLimitInput); return ui.field('脉冲上限', r); })(),
    (() => { const r = ui.rowbar(); r.append(roundsSoftInput); return ui.field('软限制轮数', r); })(),
    (() => { const r = ui.rowbar(); r.append(roundsHardInput); return ui.field('硬限制轮数', r); })(),
    captureReasoningCheck.el,
    (() => { const r = ui.rowbar(); r.append(saveMemConfig, reloadPrefix, goToPrompts); return r; })(),
    guidancePanel,
    memStats,
    ui.h('div', 'wb-field-label', '最近脉冲'),
    recentPulseLog.el,
  );

  // ── World 可见性 ──────────────────────────────────────────────────────────────
  const worldsSheet = ui.sheet({ title: 'World 可见性', desc: '控制哪些 World 对本次对话可见。' });
  const systemSummaryLine = ui.msgline('');
  const worldsBody = ui.h('div');
  worldsSheet.body.append(systemSummaryLine, worldsBody);

  // ── 待审批操作 ──────────────────────────────────────────────────────────────
  const approvals = ui.sheet({ title: '待审批操作', desc: '允许仅针对这一次调用。拒绝或取消后，该审批不能再次使用。' });
  const approvalBody = ui.h('div');
  approvals.body.append(approvalBody);

  // ── 自主意图 ──────────────────────────────────────────────────────────────────
  const intentions = ui.sheet({ title: '自主意图', desc: 'Tina 为自己记录的目标，以及每个目标的一次性唤醒状态。' });
  const intentionBody = ui.h('div');
  intentions.body.append(intentionBody);

  // ── 自装能力 ──────────────────────────────────────────────────────────────────
  const extensions = ui.sheet({ title: '自装能力', desc: '当前隔离环境中自行安装的插件及其原生生命周期状态。' });
  const extensionBody = ui.h('div');
  extensions.body.append(extensionBody);

  // ── 本会话用量 ────────────────────────────────────────────────────────────────
  const usage = ui.sheet({ title: '本会话用量' });
  const usageBody = ui.h('div');
  usage.body.append(usageBody);

  ctx.root.append(
    account.el, interaction.el, execution.el,
    selfMem.el, worldsSheet.el,
    intentions.el, extensions.el, approvals.el, usage.el,
    message,
  );
  let intentionSnapshot = '';
  let extensionSnapshot = '';
  let worldsSnapshot = '';

  function renderProviders(status: EngineStatus): void {
    if (!status.providers?.items?.length) {
      providerSwitcher.hidden = true;
      return;
    }
    providerSwitcher.hidden = false;
    providerSwitcher.replaceChildren();
    providerSwitcher.append(ui.h('div', 'wb-field-label', '端点快速切换'));
    const list = ui.h('div', 'wb-provider-chips');
    for (const item of status.providers.items) {
      const chip = ui.button(item.name ?? item.id, { size: 'sm', onClick: () => {
        void act('providerSelect', { name: item.id }, '端点已切换：' + (item.name ?? item.id));
      } });
      chip.classList.toggle('wb-chip-active', item.active);
      const dot = ui.h('span', 'navdot' + (item.readiness.state === 'ready' ? ' on' : item.readiness.state === 'error' ? ' bad' : ''));
      chip.prepend(dot);
      list.append(chip);
    }
    providerSwitcher.append(list);
  }

  function renderIntentions(status: EngineStatus): void {
    const snapshot = JSON.stringify(status.intentions ?? null);
    if (snapshot === intentionSnapshot) return;
    intentionSnapshot = snapshot;
    intentionBody.replaceChildren();
    const goals = status.intentions?.goals ?? [];
    if (status.intentions) intentionBody.append(ui.msgline('修订 ' + status.intentions.revision + ' · ' + goals.length + ' 个意图'));
    if (!goals.length) intentionBody.append(ui.placeholder('当前没有记录自主意图。'));
    const states: Record<string, string> = { active: '进行中', completed: '已完成', abandoned: '已放弃' };
    const wakeStages: Record<string, string> = { scheduled: '已安排', pending: '待投递', archived: '已归档', cancelled: '已取消' };
    for (const goal of goals) {
      const block = ui.h('div', 'section');
      block.append(ui.h('strong', null, goal.id), ui.h('p', 'whitespace-pre-wrap', goal.text));
      block.append(ui.msgline('状态：' + (states[goal.status] ?? goal.status)
        + (goal.wake ? ' · 到期：' + goal.wake.dueAt + ' · 唤醒：' + (wakeStages[goal.wake.stage] ?? goal.wake.stage) : ' · 未安排唤醒')));
      intentionBody.append(block);
    }
  }
  function renderExtensions(status: EngineStatus): void {
    const snapshot = JSON.stringify(status.extensions ?? []);
    if (snapshot === extensionSnapshot) return;
    extensionSnapshot = snapshot;
    extensionBody.replaceChildren();
    if (!status.extensions?.length) extensionBody.append(ui.placeholder('当前没有自装能力。'));
    for (const entry of status.extensions ?? []) {
      const block = ui.h('div', 'section');
      block.append(ui.h('strong', 'mono', entry.id), ui.msgline('原生状态：' + entry.state + (entry.disabled ? ' · 已停用' : '')));
      extensionBody.append(block);
    }
  }
  function renderWorlds(status: EngineStatus): void {
    const snapshot = JSON.stringify(status.worlds ?? null);
    if (snapshot === worldsSnapshot) return;
    worldsSnapshot = snapshot;
    const ss = status.systemSummary;
    systemSummaryLine.textContent = ss
      ? `${ss.sectionCount} 段 · ${ss.totalChars.toLocaleString()} 字 · ${ss.overriddenCount} 段已覆盖${ss.frozen ? ' · 已冻结' : ''}`
      : '';
    worldsBody.replaceChildren();
    if (!status.worlds?.length) {
      worldsBody.append(ui.placeholder('当前没有 World。'));
      return;
    }
    for (const world of status.worlds) {
      const row = ui.rowbar();
      const cb = ui.checkbox(world.id, {
        checked: world.visible,
        onChange: visible => { void act('worldVisibility', { id: world.id, visible }, visible ? `World "${world.id}" 已设为可见。` : `World "${world.id}" 已隐藏。`); },
      });
      const meta = ui.msgline(`${world.toolCount} 工具${world.hasEnvPrompt ? ' · 有环境提示' : ''}`);
      row.append(cb.el, meta);
      worldsBody.append(row);
    }
  }

  function showError(error: unknown): void {
    if (signal.aborted) return;
    // A request handler may include user input in an Error. Never reflect
    // credential text into a page, log, toast or exception detail.
    const text = error instanceof Error ? error.message : String(error);
    message.textContent = key.value ? '操作未完成，请检查连接或配置后重试。' : text.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
    message.className = 'msgline bad';
  }
  async function act(action: string, body: Record<string, unknown>, receipt: string): Promise<void> {
    if (writing || signal.aborted) return;
    writing = true;
    const off = ui.disable(saveKey, saveModel, key, model, effort, saveEffort, toolMode, saveExecution, saveDefaultExecution);
    try {
      await ctx.invoke(action, [body]);
      if (signal.aborted) return;
      if (action === 'model') { modelDirty = false; effortDirty = false; }
      if (action === 'execution') executionDirty = false;
      message.textContent = receipt;
      message.className = 'msgline';
      if (action === 'mode') {
        ctx.root.ownerDocument.defaultView?.dispatchEvent(new CustomEvent('tina:persona-sync'));
      }
      await readStatus();
    } catch (error) { showError(error); }
    finally { off.dispose(); writing = false; updateEffortControls(); }
  }
  async function saveProfile(patch: Partial<PersonaProfile>): Promise<void> {
    if (profileSaving || signal.aborted) return;
    profileSaving = true;
    try {
      await ctx.invoke('personaProfile', [patch]);
      if (signal.aborted) return;
      ctx.root.ownerDocument.defaultView?.dispatchEvent(new CustomEvent('tina:persona-sync'));
      void readStatus();
    } catch (error) { showError(error); }
    finally { profileSaving = false; }
  }
  async function cancelCurrent(): Promise<void> {
    if (cancelling || signal.aborted) return;
    cancelling = true;
    const off = ui.disable(cancel);
    try {
      await ctx.invoke('cancel', [{}]);
      if (signal.aborted) return;
      message.textContent = '取消请求已提交，等待内核实际结束。';
      message.className = 'msgline';
      void readStatus();
    } catch (error) { showError(error); }
    finally { off.dispose(); cancelling = false; }
  }
  async function saveCredential(): Promise<void> {
    if (credentialMode !== 'official') return;
    const value = key.value.trim();
    if (!value) { message.textContent = '请输入官方 API Key。'; message.className = 'msgline bad'; return; }
    if (writing || signal.aborted) return;
    writing = true;
    const off = ui.disable(saveKey, saveModel, key, model, effort, saveEffort);
    try {
      await ctx.invoke('credential', [{ value }]);
      key.value = '';
      if (signal.aborted) return;
      message.textContent = 'API Key 已保存。';
      message.className = 'msgline';
      await readStatus();
    } catch {
      key.value = '';
      if (!signal.aborted) {
        message.textContent = 'API Key 未保存，请检查连接或配置后重试。';
        message.className = 'msgline bad';
      }
    } finally { off.dispose(); writing = false; updateEffortControls(); }
  }
  async function decideApproval(id: string, decision: 'allow' | 'deny', buttons: HTMLButtonElement[]): Promise<void> {
    if (approving.has(id) || signal.aborted) return;
    approving.add(id);
    const off = ui.disable(...buttons);
    try {
      await ctx.invoke('approval', [{ id, decision }]);
      if (signal.aborted) return;
      message.textContent = decision === 'allow' ? '本次调用已获准。' : '本次调用已拒绝。';
      message.className = 'msgline';
    } catch (error) { showError(error); }
    finally {
      off.dispose(); approving.delete(id);
      if (!signal.aborted) void readStatus();
    }
  }
  function render(status: EngineStatus): void {
    credentialMode = status.credentialMode ?? 'official';
    const official = credentialMode === 'official';
    credentialState.textContent = official
      ? status.credentialConfigured ? '官方 API Key 已配置。' : '尚未配置官方 API Key。'
      : status.provider ? '当前端点：' + (status.providerName ?? status.provider) + '。凭据由“模型提供商”页面管理。'
        : '尚未选择模型提供商，请前往“模型提供商”页面配置。';
    credentialState.className = !official || status.credentialConfigured ? 'msgline' : 'msgline bad';
    credentialField.hidden = !official;
    if (!official) key.value = '';
    if (modelProvider !== undefined && modelProvider !== status.provider) { modelDirty = false; effortDirty = false; }
    modelProvider = status.provider;
    catalogState.textContent = status.modelListError?.endsWith('_UNCONFIGURED') ? '请为当前模型提供商选择模型。'
      : status.modelListError ? '当前模型列表暂不可用，请在模型提供商页面检查配置。' : '';
    catalogState.className = status.modelListError ? 'msgline bad' : 'msgline';
    const selection = modelDirty ? model.value : status.model ?? '';
    const options = status.models ?? [];
    const optionKey = JSON.stringify(options);
    if (model.dataset.options !== optionKey) {
      model.replaceChildren();
      for (const item of options) {
        const option = ui.h('option', null, item.label ?? item.id);
        option.value = item.id;
        model.append(option);
      }
      model.dataset.options = optionKey;
    }
    model.value = selection;
    configuredModel = status.model ?? '';
    const nextEffortRoute = JSON.stringify([status.provider, status.model]);
    if (effortRoute !== nextEffortRoute) effortDirty = false;
    effortRoute = nextEffortRoute;
    declaredEfforts = status.reasoningEfforts ?? [];
    const selectedEffort = effortDirty ? effort.value : status.reasoningEffort ?? '';
    const effortKey = JSON.stringify(declaredEfforts);
    if (effort.dataset.options !== effortKey) {
      effort.replaceChildren();
      const empty = ui.h('option', null, declaredEfforts.length ? '请选择声明的档位' : '暂无可选档位');
      empty.value = '';
      effort.append(empty);
      for (const item of declaredEfforts) {
        const option = ui.h('option', null, item.label ?? item.id);
        option.value = item.id;
        effort.append(option);
      }
      effort.dataset.options = effortKey;
    }
    effort.value = declaredEfforts.some(item => item.id === selectedEffort) ? selectedEffort : '';
    const configuredEffort = status.reasoningEffort ?? (status.thinking === false ? 'off' : '未提供');
    const request = status.lastRequestSelection;
    const requestEffort = request ? request.reasoningEffort ?? '未指定' : '尚无请求记录';
    const requestRoute = request && (request.provider !== status.provider || request.model !== status.model)
      ? `（${request.provider} · ${request.model}）` : '';
    effortState.textContent = `配置档位：${configuredEffort}；最近原生请求配置：${requestEffort}${requestRoute}。`
      + (credentialMode === 'host' ? '请通过宿主模型控件调整档位。'
        : status.reasoningEffortError ? '档位信息暂不可用，请刷新或检查模型提供商配置。'
        : !declaredEfforts.length ? '当前模型未提供可选档位，请在模型提供商页面查看声明。'
        : !declaredEfforts.some(item => item.id === status.reasoningEffort) && status.reasoningEffort !== undefined
          ? '当前配置不在模型声明中，请明确选择可用档位；不会自动降档。'
          : status.reasoningEffortPending ? '新配置尚未出现在原生请求记录中。' : '');
    effortState.className = 'msgline';
    updateEffortControls();
    modes.setValue(status.mode ?? 'auto');
    autonomy.setChecked(status.autonomousWork === true);
    const state = status.state ?? (typeof status.activity === 'string' ? status.activity : '空闲或等待事件');
    taskState.textContent = (status.provider ? status.provider + ' · ' : '') + (status.model ?? '') + ' · ' + state
      + (status.lastFailure ? ' · 最近状态 ' + status.lastFailure : '');
    renderProviders(status);
    renderIntentions(status);
    renderExtensions(status);
    renderWorlds(status);
    // Self-Mem runtime parameters
    const mem = status.memory;
    if (mem) {
      if (!writing) {
        maxSelfCharsInput.value = String(mem.maxSelfChars);
        pulseLimitInput.value = String(mem.pulseLimit);
        roundsSoftInput.value = String(mem.rounds.soft);
        roundsHardInput.value = String(mem.rounds.hard);
        captureReasoningCheck.setChecked(mem.captureReasoning);
        if (mem.memoryGuidance) {
          const gCfg = mem.memoryGuidance.configured;
          guidanceModeSeg.setValue(gCfg.mode);
          gRuleRetrieve.setChecked(gCfg.rules.retrieveWhenNeeded);
          gRuleVerify.setChecked(gCfg.rules.verifyChanges);
          gRuleEvidence.setChecked(gCfg.rules.distinguishEvidence);
          gRuleGround.setChecked(gCfg.rules.groundReusableNotes);
          const activeLabel = mem.memoryGuidance.active ? mem.memoryGuidance.active.mode : '未冻结';
          guidanceStateLine.textContent = `当前会话生效：${activeLabel}${mem.memoryGuidance.applied ? '（已注入）' : ''} · 下一会话配置：${gCfg.mode}`;
        }
      }
      memStats.replaceChildren(ui.statgrid([
        { k: '已用字符', v: mem.usedChars.toLocaleString(), unit: '字' },
        { k: '剩余字符', v: mem.remainingChars.toLocaleString(), unit: '字' },
        { k: '来源文件', v: mem.sourceCount },
        { k: '笔记', v: mem.noteCount },
        { k: '待采集', v: mem.pendingCaptures },
        { k: '前缀修订', v: mem.prefixRevision },
      ]));
      if (mem.recentPulse?.length) {
        recentPulseLog.clear();
        for (const pulse of mem.recentPulse) {
          recentPulseLog.append(`[${pulse.window}] ${pulse.sessionId} · ${pulse.turns} 轮${pulse.createdAt ? ' · ' + pulse.createdAt : ''} — ${pulse.preview}`);
        }
      }
    }
    approvalBody.replaceChildren();
    if (!status.approvals?.length) approvalBody.append(ui.placeholder('当前没有等待审批的操作。'));
    for (const entry of status.approvals ?? []) {
      const block = ui.h('div', 'section');
      const title = ui.h('strong', null, entry.tool);
      const summary = ui.h('p', null, entry.summary ?? '这次工具调用需要确认。');
      const row = ui.rowbar();
      const allow = ui.button('允许这一次', { variant: 'primary', size: 'sm', onClick: () => { void decideApproval(entry.id, 'allow', [allow, deny]); } });
      const deny = ui.button('拒绝', { size: 'sm', onClick: () => { void decideApproval(entry.id, 'deny', [allow, deny]); } });
      allow.disabled = deny.disabled = approving.has(entry.id);
      row.append(allow, deny);
      block.append(title, summary, row);
      approvalBody.append(block);
    }
    const tokens = status.usage ?? {};
    usageBody.replaceChildren(ui.statgrid([
      { k: '未命中输入', v: tokens.inputTokens ?? 0, unit: 'tok' },
      { k: '缓存读取', v: tokens.cacheReadTokens ?? 0, unit: 'tok' },
      { k: '缓存写入', v: tokens.cacheWriteTokens ?? 0, unit: 'tok' },
      { k: '模型输出', v: tokens.outputTokens ?? 0, unit: 'tok' },
    ]));
    if (tokens.unknownUsageCalls !== 0 || tokens.unknownCacheCalls !== 0) {
      const missingUsage = tokens.unknownUsageCalls == null ? '用量覆盖未知' : `有 ${tokens.unknownUsageCalls} 次调用的用量不完整`;
      const missingCache = tokens.unknownCacheCalls == null ? '缓存覆盖未知' : `有 ${tokens.unknownCacheCalls} 次调用的缓存计量不完整`;
      usageBody.append(ui.msgline('以上仅合计已知计量；' + [
        tokens.unknownUsageCalls !== 0 ? missingUsage : '', tokens.unknownCacheCalls !== 0 ? missingCache : '',
      ].filter(Boolean).join('；') + '。未知数未计作实际零消耗。'));
    }
    if (tokens.providerAttempts != null) usageBody.append(ui.msgline(`已记录上游尝试：${tokens.providerAttempts} 次。`));
    if (status.timing) {
      const first = status.timing.firstTextMs;
      const elapsed = status.timing.elapsedMs;
      usageBody.append(ui.msgline('最近回合 ' + (status.timing.turn ?? '')
        + (first === null ? ' · 未产生公开文本' : first === undefined ? '' : ' · 后端首文本 ' + first + ' ms')
        + (elapsed == null ? '' : ' · 总耗时 ' + elapsed + ' ms')));
    }
    renderCompanion(status);
  }
  function renderCompanion(status: EngineStatus): void {
    const prof = status.personaProfile;
    if (prof && !profileSaving) {
      memReadCheck.setChecked(prof.memoryRead);
      memWriteCheck.setChecked(prof.memoryWrite);
      webSearchCheck.setChecked(prof.webSearch);
      stripCliCheck.setChecked(prof.stripCliClutter);
    }
    // World whitelist chips
    const worldsKey = JSON.stringify((status.worlds ?? []).map(w => w.id + ':' + String(w.whitelisted)));
    const profKey = JSON.stringify(prof?.allowedWorlds ?? []);
    const snapKey = worldsKey + '|' + profKey;
    if (snapKey === companionWorldsSnapshot) return;
    companionWorldsSnapshot = snapKey;
    const allowed = new Set<string>(prof?.allowedWorlds ?? []);
    const worlds = (status.worlds ?? []).filter(w => w.id !== 'native-engine');
    companionWorldsDiv.replaceChildren();
    if (worlds.length) {
      companionWorldsDiv.append(ui.h('div', 'wb-field-label', '白名单 World'));
      const chipsRow = ui.h('div', 'wb-companion-worlds');
      for (const world of worlds) {
        const chipBtn = ui.button(world.id, {
          size: 'sm',
          onClick: () => {
            if (allowed.has(world.id)) allowed.delete(world.id);
            else allowed.add(world.id);
            chipBtn.classList.toggle('wb-companion-world-chip', true);
            chipBtn.classList.toggle('active', allowed.has(world.id));
            void saveProfile({ allowedWorlds: [...allowed] });
          },
        });
        chipBtn.classList.add('wb-companion-world-chip');
        chipBtn.classList.toggle('active', allowed.has(world.id));
        chipsRow.appendChild(chipBtn);
      }
      companionWorldsDiv.append(chipsRow);
    }
  }
  async function readStatus(): Promise<void> {
    if (refreshing || signal.aborted) return;
    refreshing = true;
    try {
      const status = await ctx.invoke<EngineStatus>('status');
      if (!signal.aborted) {
        render(status);
        const policy = status.execution;
        if (policy) {
          const route = JSON.stringify([status.provider, status.model]);
          if (executionRoute !== route) { executionDirty = false; executionRoute = route; }
          if (!executionDirty) executionRevision = policy.revision;
          executionProvider = status.provider ?? '';
          executionModel = status.model ?? '';
          if (!executionDirty) toolMode.value = policy.effective.requestedMode;
          if (!executionDirty && policy.config.maxInlineBytes !== undefined) {
            maxInlineBytesInput.value = String(policy.config.maxInlineBytes);
          }
          const view = policy.presentation;
          executionState.textContent = '生效方式：' + policy.effective.mode + ' · 配置修订 ' + policy.revision
            + (policy.pending ? ' · 当前回合仍使用修订 ' + policy.runningRevision : '')
            + (policy.effective.reason ? ' · 角色扮演使用按需发现与原生能力边界' : '')
            + (view?.wireSchemaBytes === undefined ? '' : ' · 当前工具定义 ' + view.wireSchemaCount + ' 个 / ' + view.wireSchemaBytes + ' 字节');
          // Wire schema meter
          wireMeter.replaceChildren();
          if (view?.wireSchemaBytes !== undefined && view?.availableSchemaBytes !== undefined && view.availableSchemaBytes > 0) {
            const prog = ui.progress({ max: view.availableSchemaBytes, value: view.wireSchemaBytes,
              label: 'Wire Schema', format: (v, m) => `${v} / ${m} B (${Math.round(v / m * 100)}%)` });
            wireMeter.append(prog.el);
            prog.setValue(view.wireSchemaBytes, view.availableSchemaBytes);
          }
          // Per-route overrides table
          routeTable.clear();
          for (const r of policy.config.routes) {
            const delBtn = ui.button('删除', { size: 'sm', onClick: () => {
              const newRoutes = policy.config.routes.filter(x => !(x.provider === r.provider && x.model === r.model));
              void act('execution', {
                scope: 'replace',
                config: { defaultMode: policy.config.defaultMode, maxInlineBytes: policy.config.maxInlineBytes, routes: newRoutes },
                revision: executionRevision,
              }, '路由覆盖已删除。');
            } });
            routeTable.addRow([r.provider, r.model, r.mode, delBtn]);
          }
          if (!policy.config.routes.length) routeTable.clear('暂无路由覆盖');
        }
      }
    } catch (error) { showError(error); }
    finally { refreshing = false; }
  }
  ctx.guardLeave(() => key.value ? 'API Key 尚未保存，离开后将清除输入。' : modelDirty ? '模型选择尚未应用，确定离开？' : executionDirty ? '执行策略尚未保存，确定离开？' : null);
  signal.addEventListener('abort', () => { key.value = ''; }, { once: true });
  ctx.interval(() => { if (!writing) void readStatus(); }, 1500);
  void readStatus();
}

const bundle: WebUiClientBundle = { panels: { engine: { mount: mountEngine } } };
export default bundle;
