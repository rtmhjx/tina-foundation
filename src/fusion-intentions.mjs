import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const name = 'fusion-intentions';
export const inject = ['corticoCore', 'tools'];
const MAX_DELAY = 2_147_483_647;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const clone = value => structuredClone(value);
const failure = (code, text) => Object.assign(new Error(text), { code });
const wakeIdentity = (id, dueAt, generation) => createHash('sha256').update(JSON.stringify([id, dueAt, generation])).digest('hex');

function validateState(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.goals)) {
    throw failure('INTENTIONS_STATE_INVALID', 'The persistent intentions state is invalid.');
  }
  const ids = new Set();
  for (const goal of value.goals) {
    if (!goal || !idPattern.test(goal.id) || ids.has(goal.id) || typeof goal.text !== 'string' || !goal.text.trim()
      || goal.text.length > 16000 || !['active', 'completed', 'abandoned'].includes(goal.status)
      || !Number.isSafeInteger(goal.generation) || goal.generation < 0) {
      throw failure('INTENTIONS_STATE_INVALID', 'A persistent intention record is invalid.');
    }
    ids.add(goal.id);
    if (goal.wake && (typeof goal.wake.id !== 'string' || !Number.isFinite(Date.parse(goal.wake.dueAt))
      || !['scheduled', 'pending', 'archived', 'cancelled'].includes(goal.wake.stage)
      || goal.wake.id !== wakeIdentity(goal.id, goal.wake.dueAt, goal.generation))) {
      throw failure('INTENTIONS_STATE_INVALID', 'An intention wake record is invalid.');
    }
  }
  return value;
}

/** Persistence and one-shot scheduling only. The Persona owns goal semantics.
 * The file path comes exclusively from the host configuration, never tool args.
 */
