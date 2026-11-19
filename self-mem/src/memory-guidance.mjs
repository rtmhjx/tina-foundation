const BASE_TEXT = '共同记忆可按引用检索。当前自述只是入口，各窗口共享人格归属，但本轮实际读到的内容有明确范围。依据当前任务自主读取、组织、修订或写入记忆，并保留来源、历史与不确定性。';

const RULE_TEXT = Object.freeze({
  retrieveWhenNeeded: '当回答依赖过往约定、其他窗口进展或此前决定时，先检索相关记忆。',
  verifyChanges: '遇到改口、冲突或状态变化，读取有关来源及修订，确认哪些描述仍适用于当前。',
  distinguishEvidence: '区分来源中的陈述、已核实的结论与本轮猜测；证据不足时明确指出缺口。',
  groundReusableNotes: '记录可复用经验时，尽量附上它成立的依据与适用条件。',
});

const invalid = message => Object.assign(new Error(message), { code: 'INVALID_MEMORY_GUIDANCE' });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Profile selection is explicit. No model ranking, inference, tools or I/O. */
export function normalizeMemoryGuidance(value = {}) {
  if (!isObject(value)) throw invalid('memoryGuidance must be an object');
  const mode = value.mode === undefined ? 'minimal' : value.mode;
  if (!['minimal', 'guided'].includes(mode)) throw invalid('memoryGuidance.mode must be minimal or guided');
  const overrides = value.rules === undefined ? {} : value.rules;
  if (!isObject(overrides)) throw invalid('memoryGuidance.rules must be an object');
  for (const [key, enabled] of Object.entries(overrides)) {
    if (!Object.hasOwn(RULE_TEXT, key)) throw invalid(`Unknown memory guidance rule: ${key}`);
    if (typeof enabled !== 'boolean') throw invalid(`memoryGuidance.rules.${key} must be boolean`);
  }
  return Object.freeze({
    mode,
    rules: Object.freeze(Object.fromEntries(Object.keys(RULE_TEXT).map(key => [key, overrides[key] ?? true]))),
  });
}

/** This is a value snapshot; the Persona decides when to persist it per session. */
export function buildMemoryGuidance(value) {
  const normalized = normalizeMemoryGuidance(value);
  const lines = [BASE_TEXT];
  if (normalized.mode === 'guided') {
    for (const [key, text] of Object.entries(RULE_TEXT)) {
      if (normalized.rules[key]) lines.push(text);
    }
  }
  return Object.freeze({
    version: 1,
    ...normalized,
    segment: Object.freeze({
      title: '记忆使用引导',
      text: lines.join('\n'),
      sourceKey: 'selfMem.memoryGuidance',
    }),
  });
}
