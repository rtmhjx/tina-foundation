/** Model-facing projection over the original native registry. This service owns
 * no execution registry and grants no permission or substitute tool executor. */
export const name = 'tina-fusion-tool-presentation';
export const inject = ['agents', 'tools', 'systemPrompt'];
export const SEARCH_TOOL = 'tina_tool_search';
const modes = new Set(['native', 'discover', 'ptc', 'both']);
const defaultBootstrap = [SEARCH_TOOL, 'cortico_world_events', 'tina_intentions'];
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const text = value => [{ type: 'text', text: JSON.stringify(value) }];

/** resolvePolicy is synchronous and may read the host's current model settings.
 * Native agent/request runs after prompt assembly, so a host that changes the
 * route there must resolve from its current settings, not a stale header alone.
 * isToolAllowed is an additional presentation filter; original native guards
 * and approvals continue to own all execution, including direct guessed calls.
 */
export function mountFusionToolPresentation(ctx, options = {}) {
  if (typeof options.sessionId !== 'string' || !options.sessionId) throw new TypeError('Tool presentation requires an explicit sessionId.');
  if (!modes.has(options.defaultMode ?? 'native')) throw new TypeError('Invalid default tool presentation mode.');
  const sessionId = options.sessionId;
  const states = new Map();
  const maxDiscovered = options.maxDiscovered ?? 48;
  if (!Number.isSafeInteger(maxDiscovered) || maxDiscovered < 1 || maxDiscovered > 512) throw new TypeError('Invalid discovered tool limit.');
  let closed = false;
  const inputFor = agent => {
    const selected = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection');
    const config = selected?.pending ?? agent.session.requestHeader()?.config ?? agent.options ?? {};
    return { agent, sessionId: agent.id, provider: config.provider, model: config.model };
  };
  function policyFor(agent) {
    const input = inputFor(agent);
    const selected = options.resolvePolicy?.(input) ?? {};
    if (!selected || typeof selected !== 'object' || typeof selected.then === 'function') throw new TypeError('Tool presentation policy must return a synchronous object.');
    const mode = selected.mode ?? options.defaultMode ?? 'native';
    if (!modes.has(mode)) throw new TypeError('Invalid tool presentation policy mode.');
    const bootstrapNames = selected.bootstrapNames ?? options.bootstrapNames ?? defaultBootstrap;
    if (!Array.isArray(bootstrapNames) || bootstrapNames.some(item => typeof item !== 'string')) throw new TypeError('bootstrapNames must be an array of native tool names.');
    return { ...input, mode, bootstrapNames: new Set([SEARCH_TOOL, ...bootstrapNames]) };
  }
  const allowed = (policy, toolName) => options.isToolAllowed?.({ ...policy, name: toolName,
    definition: ctx.tools.get(toolName, policy.agent) }) !== false;
  function prune(state) {
    for (const [toolName, definition] of state.discovered) {
      if (ctx.tools.get(toolName, state.agent) !== definition || !allowed(state.policy, toolName)) state.discovered.delete(toolName);
    }
  }
  function searchDefinition(state) {
    return {
      name: SEARCH_TOOL,
      description: 'Find currently available native tools by capability or exact name. Search before using a tool absent from the current schema list. Matching tools become available with their complete schemas on the next request. Discovery grants no permissions; original tool policy still applies.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { matches: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'], additionalProperties: false } },
        discovered: { type: 'array', items: { type: 'string' } }, more: { type: 'boolean' } }, required: ['matches', 'discovered', 'more'], additionalProperties: false },
      render: (_args, value) => text(value) },
      isConcurrencySafe: () => false,
      async execute({ query, limit = 8 }, exec) {
        if (exec.agent !== state.agent || state.agent.id !== sessionId || closed) throw new Error('Tool discovery belongs to a different or closed session.');
        refresh(state.agent);
        if (state.policy.mode !== 'discover') throw new Error('Native tool discovery is not active for this model.');
        if (typeof query !== 'string' || query.length > 2048 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Use query text up to 2048 characters and a positive integer limit.');
        limit = Math.min(limit, 24);
        const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
        const candidates = catalog(state).filter(schema => schema.name !== SEARCH_TOOL).map(schema => {
          const toolName = schema.name.toLocaleLowerCase();
          const description = schema.description.toLocaleLowerCase();
          const score = terms.reduce((sum, term) => sum + (toolName === term ? 100 : toolName.includes(term) ? 10 : description.includes(term) ? 1 : 0), 0);
          return { schema, score };
        }).filter(item => !terms.length || item.score > 0)
          .sort((a, b) => b.score - a.score || a.schema.name.localeCompare(b.schema.name));
        const matches = candidates.slice(0, limit).map(({ schema }) => {
          state.discovered.delete(schema.name);
          state.discovered.set(schema.name, ctx.tools.get(schema.name, state.agent));
          return { name: schema.name, description: schema.description.slice(0, 800) };
        });
        while (state.discovered.size > maxDiscovered) state.discovered.delete(state.discovered.keys().next().value);
        return { matches, discovered: [...state.discovered.keys()], more: candidates.length > limit };
      },
    };
  }
  function refresh(agent) {
    if (closed || !agent || agent.id !== sessionId) return null;
    const policy = policyFor(agent);
    let state = states.get(agent);
    if (!state) {
      state = { agent, policy, discovered: new Map(), modeDisposer: null, searchDisposer: null,
        nativeMode: null, routeKey: null, last: null, sectionDisposer: null };
      states.set(agent, state);
      state.sectionDisposer = agent.ctx.systemPrompt.section({ name: 'fusion:tool-discovery', order: 4900,
        text: () => state.policy.mode === 'discover'
          ? 'The tool list is loaded on demand. Use tina_tool_search with a capability or exact native tool name; matching schemas appear on the next request. Discovery does not grant permission. Never invent an executor or bypass tool policy.' : '' });
    }
    const routeKey = JSON.stringify([policy.provider ?? null, policy.model ?? null, policy.mode]);
    if (routeKey !== state.routeKey) { state.discovered.clear(); state.routeKey = routeKey; }
    state.policy = policy;
    const nativeMode = policy.mode === 'discover' ? 'native' : policy.mode;
    let changed = state.nativeMode !== nativeMode;
    if (changed) {
      state.modeDisposer?.();
      state.modeDisposer = null;
      state.modeDisposer = agent.ctx.tools.presentAs(nativeMode);
      state.nativeMode = nativeMode;
    }
    if (policy.mode === 'discover' && !state.searchDisposer) {
      state.searchDisposer = agent.ctx.tools.register(searchDefinition(state)); changed = true;
    }
    if (policy.mode !== 'discover' && state.searchDisposer) { state.searchDisposer(); state.searchDisposer = null; changed = true; }
    prune(state);
    return { state, changed };
  }
  function catalog(state) {
    // Public schemas() and get() apply native scope inheritance/restrictions.
    // discover uses native presentation; PTC's SDK/transport remain upstream.
    prune(state);
    return ctx.tools.schemas(state.agent).filter(schema => allowed(state.policy, schema.name));
  }
  function snapshot(state, wire, assembly) {
    const available = state.policy.mode === 'ptc' ? null : catalog(state);
    return { sessionId, provider: state.policy.provider ?? null, model: state.policy.model ?? null,
      mode: state.policy.mode, nativeMode: state.nativeMode, bootstrapNames: [...state.policy.bootstrapNames],
      discoveredNames: [...state.discovered.keys()], wireSchemaCount: wire.length, wireSchemaBytes: bytes(wire),
      wireToolNames: wire.map(schema => schema.name), availableSchemaCount: available?.length ?? null,
      availableSchemaBytes: available ? bytes(available) : null,
      availableMeasurement: available ? 'current-public-native-registry' : 'PTC public schemas exposes only run_code; full SDK capability size is measured separately',
      sdkPromptBytes: assembly?.sections.filter(section => /tools.*sdk/i.test(section.name)).reduce((sum, section) => sum + Buffer.byteLength(section.text, 'utf8'), 0) ?? null,
      measurement: 'UTF-8 bytes of JSON schemas, not token estimates' };
  }
  const project = (state, schemas) => schemas.filter(schema => allowed(state.policy, schema.name)
    && (state.policy.mode !== 'discover' || state.policy.bootstrapNames.has(schema.name)
      || state.discovered.has(schema.name) && state.discovered.get(schema.name) === ctx.tools.get(schema.name, state.agent)));
  function drop(agent) {
    const state = states.get(agent);
    if (!state) return;
    states.delete(agent);
    state.searchDisposer?.(); state.modeDisposer?.(); state.sectionDisposer?.();
    state.discovered.clear();
  }
  ctx.on('agent/created', ({ agent }) => { refresh(agent); });
  ctx.on('agent/disposed', ({ agent }) => { drop(agent); });
  ctx.on('tools/change', () => { for (const state of states.values()) prune(state); });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent;
    if (!agent || agent.id !== sessionId || closed) return next();
    const { state, changed } = refresh(agent);
    // Providers ran before this waterfall. Changing native presentation changes
    // the upstream SDK sections and transport too; regenerate exactly once.
    if (changed) return ctx.systemPrompt.assemble(context);
    const current = await next();
    prune(state);
    const tools = project(state, current.tools);
    state.last = snapshot(state, tools, current);
    return { ...current, tools };
  });
  ctx.effect(() => () => { closed = true; for (const agent of [...states.keys()]) drop(agent); });
  const service = Object.freeze({
    refresh() { const agent = ctx.agents.get(sessionId); return agent ? refresh(agent)?.state.policy.mode : null; },
    status() {
      const agent = ctx.agents.get(sessionId);
      if (!agent) return { sessionId, mode: options.defaultMode ?? 'native', pending: true };
      const { state } = refresh(agent);
      return { ...snapshot(state, project(state, ctx.tools.schemas(agent))),
        measurementScope: 'current-native-registry-and-policy; inspect includes other prompt waterfalls' };
    },
    async inspect() {
      const agent = ctx.agents.get(sessionId);
      if (!agent) return { sessionId, pending: true };
      refresh(agent);
      const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent });
      const state = states.get(agent);
      state.last = snapshot(state, assembly.tools, assembly);
      return { ...state.last, measurementScope: 'final-system-prompt-assembly' };
    },
  });
  ctx.provide('fusionToolPresentation', service);
  for (const agent of ctx.agents.list()) refresh(agent);
  return service;
}

export function apply(ctx, options) { mountFusionToolPresentation(ctx, options); }
