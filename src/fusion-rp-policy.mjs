import { fusionWorldToolName } from './fusion-world.mjs';

const personaReads = new Set([
  'read_file', 'list_files', 'glob_files', 'grep_files',
  'self_memory_read', 'mem_search', 'mem_read',
].map(name => fusionWorldToolName('persona', name)));

const personaWrites = new Set([
  'write_file',
  'self_memory_patch', 'mem_note',
].map(name => fusionWorldToolName('persona', name)));

const coreFlowTools = new Set([
  'cortico_world_events',
  'cortico_world_read',
  'cortico_world_blob',
  'tina_tool_search',
  'tina_result_read',
  fusionWorldToolName('persona', 'end_turn'),
]);

const webSearchTools = new Set(['web_search', 'web_fetch']);

/**
 * Redundant DSH CLI-only or duplicate orchestration tools stripped by default in Auto/Work modes
 * (`tina_intentions` replaces `create_goal`/`get_goal`/`update_goal`, and Cortico World tools
 * replace `ask_user_question` / `present` / `exit_plan_mode`).
 */
export const REDUNDANT_CLI_TOOLS = new Set([
  'ask_user_question',
  'exit_plan_mode',
  'present',
  'ralph',
  'workflow',
  'create_goal',
  'get_goal',
  'update_goal',
  'subagent_fork',
  'send_message',
  'interrupt_agent',
  'list_agents',
]);

export const REDUNDANT_CLI_SECTIONS = new Set([
  'plan:policy',
  'tool:goal',
  'tool:workflow',
  'tool:ralph',
  'tool:subagent_fork',
]);

export const DEFAULT_PERSONA_PROFILE = Object.freeze({
  memoryRead: true,
  memoryWrite: false,
  webSearch: true,
  allowedWorlds: Object.freeze(['console', 'websearch', 'qq', 'bilibili']),
  stripCliClutter: true,
});

export function normalizePersonaProfile(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const worldsRaw = Array.isArray(src.allowedWorlds)
    ? src.allowedWorlds
    : DEFAULT_PERSONA_PROFILE.allowedWorlds;
  const allowedWorlds = [...new Set(
    worldsRaw
      .filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(id) && id !== 'persona' && id !== 'native-engine')
  )];
  return {
    memoryRead: src.memoryRead !== undefined ? Boolean(src.memoryRead) : DEFAULT_PERSONA_PROFILE.memoryRead,
    memoryWrite: src.memoryWrite !== undefined ? Boolean(src.memoryWrite) : DEFAULT_PERSONA_PROFILE.memoryWrite,
    webSearch: src.webSearch !== undefined ? Boolean(src.webSearch) : DEFAULT_PERSONA_PROFILE.webSearch,
    allowedWorlds,
    stripCliClutter: src.stripCliClutter !== undefined ? Boolean(src.stripCliClutter) : DEFAULT_PERSONA_PROFILE.stripCliClutter,
  };
}

export function worldToolPrefix(worldId) {
  return 'cortico_' + String(worldId).replace(/[^a-z\d_]/gi, '_').slice(0, 16) + '_';
}

/** Persona reads stay inside its Memory workspace; native machine tools stay gated in strict RP. */
export function isFusionRpToolAllowed(name) {
  return ['cortico_world_events', 'cortico_world_read', 'tina_tool_search', 'tina_result_read'].includes(name)
    || name.startsWith('cortico_console_console_send_')
    || name === fusionWorldToolName('persona', 'end_turn')
    || personaReads.has(name);
}

/** Companion mode unloads complex engineering tools, keeping only whitelisted capabilities. */
export function isCompanionToolAllowed(name, rawProfile = DEFAULT_PERSONA_PROFILE) {
  const profile = normalizePersonaProfile(rawProfile);
  if (coreFlowTools.has(name)) return true;
  if (profile.memoryRead && personaReads.has(name)) return true;
  if (profile.memoryWrite && personaWrites.has(name)) return true;
  if (profile.webSearch && (webSearchTools.has(name) || name.startsWith('cortico_websearch_'))) return true;
  for (const worldId of profile.allowedWorlds) {
    if (worldId === 'websearch' && !profile.webSearch) continue;
    if (name.startsWith(worldToolPrefix(worldId))) return true;
  }
  return false;
}

export function isModeToolAllowed(mode, name, rawProfile = DEFAULT_PERSONA_PROFILE) {
  if (mode === 'rp') return isFusionRpToolAllowed(name);
  if (mode === 'companion') return isCompanionToolAllowed(name, rawProfile);
  const profile = normalizePersonaProfile(rawProfile);
  if (profile.stripCliClutter && REDUNDANT_CLI_TOOLS.has(name)) return false;
  return true;
}

/** Filters DSH/Fusion `system` sections according to active Persona tier & whitelist. */
export function isModeSectionAllowed(mode, sectionName, rawProfile = DEFAULT_PERSONA_PROFILE) {
  const profile = normalizePersonaProfile(rawProfile);
  if (mode === 'companion') {
    if (sectionName === 'context:file-reference'
      || sectionName === 'deployment:persona-suffix'
      || sectionName === 'tina.continuation'
      || sectionName === 'plan:policy') {
      return false;
    }
    if (sectionName.startsWith('tool:')) {
      if (sectionName === 'tool:web_search' || sectionName === 'tool:web_fetch') {
        return profile.webSearch;
      }
      return false;
    }
    return true;
  }
  if ((mode === 'auto' || mode === 'work') && profile.stripCliClutter) {
    if (REDUNDANT_CLI_SECTIONS.has(sectionName)) return false;
  }
  return true;
}