export async function openIntentions({
  memoryDir, core, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  onError = () => {}, fault = async () => {},
}) {
  if (!isAbsolute(memoryDir ?? '') || typeof core?.store?.append !== 'function' || typeof core?.bus?.push !== 'function') {
    throw new Error('Intentions require a host-owned absolute Memory directory and the native Cortico Core.');
  }
  await mkdir(memoryDir, { recursive: true });
  const path = join(memoryDir, '.tina-intentions.json');
  const lockPath = join(memoryDir, '.tina-intentions.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx');
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await lock.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') {
      if (lock) { await lock.close(); await unlink(lockPath); }
      throw error;
    }
    const previous = JSON.parse(await readFile(lockPath, 'utf8'));
    try { process.kill(previous.pid, 0); }
    catch (probe) {
      if (probe.code !== 'ESRCH') throw probe;
      await unlink(lockPath);
      return openIntentions({ memoryDir, core, now, setTimer, clearTimer, onError, fault });
    }
    throw failure('INTENTIONS_LOCKED', 'The intentions store is already owned by another active plugin.');
  }
  let state;
  try {
    state = validateState(await readFile(path, 'utf8').then(JSON.parse).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, revision: 0, goals: [] };
    }));
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
  let queue = Promise.resolve();
  let timer;
  let closing = false;
  let closed;
  let schedulerFailed = false;
  async function persist(next) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    const file = await open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(next, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    state = next;
  }
  async function update(transform) {
    const next = clone(state);
    const changed = transform(next);
    if (changed === false) return;
    next.revision++;
    validateState(next);
    await persist(next);
  }
  function arm() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (closing || schedulerFailed) return;
    const due = state.goals.filter(goal => goal.status === 'active' && goal.wake
      && ['scheduled', 'pending'].includes(goal.wake.stage)).map(goal => Date.parse(goal.wake.dueAt));
    if (!due.length) return;
    const delay = Math.min(MAX_DELAY, Math.max(0, Math.min(...due) - now()));
    timer = setTimer(() => {
      timer = undefined;
      void runDue().catch(error => { try { onError(error?.code ?? 'INTENTIONS_SCHEDULER'); } catch {} });
    }, delay);
    timer?.unref?.();
  }
  function serialize(job) {
    if (closing) return Promise.reject(failure('INTENTIONS_CLOSED', 'The intentions plugin is stopped.'));
    const operation = queue.then(job);
    queue = operation.catch(() => {});
    void operation.then(arm, arm);
    return operation;
  }
  function findArchived(wakeId) {
    return core.store.range({ fromCursor: 1 }).find(event => event.source === 'persona'
      && event.origin === 'internal' && event.type === 'intention.wake' && event.meta?.wakeId === wakeId);
  }
  function runDue() {
    const operation = serialize(async () => {
      const dueIds = state.goals.filter(goal => goal.status === 'active' && goal.wake
        && ['scheduled', 'pending'].includes(goal.wake.stage) && Date.parse(goal.wake.dueAt) <= now()).map(goal => goal.id);
      for (const id of dueIds) {
        if (closing) return;
        let goal = state.goals.find(item => item.id === id);
        if (goal.wake.stage === 'scheduled') {
          await update(next => { next.goals.find(item => item.id === id).wake.stage = 'pending'; });
          await fault('after-intent');
          goal = state.goals.find(item => item.id === id);
        }
        if (closing) return;
        let archived = findArchived(goal.wake.id);
        if (!archived) {
          archived = core.store.append({
            source: 'persona', origin: 'internal', type: 'intention.wake',
            ts: new Date(now()).toISOString(), contextDelivery: 'deliver',
            text: 'A self-authored intention is due. Decide whether to act, revise, complete or abandon it. No reply is required.\n'
              + JSON.stringify({ id: goal.id, text: goal.text, dueAt: goal.wake.dueAt }),
            meta: { wakeId: goal.wake.id, intentionId: goal.id },
          });
          await fault('after-archive');
          if (closing) return;
          core.bus.push({ event: archived }, { trigger: 'flush' });
          await fault('after-dispatch');
        }
        // Existing archived wakes belong to the driver's normal recovery path.
        // Never append another event when the process died before this receipt.
        await update(next => {
          const current = next.goals.find(item => item.id === id);
          current.wake.stage = 'archived';
          current.wake.archiveCursor = archived.cursor;
        });
      }
    });
    return operation.catch(error => {
      // A failed side-effect boundary must not create an immediate retry loop.
      // Its durable pending state is recovered on restart or explicit editing.
      schedulerFailed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      throw error;
    });
  }
  const api = {
    path,
    list: () => ({ revision: state.revision, goals: clone(state.goals) }),
    operate(args, { signal } = {}) {
      return serialize(async () => {
        signal?.throwIfAborted();
        const { action = 'list', id, text, dueAt, revision } = args ?? {};
        if (action === 'list') return api.list();
        if (!['upsert', 'complete', 'abandon'].includes(action) || !idPattern.test(id ?? '')) {
          throw failure('INTENTIONS_ARGUMENTS', 'Use a declared action and a stable intention id.');
        }
        if (!Number.isSafeInteger(revision) || revision !== state.revision) {
          throw failure('INTENTIONS_REVISION_CONFLICT', 'Intentions changed; currentRevision=' + state.revision
            + '. You must list them again before editing; do not guess a replacement revision.');
        }
        let normalizedDue;
        if (dueAt !== undefined) {
          if (typeof dueAt !== 'string' || (dueAt !== '' && !Number.isFinite(Date.parse(dueAt)))) {
            throw failure('INTENTIONS_ARGUMENTS', 'dueAt must be an ISO date, or an empty string to remove the wake.');
          }
          normalizedDue = dueAt === '' ? null : new Date(dueAt).toISOString();
        }
        await update(next => {
          let goal = next.goals.find(item => item.id === id);
          if (action === 'upsert') {
            if (typeof text !== 'string' || !text.trim() || text.length > 16000) {
              throw failure('INTENTIONS_ARGUMENTS', 'An intention requires nonempty text of at most 16000 characters.');
            }
            const previousStatus = goal?.status;
            if (!goal) { goal = { id, text, status: 'active', generation: 0 }; next.goals.push(goal); }
            const scheduleChanged = normalizedDue !== undefined
              && (normalizedDue !== (goal.wake?.dueAt ?? null) || goal.wake?.stage === 'cancelled');
            goal.text = text;
            goal.status = 'active';
            if (normalizedDue === null) {
              if (goal.wake) goal.wake.stage = 'cancelled';
            } else if (normalizedDue !== undefined && (scheduleChanged || previousStatus && previousStatus !== 'active')) {
              goal.generation++;
              goal.wake = { id: wakeIdentity(id, normalizedDue, goal.generation), dueAt: normalizedDue, stage: 'scheduled' };
            }
          } else {
            if (!goal) throw failure('INTENTIONS_NOT_FOUND', 'The intention does not exist.');
            goal.status = action === 'complete' ? 'completed' : 'abandoned';
            if (goal.wake && ['scheduled', 'pending'].includes(goal.wake.stage)) goal.wake.stage = 'cancelled';
          }
        });
        schedulerFailed = false;
        return api.list();
      });
    },
    runDue,
    close() {
      if (closed) return closed;
      closing = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      closed = (async () => {
        await queue;
        await lock.close();
        await unlink(lockPath);
      })();
      return closed;
    },
  };
  // Recover overdue pending intents immediately. Empty state installs no timer.
  try { await runDue(); } catch (error) { await api.close(); throw error; }
  return Object.freeze(api);
}

export async function apply(ctx, { memoryDir, toolContext }) {
  const intentions = await openIntentions({
    memoryDir, core: ctx.corticoCore,
    onError: code => ctx.corticoCore.log?.warn?.('Intention wake was not completed', { code }),
  });
  ctx.effect(() => () => intentions.close());
  ctx.provide('fusionIntentions', intentions);
  const removeTool = (toolContext ?? ctx).tools.register({
    name: 'tina_intentions',
    description: 'Maintain your own persistent intentions and goals. List first and use its revision for changes. Use a stable id. upsert records your goal text; optional dueAt is one ISO date for one autonomous World wake, and an empty string cancels its wake. Complete or abandon goals when appropriate. Stored goals are not commands from a human and do not require replying to anyone.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'upsert', 'complete', 'abandon'] },
        id: { type: 'string' }, text: { type: 'string' }, dueAt: { type: 'string' }, revision: { type: 'integer' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['revision', 'goals'],
        properties: { revision: { type: 'integer' }, goals: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    isConcurrencySafe: args => args?.action === 'list' || args?.action === undefined,
    execute: (args, exec) => intentions.operate(args, exec),
  });
  if (toolContext) ctx.effect(() => removeTool);
}
