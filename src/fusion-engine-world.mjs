const methods = new Set([
  'status', 'credential', 'model', 'mode', 'approval', 'cancel', 'autonomy', 'execution',
  'providerSelect', 'memoryConfig', 'memoryReload', 'worldVisibility', 'personaProfile',
]);
const publicFields = [
  'provider', 'model', 'mode', 'models', 'credentialConfigured', 'approvals',
  'usage', 'timing', 'lastFailure', 'autonomousWork', 'state', 'activity', 'operation',
  'intentions', 'extensions',
  'providerName', 'providerKind', 'credentialMode', 'modelListError',
  'thinking', 'reasoningEffort', 'reasoningEfforts', 'nativeSelection', 'lastRequestSelection', 'reasoningEffortPending', 'reasoningEffortError',
  'execution', 'providers', 'memory', 'worlds', 'systemSummary', 'workspaceDir', 'personaProfile',
];

function publicStatus(value) {
  if (!value || typeof value !== 'object') throw new Error('Native engine status is unavailable.');
  return Object.fromEntries(publicFields.filter(name => value[name] !== undefined).map(name => [name, structuredClone(value[name])]));
}

export function createFusionEngineWorld({ handle, currentModel, initialStatus }) {
  if (typeof handle !== 'function') throw new Error('Native engine controls require a handler.');
  let active = false;
  let status;
  let generation = 0;
  const world = {
    id: 'native-engine',
    envPromptVars: () => null,
    tools: () => [],
    async start() {
      active = true;
      generation++;
      try { status = publicStatus(await (initialStatus ? initialStatus() : handle('status'))); }
      catch { status = undefined; }
    },
    async stop() { active = false; generation++; },
    webUi() {
      const current = currentModel ? { ...status, ...currentModel() } : status;
      return {
        label: '模型与全局调优台',
        lamps: [{
          label: '原生执行内核',
          state: !active ? 'offline' : current?.modelListError?.endsWith('_UNCONFIGURED') ? 'loading'
            : current?.credentialMode === 'provider' || current?.credentialConfigured ? 'online' : 'loading',
          hint: current?.modelListError?.endsWith('_UNCONFIGURED') ? '请在模型提供商页面选择模型'
            : current?.credentialMode === 'provider' ? String(current.model ?? '') + ' · 凭据由模型提供商管理'
            : current?.credentialConfigured ? String(current.model ?? '') : '请配置官方 API Key',
        }],
        panels: [{
          id: 'engine', title: '模型、记忆与执行调优台', description: '全展开配置：模型连接、执行策略、记忆画布参数、World 可见性、自主意图与插件状态。', getMethods: ['status'],
        }],
        async invoke(panel, method, args = []) {
          if (!active) throw new Error('Native engine controls are stopped.');
          if (panel !== 'engine' || !methods.has(method)) throw new Error('Unknown native engine method.');
          if (!Array.isArray(args) || args.length > 1) throw new Error('Invalid native engine arguments.');
          const body = args[0] ?? {};
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid native engine arguments.');
          if (method === 'credential' && (typeof body.value !== 'string' || !body.value.trim() || body.value.length > 4096)) {
            throw new Error('Invalid credential.');
          }
          if (method === 'autonomy' && typeof body.enabled !== 'boolean') throw new Error('Invalid autonomous work setting.');
          const current = generation;
          const result = await handle(method, body);
          if (!active || generation !== current) throw new Error('Native engine controls were reloaded.');
          if (method === 'status') {
            status = publicStatus(result);
            return status;
          }
          return { ok: true };
        },
      };
    },
  };
  return world;
}

export function mountFusionEngineWorld(ctx, options) {
  const world = createFusionEngineWorld(options);
  ctx.effect(() => () => world.stop());
  return world;
}
