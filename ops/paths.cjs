'use strict';
const path = require('node:path');

/** Explicit target state; shared observer/storage remain independently configurable. */
function resolveOpsPaths({ env = process.env, stateDir = env.CORTICO_FUSION_STATE } = {}) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new Error('CORTICO_FUSION_STATE is required');
  const state = path.resolve(stateDir);
  const runtimeRoot = path.resolve(env.CORTICO_TINA_RUNTIME || path.join(state, '..', '..'));
  return Object.freeze({ state, runtimeRoot,
    intakeConfig: path.resolve(env.CORTICO_INTAKE_CONFIG || path.join(state, 'intake', 'collector.json')),
    intakeModule: path.resolve(env.CORTICO_AGENT_INTAKE_MODULE || path.join(runtimeRoot, 'agent-intake', 'tina-memory-base', 'src', 'agent-intake.mjs')),
    foundationModule: path.join(state, 'extensions', 'node_modules', '@tina', 'self-mem', 'src', 'memorybase-compat.mjs'),
    memoryCompatOrigin: env.CORTICO_MEMORY_COMPAT_ORIGIN || 'http://127.0.0.1:8895',
    nativeRoot: path.join(state, 'native', 'dsh-embedded', 'home', 'sessions'),
    nativeArchive: path.resolve(env.CORTICO_NATIVE_ARCHIVE || path.join(runtimeRoot, 'cortico-self', 'tina-main-native')),
    legacyObserver: path.resolve(env.CORTICO_LEGACY_ARCHIVE_MODULE || path.join(runtimeRoot, 'assembly', 'session-archive', 'tina-session-archive.js')),
  });
}
module.exports = { resolveOpsPaths };
