import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const terminal = new Set(['complete', 'aborted']);
const copy = value => value === undefined ? undefined : structuredClone(value);
const fault = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const checkAbort = signal => signal?.throwIfAborted();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function contextSourceSnapshotDigest(records) {
  const canonical = JSON.stringify(records, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return createHash('sha256').update(canonical).digest('hex');
}
function ownerMayBeAlive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
const ids = (value, name) => {
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id) || id < 0)) {
    throw fault('CONTEXT_COVERAGE_UNKNOWN', `${name} must contain known native sequence numbers.`);
  }
  return [...new Set(value)];
};
const sameIds = (a, b) => same([...ids(a, 'coverage')].sort((x, y) => x - y), [...ids(b, 'coverage')].sort((x, y) => x - y));

/** Test-only store: unlike the SQLite implementation it cannot recover after a process exit. */
export function createMemoryContextMaintenanceStore() {
  const rows = new Map();
  const history = new Map();
  const key = (sessionId, operationId) => JSON.stringify([sessionId, operationId]);
  return {
    async load(sessionId) { return copy(rows.get(sessionId) ?? null); },
    async lookup(sessionId, operationId) { return copy(history.get(key(sessionId, operationId)) ?? null); },
    async lookupGeneration(sessionId, generation) {
      return copy([...history.values()].find(row => row.sessionId === sessionId && row.phase === 'complete'
        && same(row.generation, generation)) ?? null);
    },
    async begin(record) {
      const current = rows.get(record.sessionId);
      if (current && !terminal.has(current.phase)) return false;
      const prior = history.get(key(record.sessionId, record.operationId));
      if (prior && (prior.phase !== 'aborted' || !same(prior.generation, record.generation)
        || prior.requestDigest !== record.requestDigest || prior.sourceDigest !== record.sourceDigest
        || prior.surfaceDigest !== record.surfaceDigest)) return false;
      if ([...history.values()].some(row => row.sessionId === record.sessionId && row.phase === 'complete'
        && same(row.generation, record.generation))) return false;
      rows.set(record.sessionId, copy(record)); history.set(key(record.sessionId, record.operationId), copy(record)); return true;
    },
    async update(sessionId, operationId, phase, patch) {
      const current = rows.get(sessionId);
      if (!current || current.operationId !== operationId || current.phase !== phase) return false;
      const next = { ...current, ...copy(patch), sessionId, operationId };
      rows.set(sessionId, next); history.set(key(sessionId, operationId), copy(next)); return true;
    },
    async claimRecovery(sessionId, operationId, owner) {
      const current = rows.get(sessionId);
      if (!current || current.operationId !== operationId || terminal.has(current.phase)
        || (current.executionOwner && ownerMayBeAlive(current.executionOwner))
        || (current.recoveryOwner && ownerMayBeAlive(current.recoveryOwner))) return false;
      const next = { ...current, recoveryOwner: copy(owner) };
      rows.set(sessionId, next); history.set(key(sessionId, operationId), copy(next)); return true;
    },
    async releaseRecovery(sessionId, operationId, owner) {
      const current = history.get(key(sessionId, operationId));
      if (!current || current.recoveryOwner?.nonce !== owner.nonce) return false;
      const next = { ...current, recoveryOwner: null };
      history.set(key(sessionId, operationId), copy(next));
      if (rows.get(sessionId)?.operationId === operationId) rows.set(sessionId, next);
      return true;
    },
    async releaseExecution(sessionId, operationId, owner) {
      const current = history.get(key(sessionId, operationId));
      if (!current || current.executionOwner?.nonce !== owner.nonce) return false;
      const next = { ...current, executionOwner: null };
      history.set(key(sessionId, operationId), copy(next));
      if (rows.get(sessionId)?.operationId === operationId) rows.set(sessionId, next);
      return true;
    },
  };
}

