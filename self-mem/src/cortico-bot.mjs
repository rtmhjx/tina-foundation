import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { CaptureJournal, canonical, digest } from '../vendor/capture/journal.mjs';
import { extractReasoning } from '../vendor/capture/cot-recall.mjs';
import { createCorticoSelfMemFacet } from './cortico-adapter.mjs';
import { RemoteTinaSelfMemClient } from './http-server.mjs';
import { normalizeNativeRecord } from '../vendor/intake/src/agent-intake.mjs';
import { buildMemoryGuidance, normalizeMemoryGuidance } from './memory-guidance.mjs';
import { createMemoryBaseCompat, foundationSourceId } from './memorybase-compat.mjs';

const MAIN = 'main';
const handoffError = (code, message = code) => Object.assign(new Error(message), { code });
const require = createRequire(import.meta.url);
const loadCoreDefaults = () => {
  try {
    return require('cortico/core/config.ts').CORE_DEFAULTS;
  } catch (cause) {
    throw Object.assign(
      new Error('Cortico SDK is required for Bot defaults; pass getCoreDefaults() when testing outside Cortico.', { cause }),
      { code: 'CORTICO_SDK_REQUIRED' }
    );
  }
};

const endTurn = {
  name: 'end_turn',
  description: '结束当前轮次。',
  tags: ['flow'],
  parameters: { type: 'object', properties: {} },
  endsTurn: true,
  barrierAfter: true,
  handler: async () => 'Current turn ended.',
};

const roundCaps = (value, defaults) => {
  const caps = { ...defaults, ...value };
  if (!Number.isSafeInteger(caps.soft) || !Number.isSafeInteger(caps.hard) || caps.soft < 1 || caps.hard < caps.soft) {
    throw new Error('INVALID_MEM_ROUNDS');
  }
  return caps;
};

const textOf = (record) => {
  const item = record?.item;
  if (!item || ['reasoning', 'thinking', 'reasoning_text'].includes(item.type)) return '';
  if (item.type === 'function_call') return canonical({ name: item.name, arguments: item.arguments });
  const value = item.content ?? item.output ?? item.summary;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter((p) => !['reasoning', 'thinking', 'reasoning_text', 'summary_text'].includes(p.type))
      .map((p) => p.text ?? p.refusal ?? '')
      .join('');
  }
  return '';
};

const normalizeEvent = (event, includeReasoning = false) => {
  const isMessage = ['user/message', 'assistant/message'].includes(event.type);
  const message = event.data?.message ?? event.data;
  // DSH supports both direct Message data and its legacy wrapper. The protocol
  // role does not imply a human author: raw.event retains source provenance.
  const parsed = isMessage && message
    ? normalizeNativeRecord({ message: { role: event.type.split('/')[0], ...message } }, { format: 'generic', includeReasoning })
    : normalizeNativeRecord(event, { format: 'dsh', includeReasoning });
  const toolBlocks = Array.isArray(message?.content) ? message.content : [];
  const tools = toolBlocks.filter(block => ['tool-call', 'tool-result'].includes(block.type))
    .map(block => canonical({ type: block.type, name: block.name,
      callId: block.toolCallId ?? block.id, arguments: block.arguments,
      ...(block.type === 'tool-result' ? { output: textOf({ item: { type: 'message', content: block.content } }) } : {}),
    }));
  if (tools.length) parsed.text = [parsed.text, ...tools].filter(Boolean).join('\n');
  if (event.type === 'tool/result') parsed.role = 'tool';
  return parsed;
};

/** Only known native maintenance markers can cross the ephemeral filter.
 * A transient projection without its authoritative native event is not proof. */
const nativeMaintenanceMarker = entry => {
  const origin = entry?.context?.native;
  const event = origin?.event;
  const message = event?.data?.message ?? event?.data;
  const source = message?.source ?? event?.source;
  return Boolean(origin?.sessionId && Number.isSafeInteger(event?.seq) && source?.kind === 'plugin'
    && ['cortico-native-maintenance', 'cortico-native-handoff'].includes(source.plugin));
};

