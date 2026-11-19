import { startDshRuntime } from './dsh-runtime.mjs';

export const name = 'tina-dsh-runtime';

/** The Cordis fiber owns the isolated DSH CLI and removes its service on exit. */
export async function apply(ctx, config) {
  const controller = new AbortController();
  let runtime;
  ctx.effect(() => async () => {
    controller.abort();
    await runtime?.stop();
  });
  runtime = await startDshRuntime({ ...config, signal: controller.signal });
  const unpublish = ctx.provide('dshRuntime', runtime);
  const removeAfterExit = () => { if (!controller.signal.aborted) unpublish(); };
  void runtime.exited.then(removeAfterExit, removeAfterExit);
}
