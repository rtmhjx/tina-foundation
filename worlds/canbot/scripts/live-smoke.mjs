import assert from 'node:assert/strict';
import { CANBOT_DEFAULTS } from '../src/config.mjs';
import { CanbotWorld } from '../src/world.mjs';

const cfg = {
  ...CANBOT_DEFAULTS,
  apiBaseUrl: process.env.CANBOT_SMOKE_API_URL ?? 'http://127.0.0.1:7331',
  pollIntervalMs: 60000,
};
const events = [];
const host = {
  pushEvent: async (event, options) => {
    events.push({ ...event, options });
    return { ...event, cursor: events.length };
  },
  log: { warn: (message) => process.stderr.write(`${message}\n`) },
};
const world = new CanbotWorld({ cfg, token: () => process.env.CORTICO_CANBOT_API_TOKEN ?? '' });
const call = async (name, args = {}) => {
  const result = await world.tools().find((tool) => tool.name === name).handler(args, {});
  return { failed: result.failed === true, data: JSON.parse(result.text) };
};

try {
  await world.start(host);
  const status = await call('canbot_status');
  assert.equal(status.failed, false);
  assert.equal(status.data.schemaVersion, 1);
  assert.ok(['observe_only', 'observe_and_programs'].includes(status.data.mode));
  assert.equal(status.data.capabilities.motion, false);
  assert.equal(status.data.capabilities.physicalStop, false);
  assert.notEqual(status.data.commissioning?.enabled, true);
  const observed = await call('canbot_observe', { limit: 3 });
  assert.equal(observed.failed, false);
  const actions = await call('canbot_actions');
  assert.equal(actions.failed, false);
  assert.ok(actions.data.actions.every((action) => action.enabled === false));
  // Read-only smoke must never send even a stop request: configuration may change between calls.
  const programs = status.data.capabilities.programs ? await call('canbot_programs') : null;
  if (programs) assert.equal(programs.failed, false);
  const connectionEventsBefore = events.filter((event) => event.type === 'canbot.connection').length;
  await world.poll();
  const connectionEventsAfter = events.filter((event) => event.type === 'canbot.connection').length;
  process.stdout.write(`${JSON.stringify({
    checkedAt: new Date().toISOString(),
    acceptance: 'standalone_world_to_live_api_only',
    formallyMountedInCortico: false,
    worldId: world.id,
    status: status.data,
    recentFrames: observed.data.frames,
    actions: actions.data,
    programs: programs?.data ?? null,
    stopTested: false,
    mutatingRequestsSent: 0,
    connectionEventsBefore,
    connectionEventsAfter,
    eventTypes: events.map((event) => event.type),
  }, null, 2)}\n`);
} finally {
  await world.stop();
}
