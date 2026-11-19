/** Start after the owning Cordis fiber publishes its services, and join teardown. */
export function activateFusionFiber(ctx, { start, stop, onStopping = () => {} }) {
  const activated = Promise.withResolvers();
  const lifetime = new AbortController();
  const inactive = () => Object.assign(new Error('The Core generation is inactive.'), {
    code: 'FUSION_GENERATION_INACTIVE',
  });
  function expire() {
    if (lifetime.signal.aborted) return;
    lifetime.abort(inactive());
    activated.reject(lifetime.signal.reason);
    onStopping();
  }
  // Cordis 4 exposes FiberState as a TypeScript const enum.
  const ACTIVE = 2, DISPOSED = 4, UNLOADING = 5;
  const removeStatus = ctx.on('internal/status', fiber => {
    if (fiber !== ctx.fiber) return;
    if (fiber.state === ACTIVE) activated.resolve();
    if (fiber.state === DISPOSED || fiber.state === UNLOADING) {
      expire();
    }
  });
  if (ctx.fiber.state === ACTIVE) activated.resolve();
  let stopped;
  const stopOnce = () => stopped ??= Promise.resolve().then(stop);
  const ready = activated.promise.then(async () => {
    try {
      lifetime.signal.throwIfAborted();
      const value = await start(lifetime.signal);
      lifetime.signal.throwIfAborted();
      return value;
    } catch (error) {
      await stopOnce();
      throw error;
    }
  });
  void ready.catch(() => {});
  let stopping;
  const close = () => stopping ??= (async () => {
    expire();
    removeStatus();
    await ready.catch(() => {});
    await stopOnce();
  })();
  ctx.effect(() => close);
  return { ready, close, signal: lifetime.signal };
}
