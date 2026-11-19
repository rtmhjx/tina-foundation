// Adapt the existing StreamGuard process to expose proven OS-lock release.
export function withReleaseProof(guard, timeoutMs = 5000) {
  if (!guard || typeof guard.lock !== 'function' || typeof guard.reserve !== 'function' || typeof guard.settle !== 'function') throw Error('guard_invalid');
  return {
    lock: () => guard.lock(), reserve: op => guard.reserve(op), settle: (id, result) => guard.settle(id, result),
    releaseUnknown: () => guard.releaseUnknown(),
    waitReleased: async () => {
      const child = guard.child;
      if (!child) return false;
      if (child.exitCode !== null) return child.exitCode === 0 && child.signalCode === null;
      return new Promise(resolve => {
        const timer = setTimeout(() => finish(false), timeoutMs);
        const finish = ok => { clearTimeout(timer); child.off('exit', onExit); child.off('error', onError); resolve(ok); };
        const onExit = (code, signal) => finish(code === 0 && signal === null);
        const onError = () => finish(false);
        child.once('exit', onExit); child.once('error', onError);
        // The child may exit between the first check and handler installation.
        if (child.exitCode !== null) finish(child.exitCode === 0 && child.signalCode === null);
      });
    },
  };
}
