const officialProvider = 'deepseek-official';
const credentialRef = 'DEEPSEEK_API_KEY';
const failure = code => Object.assign(new Error(code), { code });

/** The active Cortico endpoint owns model configuration; native sessions consume its route. */
export function createFusionModelControls({ ctx, config, getBot, sessionId, routeFor = name => 'cortico:' + name, customProvider, onChanged }) {
  let officialCredentialConfigured;
  function current() {
    const name = config.activeProvider;
    const entry = config.providers[name];
    const custom = customProvider?.();
    const provider = custom ?? (entry ? name === 'native' ? entry.options?.nativeProvider ?? officialProvider : routeFor(name) : '');
    const model = typeof entry?.spec?.model === 'string' ? entry.spec.model : '';
    const credentialMode = !custom && name === 'native' && provider === officialProvider ? 'official' : 'provider';
    return {
      provider, model, providerName: name, providerKind: entry?.kind ?? '',
      thinking: entry?.spec?.thinking === true,
      reasoningEffort: entry?.spec?.thinking ? entry.spec.reasoningEffort ?? 'default'
        : entry?.spec?.reasoningEffort === 'none' ? 'none' : 'off',
      credentialMode,
      ...(credentialMode === 'official' && officialCredentialConfigured !== undefined ? { credentialConfigured: officialCredentialConfigured } : {}),
      ...(!provider ? { modelListError: 'PROVIDER_UNCONFIGURED' } : !model ? { modelListError: 'MODEL_UNCONFIGURED' } : {}),
    };
  }
  const sameRoute = before => {
    const after = current();
    return before.providerName === after.providerName && before.provider === after.provider && before.providerKind === after.providerKind;
  };
  const sameConfiguration = before => sameRoute(before) && current().model === before.model
    && current().reasoningEffort === before.reasoningEffort && current().thinking === before.thinking;
  const selectedFields = value => value ? { provider: value.provider, model: value.model,
    reasoningEffort: value.reasoningEffort ?? null } : null;
  function nativeStatus() {
    const session = sessionId && ctx.sessions?.get(sessionId);
    const state = session && ctx.sessionProjections.stateOf(session, 'modelSelection');
    const native = state?.pending ?? state?.lastUsed ?? ctx.agentDefaultModel?.currentSelection();
    const header = session?.snapshotEvents().findLast(event => event.type === 'request/header');
    const config = header?.data.header?.config;
    const latest = config ? { ...selectedFields(config), nativeSeq: header.seq, basis: 'native-request-header' } : null;
    const desired = current();
    return { nativeSelection: native ? { ...selectedFields(native), source: state?.pending ? 'pending' : state?.lastUsed ? 'last-used' : 'default' } : null,
      lastRequestSelection: latest, reasoningEffortPending: !latest || latest.provider !== desired.provider
        || latest.model !== desired.model || latest.reasoningEffort !== desired.reasoningEffort };
  }
  async function declaredEfforts(selected) {
    if (!selected.provider || !selected.model) return [];
    const info = await ctx.llm.resolveModelInfo(selected.provider, selected.model);
    return (info.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, label: effort.name ?? effort.id }));
  }
  return {
    current,
    /** Provider settings are a complete selection, including effort-only edits. */
    async syncNativeSelection({ sessionId: target = sessionId } = {}) {
      const selected = current();
      if (!selected.provider || !selected.model) throw failure('MODEL_UNAVAILABLE');
      const session = ctx.sessions.get(target);
      const state = session && ctx.sessionProjections.stateOf(session, 'modelSelection');
      const native = state?.pending ?? state?.lastUsed ?? ctx.agentDefaultModel.currentSelection();
      if (native?.provider === selected.provider && native?.model === selected.model
        && native.reasoningEffort === selected.reasoningEffort) return;
      await ctx.sessionController.selectModel({ sessionId: target, provider: selected.provider,
        model: selected.model, reasoningEffort: selected.reasoningEffort });
      if (!sameConfiguration(selected)) throw failure('PROVIDER_CHANGED');
    },
    credentialAllowed: () => current().credentialMode === 'official',
    async status({ includeModels = true } = {}) {
      const selected = current();
      const credential = selected.credentialMode === 'official' ? {
        credentialConfigured: (await ctx.credentialsController.describe([credentialRef]))[credentialRef]?.configured === true,
      } : {};
      if (selected.credentialMode === 'official') officialCredentialConfigured = credential.credentialConfigured;
      if (!includeModels) return { ...selected, ...credential, ...nativeStatus() };
      let available;
      let modelListError = selected.modelListError;
      try { available = selected.provider ? await ctx.llm.listModels(selected.provider) : []; }
      catch { available = []; modelListError = 'MODEL_LIST_UNAVAILABLE'; }
      let reasoningEfforts = [], reasoningEffortError;
      try { reasoningEfforts = await declaredEfforts(selected); }
      catch { reasoningEffortError = 'REASONING_CAPABILITY_UNAVAILABLE'; }
      if (!sameConfiguration(selected)) throw failure('PROVIDER_CHANGED');
      const models = available.map(({ id, name }) => ({ id, label: name ?? id }));
      if (selected.model && !models.some(model => model.id === selected.model)) models.unshift({ id: selected.model, label: selected.model });
      return {
        ...selected, models, reasoningEfforts, ...nativeStatus(), ...(reasoningEffortError ? { reasoningEffortError } : {}),
        ...(modelListError ? { modelListError } : {}),
        ...credential,
      };
    },
    async select(body) {
      const selected = current();
      if (!selected.provider) throw failure('PROVIDER_UNAVAILABLE');
      if (body.provider !== undefined && body.provider !== selected.provider) throw failure('PROVIDER_CHANGED');
      const available = await ctx.llm.listModels(selected.provider);
      if (!available.some(model => model.id === body.model)) throw failure('MODEL_UNAVAILABLE');
      if (body.reasoningEffort !== undefined) {
        const efforts = await declaredEfforts({ ...selected, model: body.model });
        if (typeof body.reasoningEffort !== 'string' || !efforts.some(effort => effort.id === body.reasoningEffort))
          throw failure('REASONING_EFFORT_UNAVAILABLE');
      }
      if (!sameConfiguration(selected)) throw failure('PROVIDER_CHANGED');
      const hub = getBot().providerHub;
      if (!hub) throw failure('PROVIDER_CONTROLS_UNAVAILABLE');
      const detail = hub.detail(selected.providerName, 'zh');
      if (!sameRoute(selected)) throw failure('PROVIDER_CHANGED');
      hub.save(selected.providerName, {
        name: selected.providerName, expectedRevision: detail.revision,
        entry: { ...detail.entry, spec: { ...detail.entry.spec, model: body.model,
          ...(body.reasoningEffort === undefined ? {} : {
            thinking: body.reasoningEffort !== 'off' && body.reasoningEffort !== 'none',
            reasoningEffort: ['off', 'default'].includes(body.reasoningEffort) ? undefined : body.reasoningEffort,
          }) } },
      }, 'zh');
      await onChanged();
    },
  };
}
