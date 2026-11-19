import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';

const terminal = new Set(['settled', 'withdrawn', 'discarded', 'drained']);
const stages = new Set(['pending', 'admitted', 'reserved', 'committed', ...terminal]);
const actionStages = new Set(['intent', 'completed', 'unknown']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => value === undefined ? undefined : structuredClone(value);

/** A durable projection of archived-event identity, never a second event archive.
 * Each mutation is serialized, hash chained and fsynced before it is observed.
 * The caller must own one instance per file. A separate lock rejects writers
 * from another process instead of allowing divergent sequence numbers.
 */
export async function openFusionLedger(stateDir, { openFile = open } = {}) {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, 'world-delivery.jsonl');
  const lockPath = join(stateDir, 'world-delivery.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx');
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await lock.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const saved = JSON.parse(await readFile(lockPath, 'utf8'));
    try { process.kill(saved.pid, 0); }
    catch (probe) {
      if (probe.code !== 'ESRCH') throw probe;
      const { unlink } = await import('node:fs/promises');
      await unlink(lockPath);
      return openFusionLedger(stateDir, { openFile });
    }
    throw Object.assign(new Error('World delivery ledger is already open.'), { code: 'WORLD_LEDGER_LOCKED' });
  }
  let handle;
  try {
    const rows = new Map();
    const actions = new Map();
    const promoted = new Set();
    function rememberPromotion(current, next) {
      if (next?.promotion?.explicit === true) { promoted.add(next.id); return; }
      if (!current || !['pending', 'admitted'].includes(current.stage) || next.stage !== current.stage
        || !['flush', 'preempt', 'interrupt'].includes(next.trigger)) return;
      // The old promote API wrote one same-stage row changing only trigger,
      // including a duplicate row when promoting an already-flush entry.
      // Treat this exact durable shape conservatively as promotion evidence.
      const before = { ...current }, after = { ...next };
      delete before.trigger; delete after.trigger;
      if (digest(before) === digest(after)) promoted.add(next.id);
    }
    let seq = 0;
    let previous = '';
    let source = await readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    // A torn final append never became durable. Preserve bytes for diagnosis,
    // then repair only this ledger file before appending another valid record.
    if (source && !source.endsWith('\n')) {
      const boundary = source.lastIndexOf('\n') + 1;
      await writeFile(join(stateDir, 'world-delivery-torn-' + randomUUID() + '.txt'), source.slice(boundary), { flag: 'wx' });
      const complete = source.slice(0, boundary);
      await truncate(path, Buffer.byteLength(complete));
      source = complete;
    }
    for (const line of source.split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      const { hash, ...body } = record;
      if (body.seq !== seq + 1 || body.previous !== previous || digest(body) !== hash) {
        throw Object.assign(new Error('World delivery ledger integrity check failed.'), { code: 'WORLD_LEDGER_CORRUPT' });
      }
      if (body.kind !== 'action') rememberPromotion(rows.get(body.entry.id), body.entry);
      (body.kind === 'action' ? actions : rows).set(body.entry.id, body.entry);
      seq = body.seq;
      previous = hash;
    }
    handle = await openFile(path, 'a');
    let queue = Promise.resolve();
    let closing = false;
    let closed;
    let failure;
    function mutate(id, update, kind = 'event') {
      if (closing) return Promise.reject(new Error('World delivery ledger is closed.'));
      const operation = queue.then(async () => {
        if (failure) throw failure;
        const target = kind === 'action' ? actions : rows;
        const current = target.get(id);
        const entry = update(clone(current));
        if (!entry) return clone(current);
        if (!(kind === 'action' ? actionStages : stages).has(entry.stage) || entry.id !== id) throw new Error('Invalid World delivery state.');
        const body = { seq: seq + 1, previous, ...(kind === 'action' ? { kind } : {}), entry };
        const hash = digest(body);
        try {
          await handle.writeFile(JSON.stringify({ ...body, hash }) + '\n');
          await handle.sync();
        } catch (error) {
          failure = error;
          throw error;
        }
        seq++;
        previous = hash;
        if (kind !== 'action') rememberPromotion(current, entry);
        target.set(id, entry);
        return clone(entry);
      });
      queue = operation.catch(() => {});
      return operation;
    }
    return Object.freeze({
      path,
      get(id) { return clone(rows.get(id)); },
      hasPromotionEvidence(id) { return promoted.has(id); },
      list({ active = false } = {}) { return [...rows.values()].filter(row => !active || !terminal.has(row.stage)).map(clone); },
      add({ id, worldId, cursor, sourceCursors = [], trigger = 'flush', inputPriority = 0 }) {
        if (typeof id !== 'string' || !id || typeof worldId !== 'string' || !worldId || !Number.isSafeInteger(cursor)) {
          return Promise.reject(new Error('An archived World event identity is required.'));
        }
        return mutate(id, current => {
          if (current) {
            if (current.worldId !== worldId || current.cursor !== cursor) throw new Error('World event identity conflict.');
            return undefined;
          }
          return { id, worldId, cursor, sourceCursors, trigger, inputPriority, stage: 'pending' };
        });
      },
      transition(id, from, stage, fields = {}) {
        return mutate(id, current => {
          if (!current) throw new Error('Unknown World event identity.');
          if (terminal.has(current.stage) && !(current.stage === 'drained' && stage === 'pending')) return undefined;
          if (![].concat(from).includes(current.stage)) {
            throw Object.assign(new Error('World event state changed.'), { code: 'WORLD_DELIVERY_CONFLICT' });
          }
          // Identity cannot be changed by a transition.
          return { ...current, ...fields, id: current.id, worldId: current.worldId, cursor: current.cursor, stage };
        });
      },
      requestRequeue(id, requested = true) {
        return mutate(id, current => {
          if (!current || current.stage !== 'drained' || (current.requeueRequested === true) === requested) return undefined;
          return { ...current, requeueRequested: requested };
        });
      },
      // Optional, reconstructable receipts extend an existing event record.
      // Keep the historical stage vocabulary and identity readable by v3.
      inputReceipt(id, receipt) {
        return mutate(id, current => {
          if (!current) throw new Error('Unknown World event identity.');
          if (terminal.has(current.stage)) return undefined;
          return { ...current, inputDelivery: { ...current.inputDelivery, ...clone(receipt), version: 1 } };
        });
      },
      actions() { return [...actions.values()].map(clone); },
      action(id) { return clone(actions.get(id)); },
      beginAction({ id, worldId, toolName, callId, argsHash }) {
        if ([id, worldId, toolName, callId, argsHash].some(value => typeof value !== 'string' || !value)) {
          return Promise.reject(new Error('A native World action identity is required.'));
        }
        return mutate(id, current => {
          if (current) {
            if (current.worldId !== worldId || current.toolName !== toolName || current.callId !== callId || current.argsHash !== argsHash) {
              throw new Error('World action identity conflict.');
            }
            return undefined;
          }
          return { id, worldId, toolName, callId, argsHash, stage: 'intent' };
        }, 'action');
      },
      completeAction(id, receipt) {
        return mutate(id, current => {
          if (!current) throw new Error('Unknown World action.');
          if (current.stage === 'completed') return undefined;
          if (current.stage !== 'intent') throw new Error('World action outcome is unknown.');
          return { ...current, stage: 'completed', receipt: clone(receipt) };
        }, 'action');
      },
      releaseActionQueue(id) {
        return mutate(id, current => {
          if (!current || current.stage !== 'completed' || current.queueReleased) return undefined;
          return { ...current, queueReleased: true };
        }, 'action');
      },
      unknownAction(id) {
        return mutate(id, current => {
          if (!current || current.stage !== 'intent') return undefined;
          return { ...current, stage: 'unknown' };
        }, 'action');
      },
      async flush() { await queue; if (failure) throw failure; },
      close() {
        if (closed) return closed;
        closing = true;
        closed = (async () => {
          await queue;
          await handle.close();
          await lock.close();
          const { unlink } = await import('node:fs/promises');
          await unlink(lockPath);
          if (failure) throw failure;
        })();
        return closed;
      },
    });
  } catch (error) {
    await handle?.close();
    await lock.close();
    const { unlink } = await import('node:fs/promises');
    await unlink(lockPath);
    throw error;
  }
}

export function fusionEventId(sessionId, worldId, cursor) {
  return createHash('sha256').update(JSON.stringify([sessionId, worldId, cursor])).digest('hex');
}