export class TinaSelfMemPersona {
  constructor(loaded, worlds = [], { mem = null, extraTools = [] } = {}) {
    this.loaded = loaded;
    this.worlds = worlds;
    const cfg = loaded?.config?.selfMem || {};
    normalizeMemoryGuidance(cfg.memoryGuidance);
    this.config = cfg;
    this.agentId = cfg.agentId || cfg.botId || 'cortico-tina';
    this.memoryDir = resolve(loaded.memoryDir || join(loaded.dataDir, 'tina-self-mem'));
    roundCaps(cfg.rounds, { soft: 4, hard: 8 });

    this.seed = '';
    if (cfg.seedFile) {
      this.seed = readFileSync(resolve(loaded.rootDir, cfg.seedFile), 'utf8');
      if (!this.seed.trim()) throw new Error('MEM_SEED_REQUIRED');
    }

    const remoteMem = !mem && cfg.remoteUrl
      ? new RemoteTinaSelfMemClient({ baseUrl: cfg.remoteUrl, token: cfg.remoteToken || '' })
      : null;

    this.facet = createCorticoSelfMemFacet({
      mem: mem || remoteMem || undefined,
      dataDir: (!mem && !remoteMem) ? resolve(loaded.rootDir, cfg.dataDir || join(loaded.dataDir, 'tina-self-mem')) : '',
      authorityDir: cfg.authorityDir ? resolve(loaded.rootDir, cfg.authorityDir) : '',
      deviceDir: cfg.deviceDir ? resolve(loaded.rootDir, cfg.deviceDir) : '',
      agentId: this.agentId,
      maxSelfChars: cfg.maxSelfChars || 16000,
      pulseLimit: cfg.pulseLimit ?? 6,
      captureReasoning: cfg.captureReasoning !== false,
      legacyRecall: cfg.legacyRecall?.enabled ? {
        ...cfg.legacyRecall,
        indexFile: cfg.legacyRecall.indexFile ? resolve(loaded.rootDir, cfg.legacyRecall.indexFile) : undefined,
      } : undefined,
      getSourceContext: () => ({ excludeAgent: this.agentId, excludeSession: this.sourceSessionId, excludeChannel: 'cortico' }),
    });
    this.memory = this.facet.mem;

    this.journal = new CaptureJournal(join(loaded.dataDir, 'tina-self-mem', 'capture.sqlite'), {
      reasoningExtractor: cfg.captureReasoning !== false ? extractReasoning : undefined,
    });
    // Candidate handoffs are separate from the active session head. Their
    // original source references remain immutable even when activation fails.
    this.journal.db.exec(`CREATE TABLE IF NOT EXISTS handoff_operations (
      operation_id TEXT NOT NULL, session_id TEXT NOT NULL, generation TEXT NOT NULL,
      expected_window INTEGER NOT NULL, payload TEXT NOT NULL,
      phase TEXT NOT NULL, receipt TEXT, PRIMARY KEY (session_id, operation_id)
    )`);
    try {
      const duplicate = this.journal.db.prepare(`SELECT 1 FROM handoff_operations WHERE phase='committed'
        GROUP BY session_id,generation HAVING COUNT(*) > 1 LIMIT 1`).get();
      if (duplicate) throw handoffError('HANDOFF_GENERATION_CONFLICT', 'Conflicting committed handoffs require reconciliation; existing records were retained.');
      this.journal.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS handoff_one_committed_generation
        ON handoff_operations(session_id,generation) WHERE phase='committed'`);
    } catch (error) {
      this.journal.close();
      if (error.code === 'HANDOFF_GENERATION_CONFLICT') throw error;
      if (String(error.code ?? '').startsWith('ERR_SQLITE_CONSTRAINT'))
        throw handoffError('HANDOFF_GENERATION_CONFLICT', 'Cannot enforce a unique committed handoff generation; existing records were retained.');
      throw error;
    }
    this.blobs = this.journal;
    this.extraTools = [...extraTools];
    this.window = Number(this.journal.meta('main-window') ?? 0);
    this.sourceSessionId = MAIN;
    this.hasStableSourceSessionId = false;
    this.guidanceEpoch = Number(this.journal.meta('memory-guidance-epoch') ?? 0);
    this.guidanceRestoredOnStart = false;
    this.prefixRevision = Number(this.journal.meta('prefix-revision') ?? 0);
    /** Last tail block digest injected into the active conversation; suppresses duplicate injections. */
    this.lastTailDigest = null;
    this.handoff = JSON.parse(this.journal.meta('handoff') ?? 'null');
    this.flushTail = Promise.resolve();
    this.disposed = false;
    this.stopping = false;
    this.lastError = null;
  }

  attach(core) { this.core = core; }

  handoffSessionState(sessionId = this.sourceSessionId, { bindLegacy = false } = {}) {
    const prefix = `handoff-session:${digest(sessionId)}`;
    if (bindLegacy) this.journal.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)')
      .run('handoff-legacy-session', sessionId);
    const anchor = this.journal.meta('handoff-legacy-session');
    const savedWindow = this.journal.meta(`${prefix}:window`);
    const savedHead = this.journal.meta(`${prefix}:head`);
    const window = Number(savedWindow ?? (anchor === sessionId ? this.journal.meta('main-window') : null) ?? 0);
    const headText = savedHead ?? (anchor === sessionId ? this.journal.meta('handoff') : null);
    return { prefix, anchor, window, handoff: headText ? JSON.parse(headText) : null };
  }

  loadSessionHandoffState(sessionId = this.sourceSessionId) {
    const state = this.handoffSessionState(sessionId, { bindLegacy: true });
    this.window = state.window;
    this.handoff = state.handoff;
    return state;
  }

  memoryGuidanceForSession({ select = true } = {}) {
    // Compression and canvas refresh are still the same logical conversation.
    const key = `memory-guidance:${this.sourceSessionId}:${this.guidanceEpoch}`;
    let snapshot = JSON.parse(this.journal.meta(key) ?? 'null');
    if (!snapshot && select) {
      snapshot = buildMemoryGuidance(this.config.memoryGuidance);
      this.journal.meta(key, JSON.stringify(snapshot));
    }
    return snapshot ? structuredClone(snapshot) : null;
  }

  sourceCreatedAt(sourceId, original) {
    const key = `capture-time:${sourceId}`;
    const saved = this.journal.meta(key);
    if (saved !== null) return saved;
    const rawTime = original?.ts ?? original?.createdAt ?? original?.timestamp;
    const createdAt = typeof rawTime === 'string' && rawTime.trim() ? rawTime : new Date().toISOString();
    this.journal.meta(key, createdAt);
    return createdAt;
  }

  captureOriginal(input) {
    const ref = this.journal.capture(input);
    this.sourceCreatedAt(ref.slice(4), input.raw);
    return ref;
  }

  captureRecord(entry, sessionId = this.sourceSessionId) {
    if (!entry?.item || entry.context?.head
      || (entry.context?.ephemeral && !nativeMaintenanceMarker(entry))) return null;
    const origin = entry.context?.native;
    const native = origin?.event ?? origin;
    if (origin?.event && origin.sessionId && Number.isSafeInteger(native.seq)) {
      // One native event can project to several ContextRecords. Archive it once,
      // reusing the existing intake normalizer, never its temporary projection index.
      const nativeKey = `native-ref:${digest(canonical([origin.sessionId, native]))}`;
      const savedRef = this.journal.meta(nativeKey);
      if (savedRef) return savedRef; // A config change never re-identifies an already captured original.
      const parsed = normalizeEvent(native, this.config.captureReasoning !== false);
      const control = ['system', 'developer'].includes(entry.item.role) || native.type === 'system/message';
      const content = control ? textOf(entry) : parsed.text;
      const raw = { sessionId: origin.sessionId, event: native };
      const date = new Date(native.time);
      if (native.time != null && Number.isFinite(date.getTime())) raw.ts = date.toISOString();
      const message = native.data?.message ?? native.data;
      const source = message?.source ?? native.source;
      const plugin = source?.kind === 'plugin' ? source.plugin : undefined;
      // DSH can project a compact checkpoint or maintenance marker as a
      // user/message. Its protocol role must never turn it into a human original.
      const isCheckpoint = plugin === 'compact' || native.type === 'compaction/summary';
      const derived = control || isCheckpoint || ['cortico-native-maintenance', 'cortico-native-handoff'].includes(plugin);
      const kind = derived ? (isCheckpoint ? 'checkpoint' : 'context')
        : ['user/message', 'assistant/message'].includes(native.type) ? 'conversation' : 'context';
      const ref = this.captureOriginal({ kind,
        sessionId: origin.sessionId, key: `native:${native.seq}`, raw, content,
        role: control ? (entry.item.role ?? 'system') : parsed.role,
        ...(this.config.captureReasoning !== false && parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
        ...(derived ? { derived: true, transitional: true } : {}),
      });
      this.journal.meta(nativeKey, ref);
      return ref;
    }
    const reasoning = this.config.captureReasoning !== false
      ? extractReasoning(entry.item) || extractReasoning(native?.data?.message ?? native) : null;
    const control = ['system', 'developer'].includes(entry.item.role);
    return this.captureOriginal({
      kind: control ? 'context' : entry.item.role ? 'conversation' : 'context',
      sessionId,
      key: `${entry.item.id ?? entry.item.call_id ?? digest(canonical(entry))}`,
      raw: entry,
      content: textOf(entry),
      ...(reasoning ? { reasoning } : {}),
      ...(control ? { derived: true, transitional: true } : {}),
      role: entry.item.role ?? entry.item.type,
      itemId: entry.item.id ?? null,
    });
  }

  flush({ onlyPending = false } = {}) {
    if (this.disposed) return Promise.reject(new Error('MEM_PERSONA_DISPOSED'));
    const call = this.flushTail.catch(() => {}).then(async () => {
      const rows = this.journal.rows(true);
      if (onlyPending && !rows.length) return null;
      for (const row of rows) {
        await this.facet.mem.ingestSource({
          sourceId: row.sourceId,
          agentId: this.agentId,
          sessionId: row.sessionId || this.sourceSessionId,
          channel: 'cortico',
          role: row.role || 'user',
          content: row.content || '',
          reasoning: row.reasoning || null,
          createdAt: this.sourceCreatedAt(row.sourceId, row.original),
          original: row.original,
          kind: row.kind,
          deviceId: row.deviceId,
          ...(row.derived !== undefined ? { derived: row.derived } : {}),
          ...(row.transitional !== undefined ? { transitional: row.transitional } : {}),
          ...(row.derivedFrom !== undefined ? { derivedFrom: row.derivedFrom } : {}),
        });
      }
      const stats = await this.facet.mem.stats();
      this.journal.acknowledge(rows, stats.headCommit || 'synced');
      this.lastError = null;
      return stats;
    }).catch((err) => {
      this.lastError = err.code ?? err.message;
      throw err;
    });
    this.flushTail = call;
    return call;
  }

  schedule() {
    if (this.disposed || this.stopping || this.scheduled || !this.journal.pendingCount()) return;
    this.scheduled = (async () => {
      do { await this.flush({ onlyPending: true }); }
      while (!this.stopping && this.journal.pendingCount());
    })().catch((err) => {
      this.core?.log?.warn?.('Originals retained in CaptureJournal; sync pending', { code: err.code ?? err.message });
    }).finally(() => {
      this.scheduled = null;
    });
  }

  async start({ core } = {}) {
    this.runtime = core;
    if (core?.session) {
      this.sourceSessionId = core.session.sourceSessionId || MAIN;
      this.hasStableSourceSessionId = typeof core.session.sourceSessionId === 'string'
        && core.session.sourceSessionId.length > 0;
      this.loadSessionHandoffState();
      this.guidanceRestoredOnStart = Boolean(this.memoryGuidanceForSession({ select: false }));
      this.memoryGuidanceForSession();
      const observe = (records, sessionId) => {
        if (this.disposed || this.stopping) return;
        const before = this.journal.revision;
        for (const r of records) this.captureRecord(r, sessionId);
        if (this.journal.revision !== before) this.schedule();
      };
      core.session.onAppend?.((entry) => observe([entry], this.sourceSessionId));
      core.session.onReset?.((entries) => observe(entries, this.sourceSessionId));
      if (Array.isArray(core.session.records)) observe(core.session.records, this.sourceSessionId);
    }
    this.memoryGuidanceForSession();
    await this.flush();
    if (this.config.memoryIngress?.enabled && !this.memoryIngress) {
      const cfg = this.config.memoryIngress;
      this.memoryIngress = createMemoryBaseCompat({ mem: this.facet.mem, instance: cfg.instance ?? 'tina-main',
        ownerId: cfg.ownerId ?? 'local-owner', onRefresh: () => {
          this.bumpPrefixRevision(); return { state: 'scheduled', applies: 'next-turn' };
        } });
      await this.memoryIngress.listen(cfg.port ?? 8895, cfg.host ?? '127.0.0.1');
    }
  }

  async onDelivery({ events = [] } = {}) {
    for (const event of events) {
      this.captureOriginal({
        kind: 'event',
        sessionId: this.sourceSessionId,
        key: `${event.run ?? ''}:${event.source}:${event.cursor}`,
        raw: event,
        content: event.text ?? '',
        role: event.origin ?? 'external',
      });
    }
    await this.flush();

    try {
      // 只在批内有真实外部输入时挂尾部：注入自身产生的事件绝不能再次触发注入，
      // 否则会自我喂食、跑满轮次上限而答不出话（2026-11-18 实测死循环）。
      // 尾部注入会落成一条 user 消息；若它落在轮次中途，会打断正在流式的那一批，
      // 表现为批次以 error 结束、llmStall 增长、回复作废（2026-11-18 实测）。
      // 前缀缓存的收益与尾部无关（动态内容本就已移出 system 前缀），故默认关闭，
      // 需要时在 selfMem 配置里置 tailInjection: true 再开。
      if (this.config.tailInjection !== true) return;
      if (!events.some((event) => (event?.origin ?? 'external') !== 'internal')) return;
      const tail = await this.facet.mem.getTailBlock?.({
        agentId: this.agentId,
        sourceSessionId: this.sourceSessionId,
        channel: 'cortico',
        pulseLimit: this.config.pulseLimit,
        includePulse: true,
        includeFooter: true,
        includeLedger: true,
        ledgerAgentId: this.agentId,
      });
      if (!tail || !tail.text) return;
      if (tail.digest === this.lastTailDigest) return;
      this.lastTailDigest = tail.digest;
      this.runtime?.loop?.injectInternal?.(tail.text, 'mem.pulse');
    } catch (error) {
      this.lastError = error?.code ?? error?.message ?? String(error);
      this.core?.log?.warn?.('Memory tail injection skipped', { code: this.lastError });
    }
  }

  onOpening({ reason } = {}) {
    if (reason === 'cleared' || (reason === 'new' && this.guidanceRestoredOnStart && !this.hasStableSourceSessionId)) {
      // Official SessionLog can reuse "main" after clear. This epoch affects
      // guidance only, never re-identifies captured originals.
      this.journal.meta('memory-guidance-epoch', String(++this.guidanceEpoch));
      this.memoryGuidanceForSession();
      // Core clears after building its prefix; queue the replacement at its
      // next safe boundary, without awaiting from this synchronous hook.
      this.bumpPrefixRevision();
    }
    if (['new', 'restarted', 'cleared'].includes(reason)) {
      this.guidanceRestoredOnStart = false;
      this.lastTailDigest = null;
    }
    this.schedule();
  }
  onTurnEnded() { this.schedule(); }

  async systemSegments(context = {}) {
    const guidance = this.memoryGuidanceForSession();
    const windowKey = `${this.sourceSessionId}:${this.window}${this.prefixRevision ? `:r${this.prefixRevision}` : ''}`;
    let cached = this.journal.prefix(windowKey);
    if (!cached) {
      await this.flush();
      const snap = await this.facet.mem.getSystemBlock({
        sessionId: windowKey,
        sourceSessionId: this.sourceSessionId,
        channel: 'cortico',
        agentId: this.agentId,
        includePulse: false,
        includeFooter: false,
        includeLedger: false,
        forceRefresh: false,
      });
      const baseSegments = [];
      if (this.seed) baseSegments.push({ title: '部署种子', text: this.seed, sourceKey: 'selfMem.seed' });
      baseSegments.push({ ...guidance.segment, text: this.guidanceText(guidance) });
      baseSegments.push({ title: '自我与记忆画布', text: snap.text, sourceKey: 'selfMem.canvas' });
      cached = { sessionId: windowKey, headCommit: snap.headCommit,
        bodyRevision: snap.bodyRevision ?? null, segments: baseSegments };
      this.journal.prefix(windowKey, cached);
    }
    return [
      ...structuredClone(cached.segments),
      ...(context.worlds ?? []).map((world) => ({
        title: world.id,
        text: world.envPrompt,
        ...(world.sourceKey ? { sourceKey: world.sourceKey } : {}),
      })),
    ];
  }

  bumpPrefixRevision() {
    this.journal.meta('prefix-revision', String(++this.prefixRevision));
    if (this.runtime?.loop?.reloadSystemPrefix) {
      Promise.resolve(this.runtime.loop.reloadSystemPrefix()).catch((err) => {
        this.lastError = err.code ?? err.message;
      });
    }
  }

  guidanceText(snapshot = this.memoryGuidanceForSession({ select: false })) {
    return this.journal.meta('memory-guidance-override') ||
      (snapshot ?? buildMemoryGuidance(this.config.memoryGuidance)).segment.text;
  }

  async promptDocs() {
    const rawCanvas = (await this.facet.mem.readSelfRaw()).replace(/\r\n/g, '\n');
    const stats = await this.facet.mem.stats({
      excludeAgent: this.agentId,
      excludeSession: this.sourceSessionId,
      excludeChannel: 'cortico',
    });
    const pulsePreview = (stats.recentPulse ?? []).length
      ? stats.recentPulse.map((p) => `- [${p.window}${p.createdAt ? ` · ${p.createdAt.slice(0, 16)}Z` : ''} · ${p.turns}条] “${p.preview}” → [${p.ref}]`).join('\n')
      : '（当前暂无其他窗口的新增对话脉搏）';

    const guidanceContent = this.guidanceText();
    const docs = [
      {
        key: 'selfMem.memoryGuidance',
        title: '记忆使用引导 (Memory Guidance)',
        description: '按会话冻结的记忆引导段（minimal / guided 四开关可在调优台配置，下一新会话或清空重开生效；也可在此直接自定义覆盖本段文本）。',
        scope: 'persona',
        role: 'prefix',
        origin: this.journal.meta('memory-guidance-override') ? 'deployment' : 'module',
        content: guidanceContent,
        revision: digest(guidanceContent),
      },
      {
        key: 'selfMem.canvas',
        title: '自我与记忆画布 (TINA_SELF.md)',
        description: '跨窗口共用的常驻自我认知与清晰/模糊记忆画布。保存后直接提交进 SharedGitMem 并在下一轮生效。',
        scope: 'persona',
        role: 'prefix',
        origin: 'deployment',
        content: rawCanvas,
        revision: digest(rawCanvas),
        vars: [
          {
            name: 'recent_pulse',
            description: '底座自动附在画布下方的跨窗口近期余光（只读实时预览）',
            multiline: true,
            value: pulsePreview,
          },
        ],
      },
    ];

    if (this.config.seedFile || this.seed) {
      docs.unshift({
        key: 'selfMem.seed',
        title: '部署种子 (SEED.md)',
        description: '当前部署的前置种子提示词（留空则不注入该段）。',
        scope: 'persona',
        role: 'prefix',
        origin: 'deployment',
        content: this.seed,
        revision: digest(this.seed),
      });
    }
    return docs;
  }

  async writePromptDoc(key, content, baseRevision) {
    const normalized = String(content ?? '').replace(/\r\n?/g, '\n');
    if (key === 'selfMem.memoryGuidance') {
      if (baseRevision !== undefined && baseRevision !== digest(this.guidanceText())) {
        throw Object.assign(new Error('记忆使用引导已被修改，请刷新后再保存。'), { code: 'PROMPT_CONFLICT' });
      }
      if (normalized === '') this.journal.db.prepare('DELETE FROM meta WHERE key=?').run('memory-guidance-override');
      else this.journal.meta('memory-guidance-override', normalized);
      this.bumpPrefixRevision();
      return '记忆使用引导已保存，下一轮生效。';
    }
    if (key === 'selfMem.canvas') {
      const current = (await this.facet.mem.readSelfRaw()).replace(/\r\n/g, '\n');
      if (baseRevision !== undefined && baseRevision !== digest(current)) {
        throw Object.assign(new Error('TINA_SELF.md 已被其他窗口更新，请刷新后再保存。'), { code: 'PROMPT_CONFLICT' });
      }
      await this.facet.mem.patchSelf({
        action: 'rewrite',
        oldText: '*',
        newText: normalized.trim() ? normalized : '# 我（Tina）的自我与记忆画布\n',
        reason: '在 System 工作台直接编辑常驻画布',
        agentId: this.agentId,
      });
      this.bumpPrefixRevision();
      return '常驻自我画布已保存至共同记忆底座，下一轮生效。';
    }
    if (key === 'selfMem.seed') {
      if (baseRevision !== undefined && baseRevision !== digest(this.seed)) {
        throw Object.assign(new Error('部署种子已被修改，请刷新后再保存。'), { code: 'PROMPT_CONFLICT' });
      }
      const relSeed = this.config.seedFile || 'prompts/SEED.md';
      const targetPath = resolve(this.loaded.rootDir, relSeed);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, normalized, 'utf8');
      this.config.seedFile = relSeed;
      this.seed = normalized;
      this.bumpPrefixRevision();
      return '部署种子已保存，下一轮生效。';
    }
    return null;
  }

  async configureRuntime(patch = {}) {
    let nextGuidance = null;
    if (patch.memoryGuidance !== undefined) {
      normalizeMemoryGuidance(patch.memoryGuidance);
      const current = normalizeMemoryGuidance(this.config.memoryGuidance);
      const provided = Object.fromEntries(Object.entries(patch.memoryGuidance).filter(([, value]) => value !== undefined));
      nextGuidance = normalizeMemoryGuidance({ ...current, ...provided,
        rules: { ...current.rules, ...patch.memoryGuidance.rules } });
    }
    if (patch.maxSelfChars !== undefined) {
      const n = Number(patch.maxSelfChars);
      if (!Number.isInteger(n) || n < 500 || n > 200000) throw new Error('maxSelfChars 需在 500 ~ 200000 之间');
      this.config.maxSelfChars = n;
      this.facet.mem.maxSelfChars = n;
    }
    if (patch.pulseLimit !== undefined) {
      const n = Number(patch.pulseLimit);
      if (!Number.isInteger(n) || n < 0 || n > 30) throw new Error('pulseLimit 需在 0 ~ 30 之间');
      this.config.pulseLimit = n;
      this.facet.mem.pulseLimit = n;
    }
    if (patch.captureReasoning !== undefined) {
      this.config.captureReasoning = Boolean(patch.captureReasoning);
    }
    if (patch.rounds !== undefined) {
      const nextRounds = roundCaps(patch.rounds, { soft: 4, hard: 8 });
      this.config.rounds = nextRounds;
    }
    if (nextGuidance) this.config.memoryGuidance = nextGuidance;

    const cfgPath = join(this.loaded.rootDir, 'config.json');
    let diskCfg = {};
    if (existsSync(cfgPath)) {
      try { diskCfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch {}
    }
    diskCfg.selfMem = {
      ...(diskCfg.selfMem || {}),
      maxSelfChars: this.config.maxSelfChars ?? this.facet.mem.maxSelfChars ?? 16000,
      pulseLimit: this.config.pulseLimit ?? this.facet.mem.pulseLimit ?? 6,
      captureReasoning: this.config.captureReasoning !== false,
      rounds: roundCaps(this.config.rounds, { soft: 4, hard: 8 }),
      memoryGuidance: normalizeMemoryGuidance(this.config.memoryGuidance),
    };
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2) + '\n', 'utf8');
    // maxSelfChars / pulseLimit / captureReasoning / rounds do not alter L0 prefix bytes;
    // keep prefixRevision stable so active conversation prefix caches remain valid.
    return await this.status();
  }

  sessionHead() {
    if (!this.handoff) return [];
    const id = `handoff-${digest(this.handoff.ref).slice(0, 20)}`;
    return [
      { type: 'function_call', id: `${id}-call`, call_id: id, name: 'mem_handoff_context', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', id: `${id}-result`, call_id: id, output: this.handoff.content, status: 'completed' },
    ];
  }

  /** Optional short guidance for native context compaction; source text is not copied here. */
  contextCompactionInstruction({ sessionId, snapshot, signal } = {}) {
    signal?.throwIfAborted();
    return '请用原语言整理，只保留原文中存在的身份与关系、场景与情绪连续性、说话习惯、用户边界和未完成事项；区分事实、推断与尚未确认的内容，保留必要的来源线索。不要回填完整人格设定或整段原文。';
  }

  /** Prepare source captures and a navigation index, without changing the
   * active window. Source coverage is not a semantic summary or permission to
   * clear the native surface. The coordinator owns the latter decision. */
  async prepareContextHandoff({ operationId, generation, snapshot } = {}) {
    if (typeof operationId !== 'string' || !operationId.trim()) throw handoffError('HANDOFF_OPERATION_REQUIRED');
    if (!['string', 'number'].includes(typeof generation) || (typeof generation === 'number' && !Number.isSafeInteger(generation))
      || generation === '') throw handoffError('HANDOFF_GENERATION_REQUIRED');
    if (!Array.isArray(snapshot)) throw handoffError('HANDOFF_SNAPSHOT_REQUIRED');
    const sessionId = this.sourceSessionId;
    this.loadSessionHandoffState(sessionId);
    const generationKey = canonical(generation);
    const snapshotDigest = digest(canonical(snapshot));
    const existing = this.journal.db.prepare('SELECT * FROM handoff_operations WHERE session_id=? AND operation_id=?')
      .get(sessionId, operationId);
    if (existing) {
      const payload = JSON.parse(existing.payload);
      if (existing.session_id !== sessionId || existing.generation !== generationKey || payload.snapshotDigest !== snapshotDigest)
        throw handoffError('HANDOFF_OPERATION_CONFLICT');
      return { ...payload, phase: existing.phase, retainedTail: structuredClone(snapshot) };
    }

    const expectedWindow = this.window;
    const originals = [];
    const seenRefs = new Set();
    const seenSeqs = new Set();
    const seqRefs = new Map();
    let complete = true;
    for (const entry of snapshot) {
      if (!entry?.item) { complete = false; continue; }
      if (entry.context?.head) continue;
      const origin = entry.context?.native;
      const seq = origin?.event?.seq ?? origin?.seq ?? entry.context?.nativeSeq;
      if (entry.context?.ephemeral && !nativeMaintenanceMarker(entry)) {
        if (seq !== undefined) complete = false;
        continue;
      }
      const candidates = [origin?.event?.seq, origin?.seq, entry.context?.nativeSeq].filter(value => value !== undefined);
      const stable = Number.isSafeInteger(seq) && seq >= 0 && !candidates.some(value => value !== seq)
        && origin?.sessionId === sessionId && Number.isSafeInteger(origin?.event?.seq);
      if (!stable) complete = false;
      const ref = this.captureRecord(entry, sessionId);
      if (!ref) { complete = false; continue; }
      if (stable) {
        seenSeqs.add(seq);
        if (!seqRefs.has(seq)) seqRefs.set(seq, new Set());
        seqRefs.get(seq).add(ref);
      }
      if (!seenRefs.has(ref)) { seenRefs.add(ref); originals.push({ entry, ref }); }
    }
    const refs = originals.map((r) => r.ref);
    const excerpt = (v) => Array.from(String(v).replace(/\s+/gu, ' ').trim()).slice(0, 120).join('');
    const lines = originals.slice(-50).map(({ entry, ref }) => {
      const native = entry.context?.native?.event;
      const parsed = native ? normalizeEvent(native) : null;
      return `${ref} [${excerpt(parsed?.role ?? entry.item.role ?? entry.item.type)}] ${excerpt(parsed?.text || textOf(entry))}`;
    });
    const content = `刚收拢的上一窗口对话脉络（可随时调 mem_read 按 ref 展开完整上下文）：\n${lines.join('\n')}`;
    const ref = this.captureOriginal({
      kind: 'handoff',
      sessionId: this.sourceSessionId,
      key: `prepare:${operationId}`,
      raw: { refs, snapshotDigest },
      content,
      derived: true,
      transitional: true,
      derivedFrom: refs,
    });
    await this.flush();
    const replicated = this.journal.db.prepare('SELECT 1 FROM replicated WHERE source_id=?');
    if ([...refs, ref].some(id => !replicated.get(id.slice(4)))) throw handoffError('HANDOFF_CAPTURE_NOT_ACKNOWLEDGED');
    if (this.handoffSessionState(sessionId).window !== expectedWindow)
      throw handoffError('HANDOFF_WINDOW_CHANGED');
    const payload = { operationId, generation, sessionId, expectedWindow, snapshotDigest,
      sourceCoverage: { kind: 'captured-originals', complete, sourceRefs: refs, snapshotIds: [...seenSeqs],
        seqRefs: [...seqRefs].map(([seq, ids]) => ({ seq, refs: [...ids] })),
        assurance: 'journal-and-ingest-ack' },
      semanticCoverage: null, navigation: { ref, content: `${content}\n交接索引：${ref}` } };
    this.journal.db.prepare(`INSERT OR IGNORE INTO handoff_operations
      (operation_id,session_id,generation,expected_window,payload,phase) VALUES (?,?,?,?,?,'prepared')`)
      .run(operationId, sessionId, generationKey, expectedWindow, canonical(payload));
    const saved = this.journal.db.prepare('SELECT * FROM handoff_operations WHERE session_id=? AND operation_id=?')
      .get(sessionId, operationId);
    if (saved.session_id !== sessionId || saved.generation !== generationKey || saved.payload !== canonical(payload))
      throw handoffError('HANDOFF_OPERATION_CONFLICT');
    return { ...payload, phase: saved.phase, retainedTail: structuredClone(snapshot) };
  }

  /** Called only with a native durable-commit receipt verified by the owner. */
  async commitContextHandoff({ operationId, generation, nativeReceipt } = {}) {
    if (typeof operationId !== 'string' || !operationId) throw handoffError('HANDOFF_OPERATION_REQUIRED');
    const db = this.journal.db;
    if (!nativeReceipt || nativeReceipt.sessionId !== this.sourceSessionId) throw handoffError('HANDOFF_RECEIPT_MISMATCH');
    const row = db.prepare('SELECT * FROM handoff_operations WHERE session_id=? AND operation_id=?')
      .get(this.sourceSessionId, operationId);
    if (!row) throw handoffError('HANDOFF_NOT_PREPARED');
    const payload = JSON.parse(row.payload);
    const receipt = nativeReceipt;
    if (!receipt || receipt.durable !== true || receipt.method !== 'native-compact'
      || receipt.operationId !== operationId || receipt.sessionId !== row.session_id
      || canonical(receipt.generation) !== row.generation || canonical(generation) !== row.generation
      || this.sourceSessionId !== row.session_id) throw handoffError('HANDOFF_RECEIPT_MISMATCH');
    const coverage = receipt.coverage;
    if (!payload.sourceCoverage.complete || !coverage || coverage.sourceComplete !== true
      || coverage.snapshotDigest !== payload.snapshotDigest || !Array.isArray(coverage.coveredNativeSeqs)
      || !Array.isArray(coverage.protectedNativeSeqs)) throw handoffError('HANDOFF_COVERAGE_UNVERIFIED');
    const covered = coverage.coveredNativeSeqs;
    const protectedSeqs = coverage.protectedNativeSeqs;
    const sources = payload.sourceCoverage;
    if ([...covered, ...protectedSeqs].some(seq => !Number.isSafeInteger(seq) || seq < 0)
      || !Array.isArray(sources.seqRefs) || covered.some(seq => {
        const matches = sources.seqRefs.filter(item => item.seq === seq);
        return !sources.snapshotIds.includes(seq) || protectedSeqs.includes(seq) || matches.length !== 1
          || !Array.isArray(matches[0].refs) || matches[0].refs.length === 0
          || matches[0].refs.some(ref => !sources.sourceRefs.includes(ref));
      }))
      throw handoffError('HANDOFF_COVERAGE_UNVERIFIED');
    const receiptText = canonical(receipt);
    db.exec('BEGIN IMMEDIATE');
    let window;
    try {
      const current = db.prepare('SELECT * FROM handoff_operations WHERE session_id=? AND operation_id=?')
        .get(row.session_id, operationId);
      if (current.phase === 'committed') {
        if (current.receipt !== receiptText) throw handoffError('HANDOFF_RECEIPT_CONFLICT');
        window = current.expected_window + 1;
      } else {
        const activeState = this.handoffSessionState(row.session_id);
        const activeWindow = activeState.window;
        if (current.phase !== 'prepared' || activeWindow !== current.expected_window)
          throw handoffError('HANDOFF_WINDOW_CHANGED');
        if (db.prepare(`SELECT 1 FROM handoff_operations WHERE session_id=? AND generation=?
          AND phase='committed' AND operation_id<>? LIMIT 1`).get(row.session_id, row.generation, operationId))
          throw handoffError('HANDOFF_GENERATION_CONFLICT');
        window = activeWindow + 1;
        this.journal.meta(`${activeState.prefix}:head`, JSON.stringify(payload.navigation));
        this.journal.meta(`${activeState.prefix}:window`, String(window));
        if (activeState.anchor === row.session_id) {
          this.journal.meta('handoff', JSON.stringify(payload.navigation));
          this.journal.meta('main-window', String(window));
        }
        db.prepare("UPDATE handoff_operations SET phase='committed',receipt=? WHERE session_id=? AND operation_id=? AND phase='prepared'")
          .run(receiptText, row.session_id, operationId);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // Refresh from the journal after commit, including a retry after a crash.
    this.loadSessionHandoffState(row.session_id);
    return { operationId, generation, sessionId: row.session_id, window, phase: 'committed', navigationRef: payload.navigation.ref };
  }

  async reconcileContextHandoff(args) { return this.commitContextHandoff(args); }

  /** Ordinary Cortico hosts know only the API-7 hook. They retain ownership of
   * their existing tail policy; the optional transactional coordinator is not
   * assumed to exist and no window is advanced without its durable receipt. */
  async onHandoff(snapshot = []) {
    const operationId = 'legacy:' + digest(canonical([this.sourceSessionId, this.window, snapshot]));
    await this.prepareContextHandoff({ operationId, generation: 'legacy', snapshot });
    return { tail: null };
  }

  tools() {
    return this.facet.tools.map((decl) => ({
      ...decl,
      handler: async (args, ctx) => {
        ctx?.signal?.throwIfAborted?.();
        await this.flush({ onlyPending: true });
        if (decl.name === 'mem_read' && typeof args?.ref === 'string') {
          const oldId = args.ref.replace(/^\[|\]$/g, '').replace(/^src:/, '');
          if (/^evt_[a-f0-9]{64}$/.test(oldId)) args = { ...args, ref: 'src:' + foundationSourceId(oldId,
            this.config.memoryIngress?.instance ?? 'tina-main', this.config.memoryIngress?.ownerId ?? 'local-owner') };
        }
        if (decl.name !== 'self_memory_read') return await decl.handler(args);
        const result = JSON.parse(await decl.handler(args));
        if (args?.refreshSystem) {
          if (!this.runtime?.loop?.reloadSystemPrefix) {
            result.refresh = { requested: false, reason: 'host-refresh-unavailable' };
          } else {
            this.journal.meta('prefix-revision', String(++this.prefixRevision));
            await this.systemSegments();
            // Native Core resolves this at a batch boundary: awaiting it inside a tool deadlocks.
            Promise.resolve(this.runtime.loop.reloadSystemPrefix()).catch((err) => {
              this.lastError = err.code ?? err.message;
              this.core?.log?.warn?.('Memory prefix refresh failed', { code: this.lastError });
            });
            result.refresh = { requested: true, applies: 'next-turn' };
          }
        }
        return JSON.stringify(result);
      },
    }));
  }

  outputTap() {
    const taps = this.worlds.flatMap((w) => { const tap = w.outputTap?.(); return tap ? [tap] : []; });
    if (!taps.length) return undefined;
    if (taps.length === 1) return taps[0];
    const externalizes = (e) => e.type === 'response.output_text.delta' || e.type === 'response.refusal.delta'
      || (e.type === 'response.output_item.added' && e.item?.type === 'function_call');
    return {
      onEvent: (e) => { for (const t of taps) t.onEvent(e); },
      externalizes: (e) => taps.some((t) => t.externalizes?.(e) ?? externalizes(e)),
      onRoundEnd: () => { for (const t of taps) t.onRoundEnd?.(); },
      onStep: (s) => { for (const t of taps) t.onStep?.(s); },
      onAbort: (r) => { for (const t of taps) t.onAbort?.(r); },
    };
  }

  webUi() {
    return { memory: { panels: [] }, invoke: async () => { throw new Error('NO_PANEL'); } };
  }

  declareSessions() {
    const self = this;
    return [
      {
        id: MAIN,
        label: 'Tina Main',
        persistent: true,
        receivesEvents: true,
        get outputTap() { return self.outputTap(); },
        rounds: () => roundCaps(this.config.rounds, { soft: 4, hard: 8 }),
        tools: () => [...this.tools(), ...this.extraTools, ...this.worlds.flatMap((w) => w.tools()), endTurn],
      },
    ];
  }

  async status() {
    const activeGuidance = this.memoryGuidanceForSession({ select: false });
    const windowKey = `${this.sourceSessionId}:${this.window}${this.prefixRevision ? `:r${this.prefixRevision}` : ''}`;
    return {
      ...(await this.facet.status()),
      pulseLimit: this.config.pulseLimit ?? this.facet.mem.pulseLimit ?? 6,
      captureReasoning: this.config.captureReasoning !== false,
      rounds: roundCaps(this.config.rounds, { soft: 4, hard: 8 }),
      pendingCaptures: this.journal.pendingCount(),
      window: this.window,
      prefixRevision: this.prefixRevision,
      memoryGuidance: {
        configured: normalizeMemoryGuidance(this.config.memoryGuidance),
        active: activeGuidance ? { version: activeGuidance.version, mode: activeGuidance.mode, rules: activeGuidance.rules } : null,
        applied: Boolean(activeGuidance && this.journal.prefix(windowKey)?.segments
          .some(segment => segment.sourceKey === 'selfMem.memoryGuidance' && segment.text === this.guidanceText(activeGuidance))),
        applies: 'next-session',
      },
      lastError: this.lastError,
    };
  }

  dispose() {
    if (this.disposing) return this.disposing;
    if (this.disposed) return Promise.resolve();
    this.stopping = true;
    this.disposing = (async () => {
      const errors = [];
      const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
      await attempt(() => this.memoryIngress?.close());
      if (this.scheduled) await attempt(() => this.scheduled);
      await attempt(() => this.flush({ onlyPending: true }));
      this.disposed = true;
      await attempt(() => this.journal.close());
      await attempt(() => this.facet.close());
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'SelfMem Persona shutdown failed.');
    })();
    return this.disposing;
  }
}

export function createTinaSelfMemBot({ extraTools = [], mem = null, getCoreDefaults = loadCoreDefaults } = {}) {
  const toolNames = ['self_memory_read', 'self_memory_patch', 'mem_ledger', 'mem_search', 'mem_read', 'mem_note'];
  return {
    id: 'tina-self-mem',
    memoryName: 'TinaSelfMem',
    declares: [],
    defaults: () => ({
      ...structuredClone(getCoreDefaults()),
      displayName: 'Tina',
      selfMem: {
        agentId: 'cortico-tina',
        dataDir: '',
        authorityDir: '',
        deviceDir: '',
        legacyRecall: { enabled: false },
        remoteUrl: '',
        remoteToken: '',
        seedFile: '',
        maxSelfChars: 16000,
        captureReasoning: true,
        memoryGuidance: normalizeMemoryGuidance(),
        memoryIngress: { enabled: false, host: '127.0.0.1', port: 8895, instance: 'tina-main', ownerId: 'local-owner' },
        rounds: { soft: 4, hard: 8 },
      },
    }),
    build(loaded, worlds = []) {
      const persona = new TinaSelfMemPersona(loaded, worlds, { mem, extraTools });
      return {
        persona,
        onStart: (context) => persona.start(context),
        onStop: () => persona.dispose(),
        webUi: {
          status: () => ({ pendingCaptures: persona.journal.pendingCount(), window: persona.window, lastError: persona.lastError }),
        },
      };
    },
    describe: {
      tools: [
        ...toolNames.map((name) => ({
          name,
          description: 'Tina 连续自我画布与全生命周期原文调取工具。',
          tags: [['self_memory_patch', 'mem_ledger', 'mem_note'].includes(name) ? 'write' : 'read', 'memory'],
          parameters: { type: 'object', properties: {} },
        })),
        { name: 'end_turn', description: '结束当前轮次。', tags: ['flow'], parameters: { type: 'object', properties: {} } },
        ...extraTools.map(({ handler, execute, ...declaration }) => declaration),
      ],
      memory: {
        form: 'TINA_SELF.md 连续自我画布 + 跨窗口近期余光 + SharedGitMem 全生命周期原文按需调阅。',
      },
    },
  };
}

export default createTinaSelfMemBot();
