import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');
const NATIVE_PREFIX = 'native:';

/**
 * Editable documents + Native DSH section overrides + Persona live documents (`selfMem.canvas`, `selfMem.seed`)
 * unified on one `system` prompt registry so 100% of `system` is visible, editable, and resettable.
 */
export function mountFusionPrompts(ctx, {
  sessionId,
  workspaceDir,
  schema,
  assembleContextFor,
  renderPrompt,
  conflict = Error,
  personaSegments = async () => [],
  personaDocs = async () => [],
  personaWrite = async () => null,
  defaultSectionOverrides = {},
  shouldIncludeSection = () => true,
  settingsPrefix = 'fusion',
  existingSession = false,
}) {
  const documents = new Map();
  let frozen;
  let frozenOverrides;
  let frozenPersona;
  let personaSources = new Map();
  let nativeDefaults = new Map(); // sectionName -> un-overridden native text from last inspect/assemble
  let changed = 0;

  const overridesNs = settingsPrefix + '-section-overrides';
  const overrideSettings = ctx.settings.register(
    overridesNs,
    schema.object({ json: schema.string().default('{}') }),
    {
      validate(value) {
        if (!value || typeof value.json !== 'string') throw new Error('Invalid section overrides.');
        let parsed;
        try { parsed = JSON.parse(value.json); } catch { throw new Error('Invalid section overrides JSON.'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid section overrides.');
        for (const [k, v] of Object.entries(parsed)) {
          if (!k || typeof v !== 'string' || v.length > 131072 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) {
            throw new Error('Invalid section override text.');
          }
        }
      },
    }
  );
  const readOverrides = () => {
    try { return JSON.parse(overrideSettings.get()?.json ?? '{}'); } catch { return {}; }
  };
  const overridesRevision = () => ctx.settings.describe({ redactSecrets: true }).find((r) => r.ns === overridesNs).revision;
  const saveOverrides = async (nextItems) => {
    await ctx.settings.update(overridesNs, { json: JSON.stringify(nextItems) }, overridesRevision());
    ctx.emit('system-prompt/change');
  };

  const own = (context) => context.agent?.id === sessionId;
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return;
    if (event.type === 'turn/start') {
      frozen = new Map([...documents].map(([key, doc]) => [key, doc.read()]));
      frozenOverrides = readOverrides();
      frozenPersona = undefined;
    }
    if (event.type === 'turn/end') {
      frozen = undefined;
      frozenOverrides = undefined;
      frozenPersona = undefined;
    }
  });
  ctx.on('system-prompt/change', () => { changed++; });

  const isExplicitlyReadOnly = (sectionName) => {
    for (const doc of documents.values()) {
      if (doc.name === sectionName && doc.editable === false) return true;
    }
    return false;
  };

  const findEditableDocBySection = (sectionName) => {
    for (const doc of documents.values()) {
      if (doc.name === sectionName && doc.editable) return doc;
    }
    return undefined;
  };

  const api = {
    /** A committed context handoff starts a new prefix even inside the same turn. */
    invalidatePersona() { frozenPersona = undefined; ctx.emit('system-prompt/change'); },
    register(owner, options) {
      const {
        key, name = key, title = key, description = '', scope = 'persona', order = 5980,
        defaultText = '', editable = true, maxLength = 65536,
      } = options;
      if (!/^[a-zA-Z0-9:_.-]+$/.test(key) || documents.has(key)) throw new Error('Prompt document key conflict.');
      const namespace = settingsPrefix + '-prompt-' + digest(key).slice(0, 16);
      const settings = owner.settings.register(namespace, schema.object({ text: schema.string().default(defaultText) }), {
        validate(value) {
          if (typeof value.text !== 'string' || value.text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.text)) {
            throw new Error('Invalid prompt document.');
          }
        },
      });
      const variable = 'fusion_doc_' + digest(key).slice(0, 20);
      const removeVariable = owner.systemPrompt.variable(variable, (context) => (own(context)
        ? (frozen?.get(key) ?? settings.get().text)
        : undefined));
      const removeSection = owner.systemPrompt.section({ name, order, text: (context) => (own(context) ? '{{' + variable + '}}' : '') });
      const doc = {
        key,
        name,
        title,
        description,
        scope,
        editable,
        defaultText,
        namespace,
        read: () => settings.get().text,
        revision: () => owner.settings.describe({ redactSecrets: true }).find((row) => row.ns === namespace).revision,
        update: (text, revision) => owner.settings.update(namespace, { text }, revision),
      };
      documents.set(key, doc);
      const dispose = () => { documents.delete(key); removeVariable(); removeSection(); };
      owner.effect(() => dispose);
      return dispose;
    },

    async inspect() {
      if (!existingSession) await ctx.sessionController.create({ sessionId, cwd: workspaceDir });
      const agent = ctx.agents.get(sessionId);
      if (!agent) throw Object.assign(new Error('The selected host session is no longer loaded.'), { code: 'HOST_SESSION_NOT_LOADED' });
      const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent));
      const sections = assembly.sections.map((section) => {
        const regDoc = findEditableDocBySection(section.name);
        const pKey = personaSources.get(section.name);
        const sourceKey = regDoc?.key
          ?? pKey
          ?? (!section.name.startsWith('cortico:') && !isExplicitlyReadOnly(section.name) ? NATIVE_PREFIX + section.name : undefined);
        return {
          name: section.name,
          text: renderPrompt({ ...assembly, sections: [section] }),
          ...(sourceKey ? { sourceKey } : {}),
        };
      });
      const overrides = readOverrides();
      return {
        revision: changed,
        frozen: frozen !== undefined,
        overriddenCount: Object.keys(overrides).length,
        sections,
        text: renderPrompt(assembly),
        documents: [...documents.values()].map((doc) => ({
          key: doc.key,
          name: doc.name,
          editable: doc.editable,
          included: sections.some((section) => section.name === doc.name),
        })),
      };
    },

    web: {
      application: 'next-turn',

      async list() {
        const inspected = await api.inspect();
        const overrides = readOverrides();

        const registeredList = [...documents.values()].filter((doc) => doc.editable).map((doc) => {
          const content = doc.read();
          return {
            key: doc.key,
            title: doc.title,
            description: doc.description || 'Tina 可编辑常驻 System 段落（保存后下一轮生效）。',
            scope: doc.scope,
            origin: content !== doc.defaultText ? 'deployment' : 'module',
            content,
            revision: digest(content),
            role: 'envPrompt',
          };
        });

        const nativeList = [];
        const seenNative = new Set();
        for (const sec of inspected.sections) {
          if (!sec.sourceKey?.startsWith(NATIVE_PREFIX)) continue;
          const secName = sec.sourceKey.slice(NATIVE_PREFIX.length);
          if (seenNative.has(secName)) continue;
          seenNative.add(secName);
          const hasOverride = Object.prototype.hasOwnProperty.call(overrides, secName);
          const content = hasOverride ? overrides[secName] : sec.text;
          nativeList.push({
            key: sec.sourceKey,
            title: `内核段 · ${secName}`,
            description: hasOverride
              ? 'DSH 内核段（当前使用自定义覆盖文本；点击重置可恢复内核默认生成内容）。'
              : 'DSH 内核默认生成段（可直接修改或清空覆盖，保存后下一轮生效）。',
            scope: 'core',
            origin: hasOverride ? 'deployment' : 'module',
            content,
            revision: digest(content),
            role: 'prefix',
          });
        }
        // Also surface any overridden native section whose text was set to "" (so user can still edit/reset it!)
        for (const [secName, ovText] of Object.entries(overrides)) {
          if (seenNative.has(secName)) continue;
          nativeList.push({
            key: NATIVE_PREFIX + secName,
            title: `内核段 · ${secName}（已静默/覆盖）`,
            description: 'DSH 内核段（当前已被覆盖为空或自定义内容；点击重置可恢复默认）。',
            scope: 'core',
            origin: 'deployment',
            content: ovText,
            revision: digest(ovText),
            role: 'prefix',
          });
        }

        const pDocs = await Promise.resolve(personaDocs()).catch(() => []);
        return [...nativeList, ...registeredList, ...(Array.isArray(pDocs) ? pDocs : [])];
      },

      async write(key, content, baseRevision) {
        const normalized = String(content ?? '').replace(/\r\n?/g, '\n');

        // 1. Persona-owned live docs (e.g. `selfMem.canvas` / `TINA_SELF.md`, `selfMem.seed`)
        if (key.startsWith('selfMem.')) {
          try {
            const res = await personaWrite(key, normalized, baseRevision);
            if (res !== null && res !== undefined) {
              ctx.emit('system-prompt/change');
              return res;
            }
          } catch (err) {
            if (err?.code === 'PROMPT_CONFLICT' || err?.code === 'SELF_CANVAS_CONFLICT') {
              throw new conflict(err.message || 'Prompt document changed.');
            }
            throw err;
          }
        }

        // 2. Native DSH section overrides (`native:<sectionName>`)
        if (key.startsWith(NATIVE_PREFIX)) {
          const secName = key.slice(NATIVE_PREFIX.length);
          if (!secName || isExplicitlyReadOnly(secName)) {
            throw new Error('Prompt document is read-only or unavailable.');
          }
          const overrides = readOverrides();
          const currentText = Object.prototype.hasOwnProperty.call(overrides, secName)
            ? overrides[secName]
            : Object.prototype.hasOwnProperty.call(defaultSectionOverrides, secName)
              ? defaultSectionOverrides[secName]
              : (nativeDefaults.get(secName) ?? '');
          if (baseRevision !== undefined && baseRevision !== digest(currentText)) {
            throw new conflict('Prompt document changed.');
          }
          overrides[secName] = normalized;
          await saveOverrides(overrides);
          return '内核段覆盖已保存，下一轮生效。';
        }

        // 3. Registered `fusionPrompts` documents
        const doc = documents.get(key);
        if (!doc?.editable) throw new Error('Prompt document is read-only or unavailable.');
        const currentText = doc.read();
        const currentRevNum = doc.revision();
        if (baseRevision !== undefined && baseRevision !== digest(currentText) && baseRevision !== String(currentRevNum)) {
          throw new conflict('Prompt document changed.');
        }
        try {
          await doc.update(normalized, Number(currentRevNum));
        } catch (error) {
          if (error.name === 'SettingsConflictError') throw new conflict('Prompt document changed.');
          throw error;
        }
        ctx.emit('system-prompt/change');
        return '已保存，下一轮生效。';
      },

      async reset(key) {
        if (key.startsWith(NATIVE_PREFIX)) {
          const secName = key.slice(NATIVE_PREFIX.length);
          const overrides = readOverrides();
          delete overrides[secName];
          await saveOverrides(overrides);
          return '已恢复内核默认段内容。';
        }
        const doc = documents.get(key);
        if (doc?.editable) {
          await doc.update(doc.defaultText ?? '', Number(doc.revision()));
          ctx.emit('system-prompt/change');
          return '已恢复默认提示词。';
        }
        return null;
      },

      async prefix() {
        const { sections } = await api.inspect();
        return sections.filter((section) => section.text).map((section, index) => ({
          title: section.name,
          text: (index ? '\n\n' : '') + section.text,
          ...(section.sourceKey ? { sourceKey: section.sourceKey } : {}),
        }));
      },
    },
  };

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (!own(context)) return assembly;

    const activeOverrides = frozen ? (frozenOverrides ?? {}) : readOverrides();
    const variables = { ...assembly.variables };

    // Record un-overridden native defaults, apply operator overrides, and unload filtered sections cleanly
    const adjustedNativeSections = [];
    for (let idx = 0; idx < assembly.sections.length; idx++) {
      const sec = assembly.sections[idx];
      const regDoc = findEditableDocBySection(sec.name);
      if (!regDoc && !isExplicitlyReadOnly(sec.name)) {
        const rawRendered = renderPrompt({ ...assembly, sections: [sec] });
        nativeDefaults.set(sec.name, rawRendered);
        if (Object.prototype.hasOwnProperty.call(activeOverrides, sec.name)) {
          const ovText = activeOverrides[sec.name];
          if (!ovText) continue;
          const ovVar = `fusion_native_ov_${idx}_${digest(sec.name).slice(0, 10)}`;
          variables[ovVar] = ovText;
          adjustedNativeSections.push({ ...sec, text: '{{' + ovVar + '}}' });
          continue;
        }
        if (shouldIncludeSection(sec.name) === false) continue;
        if (Object.prototype.hasOwnProperty.call(defaultSectionOverrides, sec.name)) {
          const defText = defaultSectionOverrides[sec.name];
          if (!defText) continue;
          const defVar = `fusion_native_def_${idx}_${digest(sec.name).slice(0, 10)}`;
          variables[defVar] = defText;
          adjustedNativeSections.push({ ...sec, text: '{{' + defVar + '}}' });
          continue;
        }
      } else if (regDoc && shouldIncludeSection(sec.name) === false) {
        continue;
      }
      adjustedNativeSections.push(sec);
    }

    const segments = await (frozen ? (frozenPersona ??= Promise.resolve().then(personaSegments)) : personaSegments());
    personaSources = new Map();
    const extra = segments.filter((segment) => segment.text).map((segment, index) => {
      const variable = 'fusion_persona_' + index;
      variables[variable] = segment.text;
      const name = 'cortico:' + index + ':' + (segment.title ?? segment.name ?? index);
      if (segment.sourceKey) personaSources.set(name, segment.sourceKey);
      return { name, text: '{{' + variable + '}}' };
    });

    return { ...assembly, variables, sections: [...adjustedNativeSections, ...extra] };
  });

  ctx.provide('fusionPrompts', api);
  return api;
}
