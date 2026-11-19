/** Compatibility command, using the shared native compiler and transactional installer. */
import { buildNativeComponents } from './native-component-build.mjs';
await buildNativeComponents({ runtime: process.argv[2], components: ['tools'] });
