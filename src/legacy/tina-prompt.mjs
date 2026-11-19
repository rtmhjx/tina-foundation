const namespace = 'tina-prompt';
const definitions = [
  {
    field: 'persona', name: 'tina:persona', label: 'Tina 人设', order: 5980,
    defaultText: 'You are Tina. Converse naturally and keep role-play in the conversation.',
  },
  {
    field: 'preferences', name: 'tina:preferences', label: '表达与互动偏好', order: 5990,
    defaultText: '',
  },
];

function invalid(code) {
  return Object.assign(new Error(code), { code });
}

function validText(text) {
  return typeof text === 'string' && text.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
}

export function mountTinaPrompt(ctx, { sessionId, schema }) {
  const shape = Object.fromEntries(definitions.map(({ field, defaultText }) => [
    field, schema.string().default(defaultText),
  ]));
  const settings = ctx.settings.register(namespace, schema.object(shape), {
    validate(value) {
      if (definitions.some(({ field }) => !validText(value[field]))) throw invalid('INVALID_PROMPT_SECTION');
    },
  });
  let currentTurn;
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return;
    if (event.type === 'turn/start') currentTurn = { ...settings.get() };
    if (event.type === 'turn/end') currentTurn = undefined;
  });

  for (const { field, name, order, defaultText } of definitions) {
    const variable = 'tina_' + field;
    ctx.systemPrompt.variable(variable, ({ agent }) => (
      agent?.id === sessionId ? (currentTurn ?? settings.get())[field] : defaultText
    ));
    // The renderer does not recursively interpolate substituted text.
    ctx.systemPrompt.section({ name, order, text: '{{' + variable + '}}' });
  }

  return {
    view() {
      const configured = settings.get();
      const { revision } = ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === namespace);
      return {
        revision,
        editable: definitions.map(({ field, name, label, defaultText }) => ({
          name, label, defaultText, configured: configured[field], editable: true,
        })),
      };
    },
    async save({ name, text, revision }) {
      const definition = definitions.find(section => section.name === name);
      if (!definition || !validText(text) || !Number.isSafeInteger(revision) || revision < 0) {
        throw invalid('INVALID_PROMPT_SECTION');
      }
      try {
        await ctx.settings.update(namespace, { [definition.field]: text.replace(/\r\n?/g, '\n') }, revision);
      } catch (error) {
        if (error?.name === 'SettingsConflictError') throw invalid('PROMPT_REVISION_CONFLICT');
        throw error;
      }
    },
  };
}
