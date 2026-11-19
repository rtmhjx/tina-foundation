export const toolModes = ['native', 'discover', 'ptc', 'both'];
const fail = code => Object.assign(new Error(code), { code });
const copy = value => structuredClone(value);

export function validateExecutionPolicy(value) {
  if (!value || !toolModes.includes(value.defaultMode) || !Array.isArray(value.routes) || value.routes.length > 100) throw fail('INVALID_EXECUTION_POLICY');
  if (!Number.isInteger(value.maxInlineBytes) || value.maxInlineBytes < 1024 || value.maxInlineBytes > 1048576) throw fail('INVALID_RESULT_BUDGET');
  const seen = new Set();
  for (const rule of value.routes) {
    if (!rule || !toolModes.includes(rule.mode) || !['provider', 'model'].every(key =>
      typeof rule[key] === 'string' && rule[key].length > 0 && rule[key].length <= 200 && !/[\u0000-\u001f]/.test(rule[key]))) throw fail('INVALID_EXECUTION_ROUTE');
    const key = JSON.stringify([rule.provider, rule.model]);
    if (seen.has(key)) throw fail('DUPLICATE_EXECUTION_ROUTE');
    seen.add(key);
  }
  return value;
}

/** Only whole-field wildcards; no guessed model families or vendor heuristics. */
export function resolveExecutionPolicy(config, route, rp = false) {
  validateExecutionPolicy(config);
  const ranked = config.routes.filter(rule => [ 'provider', 'model' ].every(key => rule[key] === '*' || rule[key] === route[key]))
    .map(rule => ({ rule, rank: Number(rule.provider !== '*') * 2 + Number(rule.model !== '*') }))
    .sort((a, b) => b.rank - a.rank);
  const requestedMode = ranked[0]?.rule.mode ?? config.defaultMode;
  // The code transport has its own execution semantics. RP keeps the narrow
  // native capability guard until that transport has a separately proven RP gate.
  const mode = rp && ['ptc', 'both'].includes(requestedMode) ? 'discover' : requestedMode;
  return { ...route, mode, requestedMode, source: ranked.length ? 'route' : 'default',
    ...(mode !== requestedMode ? { reason: 'RP_NATIVE_CAPABILITY_BOUNDARY' } : {}) };
}

/** Settings remain native Cordis state; one frozen document owns each turn. */
export function mountFusionExecutionPolicy(ctx, { schema, sessionId, defaultMode = 'native', maxInlineBytes = 50000, currentRoute, isRp = () => false, settingsPrefix = 'fusion' } = {}) {
  if (!sessionId || typeof currentRoute !== 'function' || !toolModes.includes(defaultMode)) throw fail('INVALID_EXECUTION_POLICY_OWNER');
  const namespace = settingsPrefix + '-execution';
  const settings = ctx.settings.register(namespace, schema.object({
    defaultMode: schema.union(toolModes).default(defaultMode),
    maxInlineBytes: schema.number().default(maxInlineBytes),
    routes: schema.array(schema.object({ provider: schema.string(), model: schema.string(), mode: schema.union(toolModes) })).default([]),
  }), { applies: 'live', validate: validateExecutionPolicy });
  let frozen;
  const revision = () => ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === namespace).revision;
  const document = () => ({ revision: revision(), config: copy(settings.get()) });
  const resolve = () => ({ ...resolveExecutionPolicy((frozen ?? document()).config, currentRoute(), isRp()),
    revision: (frozen ?? document()).revision });
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return;
    if (event.type === 'turn/start') frozen = document();
    if (event.type === 'turn/end') frozen = undefined;
  });
  const service = {
    resolve,
    limits: () => ({ maxInlineBytes: (frozen ?? document()).config.maxInlineBytes }),
    status() {
      const saved = document();
      return { ...saved, effective: resolve(), runningRevision: frozen?.revision ?? null,
        pending: Boolean(frozen && frozen.revision !== saved.revision), applies: 'next-turn', availableModes: [...toolModes] };
    },
    async save(body) {
      if (!body || !Number.isInteger(body.revision)) throw fail('EXECUTION_REVISION_REQUIRED');
      let config;
      if (body.scope === 'route') {
        const route = currentRoute();
        if (!route.provider || !route.model || route.provider !== body.provider || route.model !== body.model) throw fail('PROVIDER_CHANGED');
        if (!toolModes.includes(body.mode)) throw fail('INVALID_EXECUTION_MODE');
        config = copy(settings.get());
        config.routes = config.routes.filter(rule => rule.provider !== route.provider || rule.model !== route.model);
        config.routes.push({ provider: route.provider, model: route.model, mode: body.mode });
      } else if (body.scope === 'default') {
        config = { ...copy(settings.get()), defaultMode: body.mode,
          ...(body.maxInlineBytes === undefined ? {} : { maxInlineBytes: body.maxInlineBytes }) };
      } else if (body.scope === 'replace') {
        config = copy(body.config);
      } else throw fail('INVALID_EXECUTION_SCOPE');
      validateExecutionPolicy(config);
      await ctx.settings.update(namespace, config, body.revision);
      ctx.emit('system-prompt/change');
      return service.status();
    },
  };
  ctx.provide('fusionExecutionPolicy', service);
  return service;
}
