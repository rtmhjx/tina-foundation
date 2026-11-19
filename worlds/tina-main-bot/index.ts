import type { BotDefinition } from 'cortico/bot.ts';
import soulmate, { type BotConfig } from 'cortico/../bots/corti-soulmate/index.ts';
import type { CortiSoulmate } from 'cortico/../bots/corti-soulmate/persona/index.ts';
import { withLiveTinaMemory } from '/home/tina/tina-runtime/extensions/tina-memory-base/releases/0_1_7-autonomous-read-20261031A/tina-memory-base/deploy/cortico-memory-addon.mjs';

// Private host assembly only. The official Core, Worlds and native memory stay intact.
const definition: BotDefinition<BotConfig> = {
  ...soulmate,
  id: 'tina-main',
  declares: ['console', 'mobile', 'tinalink', 'websearch'],
  defaults: () => {
    const defaults = soulmate.defaults();
    return { ...defaults, displayName: 'Tina · 端侧主路', paths: { memory: 'workspace', data: 'data' },
      web: { ...defaults.web, host: '127.0.0.1', port: 7789 } };
  },
  build(loaded, worlds) {
    const original = soulmate.build(loaded, worlds);
    const parts = { ...original, async onStart(context) {
      await original.onStart?.call(original, context);
      (original.persona as CortiSoulmate).stopRhythm();
    } };
    try {
      return withLiveTinaMemory({ parts, loaded, config: { port: 8895,
        directory: loaded.rootDir + '/memory-base-owner-v1',
        ownerDeviceIds: ["bd20888e-beee-4ee9-810d-cf86b68fc8db"], modelTimeoutMs: 300000,
        initialMobileLimit: 80, initialConsoleLimit: 40, autoRollupThreshold: 12, pollMs: 5000 },
        onError: error => console.error('[tina-memory-addon]', JSON.stringify(error)) }).parts;
    } catch (error) {
      console.error('[tina-memory-addon] assembly failed; native Persona retained', String(error));
      return parts;
    }
  },
};
export default definition;
