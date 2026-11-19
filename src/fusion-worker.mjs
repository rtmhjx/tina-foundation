import { openFusionApp } from './fusion-app.mjs';
import { announceDataDir, startsPaused } from '../upstream/cortico/src/boot.ts';

let initialGeneration = true;

const app = await openFusionApp({
  stateDir: process.env.CORTICO_FUSION_STATE,
  dshRoot: process.env.CORTICO_FUSION_DSH_ROOT,
  port: Number(process.env.CORTICO_FUSION_PORT ?? 17889),
  contextPolicy: {
    stageBudgetTokens: Number(process.env.CORTICO_FUSION_STAGE_BUDGET_TOKENS ?? 200000),
    thresholdRatio: Number(process.env.CORTICO_FUSION_STAGE_THRESHOLD_RATIO ?? 0.85),
  },
  executionDefaults: { toolMode: 'discover', maxInlineBytes: 12000 },
  beforeStart({ bot }) {
    if (!initialGeneration) return;
    initialGeneration = false;
    if (startsPaused()) bot.core.bus.setPaused(true);
  },
  onExit({ code }) { process.exit(code); },
});

announceDataDir(app.dataDir);
console.log(JSON.stringify({ event: 'ready', origin: app.origin, stateDir: app.stateDir,
  backendPid: process.pid, sessionId: app.sessionId }));

let stopping;
function stop() {
  if (stopping) return;
  stopping = app.close().then(() => {
    if (process.connected) process.disconnect();
  }, () => {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.on('message', message => {
  if (message?.type === 'cortico:stop') stop();
});
