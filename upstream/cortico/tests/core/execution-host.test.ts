import { afterEach, expect, it, vi } from 'vitest';
import { Core } from './fixture-core.ts';
import { MainLoop } from '../../src/core/loop.ts';
import { SessionLog } from '../../src/core/session.ts';
import { FakeLLM, makeCfg, makeFakeIO, makeFakePersona, makeLoaded, makeTmpDir } from './helpers.ts';

let temporary: ReturnType<typeof makeTmpDir> | undefined;
afterEach(() => { temporary?.cleanup(); temporary = undefined; });

it('uses an injected execution loop and session while preserving live World visibility', async () => {
  temporary = makeTmpDir();
  const loaded = makeLoaded({
    config: makeCfg(), rootDir: temporary.dir, memoryDir: temporary.dir + '/memory',
    dataDir: temporary.dir + '/data',
  });
  const session = new SessionLog(loaded.dataDir, 'host-projection.jsonl');
  const worldsChanged = vi.fn();
  let nativeLoop: MainLoop | undefined;
  let visible: (() => string[]) | undefined;
  const core = new Core(loaded, {
    persona: makeFakePersona([], { cfg: loaded.config }),
    worlds: [makeFakeIO('web')],
    llm: new FakeLLM(),
    session,
    createLoop(deps) {
      expect(deps.session).toBe(session);
      visible = () => deps.worlds.visible().map(world => world.id);
      nativeLoop = new MainLoop(deps);
      return Object.assign(nativeLoop, { worldsChanged });
    },
  });
  try {
    expect(core.loop).toBe(nativeLoop);
    expect(core.session).toBe(session);
    expect(visible?.()).toEqual(['web']);
    core.setWorldVisible('web', false);
    expect(visible?.()).toEqual([]);
    expect(worldsChanged).toHaveBeenCalledOnce();
  } finally {
    await core.stop();
  }
});
