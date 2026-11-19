/** One build/install/distribution inventory; no runtime instances are created here. */
export const nativeComponents = Object.freeze({
  session: 'dsh-session',
  tools: 'dsh-tools',
  'agent-loop': 'dsh-agent-loop',
  controller: 'dsh-session-controller',
  compaction: 'dsh-compaction-basic',
  'token-meter': 'dsh-token-meter',
});

export function nativePackageName(component) {
  const stem = nativeComponents[component];
  if (!stem) throw new Error('Unknown native component: ' + component);
  return '@deepseek-ai/' + (component === 'controller' ? 'dsh-api-session-controller' : stem);
}
