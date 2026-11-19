/** Historical tools/agent-loop build command. */
import { buildNativeComponents } from './native-component-build.mjs';
const component = { 'dsh-tools': 'tools', 'dsh-agent-loop': 'agent-loop' }[process.argv[2]];
if (!component) throw new Error('Supported overlays: dsh-tools, dsh-agent-loop.');
await buildNativeComponents({ runtime: process.argv[3], components: [component] });