/** Persist coordination outside the native session's event format. One row per session. */
export function createSqliteContextMaintenanceStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS context_maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      generation TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, UNIQUE(session_id,operation_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS context_maintenance_one_active ON context_maintenance(session_id)
      WHERE phase NOT IN ('complete','aborted');
    CREATE UNIQUE INDEX IF NOT EXISTS context_maintenance_one_generation ON context_maintenance(session_id,generation)
      WHERE phase = 'complete'`);
  const select = db.prepare(`SELECT state FROM context_maintenance WHERE session_id = ?
    ORDER BY CASE WHEN phase NOT IN ('complete','aborted') THEN 0 ELSE 1 END,id DESC LIMIT 1`);
  const byOperation = db.prepare('SELECT state FROM context_maintenance WHERE session_id=? AND operation_id=?');
  const byGeneration = db.prepare("SELECT state FROM context_maintenance WHERE session_id=? AND generation=? AND phase='complete'");
  const put = db.prepare(`INSERT INTO context_maintenance(session_id,operation_id,generation,phase,state) VALUES(?,?,?,?,?)
    ON CONFLICT(session_id,operation_id) DO UPDATE SET phase=excluded.phase,state=excluded.state
    WHERE context_maintenance.phase='aborted' AND context_maintenance.generation=excluded.generation`);
  const update = db.prepare('UPDATE context_maintenance SET phase=?,state=? WHERE session_id=? AND operation_id=? AND phase=?');
  return {
    async load(sessionId) { const row = select.get(sessionId); return row ? JSON.parse(row.state) : null; },
    async lookup(sessionId, operationId) { const row = byOperation.get(sessionId, operationId); return row ? JSON.parse(row.state) : null; },
    async lookupGeneration(sessionId, generation) { const row = byGeneration.get(sessionId, JSON.stringify(generation)); return row ? JSON.parse(row.state) : null; },
    async begin(record) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const old = byOperation.get(record.sessionId, record.operationId);
        const prior = old ? JSON.parse(old.state) : null;
        if (byGeneration.get(record.sessionId, JSON.stringify(record.generation))
          || (prior && (prior.phase !== 'aborted' || !same(prior.generation, record.generation)
            || prior.requestDigest !== record.requestDigest || prior.sourceDigest !== record.sourceDigest
            || prior.surfaceDigest !== record.surfaceDigest))) {
          db.exec('ROLLBACK'); return false;
        }
        const active = select.get(record.sessionId);
        if (active && !terminal.has(JSON.parse(active.state).phase)) { db.exec('ROLLBACK'); return false; }
        const changed = Number(put.run(record.sessionId, record.operationId, JSON.stringify(record.generation), record.phase, JSON.stringify(record)).changes) === 1;
        db.exec(changed ? 'COMMIT' : 'ROLLBACK'); return changed;
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },
    async update(sessionId, operationId, phase, patch) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = byOperation.get(sessionId, operationId);
        const current = row ? JSON.parse(row.state) : null;
        if (!current || current.operationId !== operationId || current.phase !== phase) { db.exec('ROLLBACK'); return false; }
        const next = { ...current, ...copy(patch), sessionId, operationId };
        const changed = Number(update.run(next.phase, JSON.stringify(next), sessionId, operationId, phase).changes) === 1;
        db.exec(changed ? 'COMMIT' : 'ROLLBACK');
        return changed;
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },
    async claimRecovery(sessionId, operationId, owner) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = byOperation.get(sessionId, operationId);
        const current = row ? JSON.parse(row.state) : null;
        if (!current || terminal.has(current.phase) || (current.executionOwner && ownerMayBeAlive(current.executionOwner))
          || (current.recoveryOwner && ownerMayBeAlive(current.recoveryOwner))) {
          db.exec('ROLLBACK'); return false;
        }
        const next = { ...current, recoveryOwner: copy(owner) };
        const changed = Number(update.run(current.phase, JSON.stringify(next), sessionId, operationId, current.phase).changes) === 1;
        db.exec(changed ? 'COMMIT' : 'ROLLBACK'); return changed;
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },
    async releaseRecovery(sessionId, operationId, owner) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = byOperation.get(sessionId, operationId);
        const current = row ? JSON.parse(row.state) : null;
        if (!current || current.recoveryOwner?.nonce !== owner.nonce) { db.exec('ROLLBACK'); return false; }
        const next = { ...current, recoveryOwner: null };
        const changed = Number(update.run(current.phase, JSON.stringify(next), sessionId, operationId, current.phase).changes) === 1;
        db.exec(changed ? 'COMMIT' : 'ROLLBACK'); return changed;
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },
    async releaseExecution(sessionId, operationId, owner) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = byOperation.get(sessionId, operationId);
        const current = row ? JSON.parse(row.state) : null;
        if (!current || current.executionOwner?.nonce !== owner.nonce) { db.exec('ROLLBACK'); return false; }
        const next = { ...current, executionOwner: null };
        const changed = Number(update.run(current.phase, JSON.stringify(next), sessionId, operationId, current.phase).changes) === 1;
        db.exec(changed ? 'COMMIT' : 'ROLLBACK'); return changed;
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },
    close() { db.close(); },
  };
}

/** Use a single matching native attempt as a context-size anchor, never retry totals. */
export function measureLastAttemptContext({ snapshot, lastAttempt } = {}) {
  if (!snapshot?.fingerprint || !snapshot.provider || !snapshot.model || !lastAttempt
    || snapshot.fingerprint !== lastAttempt.fingerprint || snapshot.provider !== lastAttempt.provider
    || snapshot.model !== lastAttempt.model) return { contextInputTokens: null, reason: 'snapshot-mismatch' };
  const usage = lastAttempt.usage;
  const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!usage || !count(usage.inputTokens)) return { contextInputTokens: null, reason: 'usage-unknown' };
  if (usage.cacheSemantics === 'included-in-input') return { contextInputTokens: usage.inputTokens, reason: 'known' };
  if (usage.cacheSemantics === 'separate' && count(usage.cacheReadTokens) && count(usage.cacheWriteTokens)) {
    return { contextInputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, reason: 'known' };
  }
  return { contextInputTokens: null, reason: 'cache-unknown' };
}

/** One durable coordinator per owning host, scoped by native session identity. */
export function createFusionContextMaintenance({ store, participant, native, inputProtection, refreshPrefix }) {
  if (!store?.load || !store?.begin || !store?.update || !participant?.prepareContextHandoff
    || !participant?.commitContextHandoff || !participant?.reconcileContextHandoff
    || !native?.commit || !native?.inspect || !native?.verifySnapshot
    || typeof inputProtection !== 'function' || typeof refreshPrefix !== 'function') {
    throw new TypeError('Context maintenance requires durable store, Persona, native, input-protection and prefix participants.');
  }
  const running = new Map();

  async function transition(record, phase, patch) {
    if (!await store.update(record.sessionId, record.operationId, phase, patch)) {
      throw fault('CONTEXT_CAS_CONFLICT', 'The context maintenance phase changed concurrently.');
    }
    return { ...record, ...patch };
  }
  function validateReceipt(receipt, row) {
    if (!receipt || receipt.sessionId !== row.sessionId || receipt.operationId !== row.operationId
      || !same(receipt.generation, row.generation) || receipt.durable !== true || receipt.method !== 'native-compact') {
      throw fault('CONTEXT_COMMIT_UNKNOWN', 'Native compaction has no matching durable receipt.');
    }
    const coverage = receipt.coverage;
    if (!row.plan || !coverage || coverage.sourceComplete !== true || coverage.snapshotDigest !== row.sourceDigest
      || !sameIds(coverage.coveredNativeSeqs, row.plan.coveredNativeSeqs)
      || !sameIds(coverage.protectedNativeSeqs, row.plan.protectedNativeSeqs)) {
      throw fault('CONTEXT_COMMIT_UNKNOWN', 'Native compaction receipt does not match its protected coverage plan.');
    }
  }
  async function activate(row, receipt, signal, recovering) {
    checkAbort(signal);
    validateReceipt(receipt, row);
    if (row.phase === 'committing') row = await transition(row, 'committing', { phase: 'native-committed', nativeReceipt: copy(receipt) });
    if (row.phase === 'native-committed') row = await transition(row, 'native-committed', { phase: 'activating' });
    if (row.phase !== 'activating') throw fault('CONTEXT_CAS_CONFLICT', 'Context maintenance is not ready for activation.');
    const args = { operationId: row.operationId, generation: row.generation, nativeReceipt: receipt };
    if (recovering) await participant.reconcileContextHandoff(args);
    else await participant.commitContextHandoff(args);
    checkAbort(signal);
    await refreshPrefix({ sessionId: row.sessionId, generation: row.generation, operationId: row.operationId, signal });
    checkAbort(signal);
    row = await transition(row, 'activating', { phase: 'complete' });
    return { status: 'complete', operationId: row.operationId, sessionId: row.sessionId, generation: row.generation, nativeReceipt: receipt };
  }

  async function execute(args) {
    const { sessionId, generation, operationId, reason, boundary, snapshot, signal, runNative } = args;
    if (typeof sessionId !== 'string' || !sessionId || typeof operationId !== 'string' || !operationId
      || (typeof generation !== 'string' && !Number.isSafeInteger(generation))
      || !['idle', 'open-turn'].includes(boundary) || !Array.isArray(snapshot?.records)
      || !Array.isArray(snapshot?.surfaceSeqs)
      || snapshot.sessionId !== sessionId || !same(snapshot.generation, generation)
      || typeof snapshot.digest !== 'string' || !snapshot.digest) {
      throw fault('CONTEXT_REQUEST_INVALID', 'A session, generation, operation, safe boundary and identified request snapshot are required.');
    }
    checkAbort(signal);
    const executionOwner = { pid: process.pid, nonce: randomUUID() };
    const sourceDigest = contextSourceSnapshotDigest(snapshot.records);
    const surfaceDigest = contextSourceSnapshotDigest(snapshot.surfaceSeqs);
    const initial = { sessionId, operationId, generation, reason: reason ?? 'manual', boundary,
      requestDigest: snapshot.digest, sourceDigest, surfaceDigest, phase: 'preparing', executionOwner };
    const existing = await (store.lookup?.(sessionId, operationId) ?? store.load(sessionId));
    if (existing?.operationId === operationId) {
      if (!same(existing.generation, generation) || existing.requestDigest !== snapshot.digest
        || existing.sourceDigest !== sourceDigest || existing.surfaceDigest !== surfaceDigest) {
        throw fault('CONTEXT_OPERATION_CONFLICT', 'The operation identity already belongs to another generation or request snapshot.');
      }
      if (existing.phase === 'complete') return { status: 'complete', operationId, sessionId, generation, nativeReceipt: existing.nativeReceipt };
    }
    const completedGeneration = await store.lookupGeneration?.(sessionId, generation);
    if (completedGeneration?.phase === 'complete' || (existing?.phase === 'complete' && same(existing.generation, generation))) {
      throw fault('CONTEXT_GENERATION_CONFLICT', 'This session generation already has a completed maintenance operation.');
    }
    if (!await store.begin(initial)) {
      const raced = await (store.lookup?.(sessionId, operationId) ?? store.load(sessionId));
      if (raced?.phase === 'complete' && raced.operationId === operationId
        && same(raced.generation, generation) && raced.requestDigest === snapshot.digest
        && raced.sourceDigest === sourceDigest && raced.surfaceDigest === surfaceDigest) {
        return { status: 'complete', operationId, sessionId, generation, nativeReceipt: raced.nativeReceipt };
      }
      throw fault('CONTEXT_MAINTENANCE_BUSY', 'Another context maintenance operation requires completion or recovery.');
    }
    let row = initial;
    let nativeStarted = false;
    try {
      if (await native.verifySnapshot({ sessionId, snapshot, signal }) !== true) {
        throw fault('CONTEXT_SNAPSHOT_UNVERIFIED', 'The source snapshot does not match the native session and surface.');
      }
      checkAbort(signal);
      const prepared = await participant.prepareContextHandoff({ sessionId, operationId, generation, snapshot: snapshot.records });
      checkAbort(signal);
      if (prepared?.operationId !== operationId || prepared?.sessionId !== sessionId || !same(prepared.generation, generation)
        || prepared?.sourceCoverage?.complete !== true || typeof prepared.snapshotDigest !== 'string'
        || prepared.snapshotDigest !== sourceDigest) {
        throw fault('CONTEXT_COVERAGE_UNKNOWN', 'Original source coverage or its identity is not confirmed.');
      }
      const sources = ids(prepared.sourceCoverage.snapshotIds, 'sourceCoverage.snapshotIds');
      const surfaceSeqs = ids(snapshot.surfaceSeqs, 'snapshot.surfaceSeqs');
      if (surfaceSeqs.length !== snapshot.surfaceSeqs.length) {
        throw fault('CONTEXT_COVERAGE_UNKNOWN', 'The native surface contains duplicate sequence numbers.');
      }
      const actualRecords = new Set();
      for (const entry of snapshot.records) {
        const origin = entry?.context?.native;
        const candidates = [origin?.event?.seq, origin?.seq, entry?.context?.nativeSeq].filter(value => value !== undefined);
        if (!candidates.length) continue;
        if (origin?.sessionId !== sessionId || !origin?.event || !Number.isSafeInteger(origin.event.seq)) {
          throw fault('CONTEXT_COVERAGE_UNKNOWN', 'A native source has no matching session identity.');
        }
        if (candidates.some(value => !Number.isSafeInteger(value) || value < 0 || value !== candidates[0])) {
          throw fault('CONTEXT_COVERAGE_UNKNOWN', 'The source snapshot contains inconsistent native sequence numbers.');
        }
        actualRecords.add(candidates[0]);
      }
      const sourceRefs = prepared.sourceCoverage.sourceRefs;
      const seqRefs = prepared.sourceCoverage.seqRefs;
      if (!Array.isArray(sourceRefs) || sourceRefs.some(ref => typeof ref !== 'string' || !ref.startsWith('src:'))
        || !Array.isArray(seqRefs) || sources.some(seq => !actualRecords.has(seq))) {
        throw fault('CONTEXT_COVERAGE_UNKNOWN', 'Original source references cannot be matched to the snapshot.');
      }
      const referenceSet = new Set(sourceRefs);
      const seqMap = new Map();
      for (const entry of seqRefs) {
        if (!Number.isSafeInteger(entry?.seq) || seqMap.has(entry.seq) || !sources.includes(entry.seq)
          || !Array.isArray(entry.refs) || !entry.refs.length
          || entry.refs.some(ref => typeof ref !== 'string' || !referenceSet.has(ref))) {
          throw fault('CONTEXT_COVERAGE_UNKNOWN', 'An original source sequence has no matching durable reference.');
        }
        seqMap.set(entry.seq, entry.refs);
      }
      if (sources.some(seq => !seqMap.has(seq))) {
        throw fault('CONTEXT_COVERAGE_UNKNOWN', 'An original source sequence has no matching durable reference.');
      }
      const protection = await inputProtection({ sessionId, snapshot, prepared, signal });
      if (!protection || protection.unknown === true || protection.safe === false) {
        throw fault('CONTEXT_INPUT_PROTECTION_UNKNOWN', 'Pending input protection is not confirmed.');
      }
      let protectedNativeSeqs = ids(protection.protectedNativeSeqs, 'protectedNativeSeqs');
      row = await transition(row, 'preparing', { phase: 'prepared', sourceDigest: prepared.snapshotDigest });
      row = await transition(row, 'prepared', { phase: 'committing' });
      nativeStarted = true;
      let guarded = false;
      const guardPlan = async plan => {
        checkAbort(signal);
        if (guarded) throw fault('CONTEXT_PLAN_REUSED', 'A native compaction plan can be approved only once.');
        if (!plan || plan.sessionId !== sessionId) throw fault('CONTEXT_PLAN_INVALID', 'Native compaction plan belongs to another session.');
        const latestProtection = await inputProtection({ sessionId, snapshot, prepared, signal });
        if (!latestProtection || latestProtection.unknown === true || latestProtection.safe === false) {
          throw fault('CONTEXT_INPUT_PROTECTION_UNKNOWN', 'Pending input protection changed or is not confirmed.');
        }
        if (typeof latestProtection.revalidate !== 'function' || typeof snapshot.revalidate !== 'function') {
          throw fault('CONTEXT_INPUT_PROTECTION_UNKNOWN', 'Synchronous input and request snapshot revalidation are required at native commit.');
        }
        if (snapshot.revalidate() !== true || latestProtection.revalidate() !== true) {
          throw Object.assign(new Error('Protected inputs changed before compaction commit'), { code: 'FUSION_COMPACTION_INPUT_CHANGED' });
        }
        protectedNativeSeqs = [...new Set([...protectedNativeSeqs, ...ids(latestProtection.protectedNativeSeqs, 'protectedNativeSeqs')])];
        const shadowed = ids(plan.shadowedSeqs, 'shadowedSeqs');
        if (shadowed.some(seq => !sources.includes(seq) || !actualRecords.has(seq) || !surfaceSeqs.includes(seq))
          || shadowed.some(seq => protectedNativeSeqs.includes(seq))) {
          throw fault('CONTEXT_PLAN_UNSAFE', 'Native compaction plan includes unarchived or protected input.');
        }
        if (!same(snapshot.surfaceSeqs, plan.visibleSeqs)) {
          throw fault('CONTEXT_PLAN_STALE', 'The native surface changed after the request snapshot.');
        }
        const savedPlan = { coveredNativeSeqs: shadowed, protectedNativeSeqs, compactionId: plan.compactionId ?? null };
        row = await transition(row, 'committing', { phase: 'committing', plan: savedPlan });
        guarded = true;
        return { allow: true, revalidate: () => snapshot.revalidate() === true && latestProtection.revalidate() === true,
          coverage: { snapshotDigest: prepared.snapshotDigest, coveredNativeSeqs: [...shadowed],
            protectedNativeSeqs: [...protectedNativeSeqs], sourceComplete: true } };
      };
      const receipt = await native.commit({ sessionId, generation, operationId, prepared, snapshot, signal, runNative, guardPlan,
        protectedNativeSeqs: [...protectedNativeSeqs] });
      if (!guarded && receipt?.state === 'not-needed' && receipt.mutated === false) {
        await transition(row, 'committing', { phase: 'aborted', errorCode: 'CONTEXT_COMPACTION_NOT_NEEDED' });
        return { status: 'not-needed', operationId, sessionId, generation };
      }
      if (receipt?.state === 'not-committed' && receipt.mutated === false && receipt.error instanceof Error) {
        row = await transition(row, 'committing', { phase: 'aborted', errorCode: receipt.error.code ?? 'CONTEXT_NATIVE_FAILED' });
        throw receipt.error;
      }
      if (!guarded) throw fault('CONTEXT_COMMIT_UNKNOWN', 'Native compaction did not pass the pre-commit guard.');
      return await activate(row, receipt, signal, false);
    } catch (error) {
      if (!nativeStarted && !terminal.has(row.phase)) {
        try { await transition(row, row.phase, { phase: 'aborted', errorCode: error?.code ?? 'CONTEXT_PREPARE_FAILED' }); }
        catch { /* Keep the durable gate closed if the abort cannot be saved. */ }
      }
      throw error;
    } finally {
      await store.releaseExecution?.(sessionId, operationId, executionOwner);
    }
  }

  function maintain(args) {
    if (!args || typeof args.sessionId !== 'string' || !args.sessionId) {
      return Promise.reject(fault('CONTEXT_REQUEST_INVALID', 'A native session is required.'));
    }
    const current = running.get(args?.sessionId);
    if (current) {
      if (current.operationId === args.operationId && same(current.generation, args.generation)
        && current.requestDigest === args.snapshot?.digest
        && current.sourceDigest === (Array.isArray(args.snapshot?.records) ? contextSourceSnapshotDigest(args.snapshot.records) : null)
        && current.surfaceDigest === (Array.isArray(args.snapshot?.surfaceSeqs) ? contextSourceSnapshotDigest(args.snapshot.surfaceSeqs) : null)) return current.promise;
      if (current.operationId === args.operationId) {
        return Promise.reject(fault('CONTEXT_OPERATION_CONFLICT', 'The active operation has a different generation or request snapshot.'));
      }
      return Promise.reject(fault('CONTEXT_MAINTENANCE_BUSY', 'Another context maintenance operation is active for this session.'));
    }
    const promise = execute(args).finally(() => { if (running.get(args.sessionId)?.promise === promise) running.delete(args.sessionId); });
    running.set(args.sessionId, { operationId: args.operationId, generation: args.generation, requestDigest: args.snapshot?.digest,
      sourceDigest: Array.isArray(args.snapshot?.records) ? contextSourceSnapshotDigest(args.snapshot.records) : null,
      surfaceDigest: Array.isArray(args.snapshot?.surfaceSeqs) ? contextSourceSnapshotDigest(args.snapshot.surfaceSeqs) : null, promise });
    return promise;
  }
  async function recover({ sessionId, signal } = {}) {
    let row = await store.load(sessionId);
    if (!row || terminal.has(row.phase)) return { status: row?.phase ?? 'idle' };
    checkAbort(signal);
    if (typeof store.claimRecovery !== 'function' || typeof store.releaseRecovery !== 'function') {
      throw fault('CONTEXT_RECOVERY_STORE_UNSUPPORTED', 'The store cannot atomically claim context recovery.');
    }
    const owner = { pid: process.pid, nonce: randomUUID() };
    if (!await store.claimRecovery(sessionId, row.operationId, owner)) {
      throw fault('CONTEXT_MAINTENANCE_BUSY', 'Context recovery is already owned by another live process.');
    }
    try {
      row = await store.load(sessionId);
      if (row.phase === 'preparing' || row.phase === 'prepared') {
        row = await transition(row, row.phase, { phase: 'aborted', errorCode: 'CONTEXT_INTERRUPTED_BEFORE_COMMIT' });
        return { status: row.phase };
      }
      let receipt = row.nativeReceipt;
      if (row.phase === 'committing') {
        const observed = await native.inspect({ sessionId, operationId: row.operationId, signal });
        if (observed?.state === 'not-committed') {
          row = await transition(row, 'committing', { phase: 'aborted', errorCode: 'CONTEXT_NATIVE_NOT_COMMITTED' });
          return { status: row.phase };
        }
        if (observed?.state !== 'committed') throw fault('CONTEXT_RECOVERY_REQUIRED', 'Native compaction outcome is still unknown.');
        receipt = observed.receipt;
      }
      return await activate(row, receipt, signal, true);
    } finally { await store.releaseRecovery(sessionId, row.operationId, owner); }
  }
  function reconcile(args = {}) {
    const sessionId = args.sessionId;
    if (!sessionId) return Promise.reject(fault('CONTEXT_REQUEST_INVALID', 'A native session is required.'));
    if (running.has(sessionId)) return Promise.reject(fault('CONTEXT_MAINTENANCE_BUSY', 'Context maintenance is still active.'));
    const promise = recover(args).finally(() => { if (running.get(sessionId)?.promise === promise) running.delete(sessionId); });
    running.set(sessionId, { operationId: null, generation: null, promise });
    return promise;
  }
  async function beforeRequest({ sessionId, signal } = {}) {
    checkAbort(signal);
    if (running.has(sessionId)) throw fault('CONTEXT_RECOVERY_REQUIRED', 'Context maintenance is still active for this session.');
    const row = await store.load(sessionId);
    if (row && !terminal.has(row.phase)) {
      throw fault('CONTEXT_RECOVERY_REQUIRED', 'Context maintenance must be reconciled before the next model request.');
    }
    return true;
  }
  return Object.freeze({ maintain, reconcile, beforeRequest, status: ({ sessionId }) => store.load(sessionId) });
}
