/** One Cordis fiber owns each World's host lease, tool exposure and connection. */
export function createFusionWorldLifecycle(ctx, { getCore }) {
  const entries = new Map();

  function release(entry, activation = entry.activation) {
    if (!activation) return Promise.resolve();
    if (activation.releasing) return activation.releasing;
    activation.releasing = (async () => {
      const errors = [];
      try { await getCore().detachWorld(entry.world, {
        notify: !entry.hostStop, retainInstance: entry.fiber?.uid !== null,
      }); }
      catch (error) { errors.push(error); }
      // A pending start may acquire resources before it returns. Drain that
      // acquisition before stop so it cannot reopen a disposed World later.
      try { await activation.starting; } catch {}
      try { await entry.world.stop(); }
      catch (error) { errors.push(error); }
      finally {
        if (entry.fiber?.uid === null) {
          entry.removePlugin?.();
          entry.removeStatus?.();
          if (entries.get(entry.world) === entry) entries.delete(entry.world);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'World resources could not all be released.');
    })();
    return activation.releasing;
  }

  return Object.freeze({
    async start(world, host) {
      if (entries.has(world)) throw new Error('World lifecycle is already owned.');
      const entry = { world, hostStop: false, activation: undefined, fiber: undefined, runs: 0 };
      entries.set(world, entry);
      try {
        // Cordis drains an asynchronous apply before its effects. Revoke host
        // access when disposal is requested, even while start is still pending.
        entry.removePlugin = ctx.on('internal/plugin', fiber => {
          if (fiber === entry.activation?.fiber && fiber.uid === null) void release(entry).catch(() => {});
        });
        entry.removeStatus = ctx.on('internal/status', fiber => {
          if (fiber === entry.activation?.fiber && fiber.state === 5) void release(entry).catch(() => {});
        });
        entry.fiber = ctx.plugin({
          name: 'cortico-world:' + world.id,
          inject: ['corticoCore'],
          async apply(scope) {
            entry.hostStop = false;
            const resumed = entry.runs++ > 0;
            const activation = { fiber: scope.fiber, releasing: undefined, starting: undefined };
            entry.activation = activation;
            const currentHost = resumed ? getCore().renewWorldHost(world) : host;
            scope.effect(() => () => release(entry, activation));
            activation.starting = Promise.resolve().then(() => world.start(currentHost));
            try { await activation.starting; }
            catch (error) { entry.hostStop = true; throw error; }
            if (activation.releasing || scope.fiber.uid === null) throw new Error('World startup was cancelled.');
            if (resumed) await getCore().restoreWorld(world);
            scope.provide('corticoWorld:' + world.id, world);
          },
        });
        await entry.fiber;
      } catch (error) {
        entry.hostStop = true;
        const cleanup = [];
        try { await entry.fiber?.dispose(); } catch (failure) { cleanup.push(failure); }
        try { await release(entry); } catch (failure) { cleanup.push(failure); }
        entry.removePlugin?.();
        entry.removeStatus?.();
        if (entries.get(world) === entry) entries.delete(world);
        if (cleanup.length) throw new AggregateError([error, ...cleanup], 'World startup and cleanup failed.');
        throw error;
      }
    },
    async stop(world) {
      const entry = entries.get(world);
      if (!entry) return;
      entry.hostStop = true;
      await entry.fiber?.dispose();
      // Cordis reports effect failures through its lifecycle diagnostics. Core
      // also needs the terminal stop error for its shutdown report.
      await release(entry);
    },
    async ready() { await Promise.all([...entries.values()].map(entry => entry.fiber)); },
  });
}
