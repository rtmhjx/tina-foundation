import { parentPort, workerData } from 'node:worker_threads';
import { loadLegacyRecallIndex, createLegacyRecallPool, legacySnapshotIdentity, legacyHits, POOL_SCOPE } from './legacy-hybrid.mjs';

try {
  const { rows, space, identity } = loadLegacyRecallIndex(workerData.indexFile);
  if (identity !== workerData.identity) throw Object.assign(new Error('Legacy index changed before warmup; recreate the adapter.'), { code: 'LEGACY_INDEX_STALE' });
  const pool = createLegacyRecallPool(rows, space.model);
  const matrix = pool.store.matrixFor(POOL_SCOPE);
  const matrixRowByRef = new Map(matrix?.rows.map((row, position) => [pool.ordered[row].ref, position]) ?? []);
  if (legacySnapshotIdentity(workerData.indexFile) !== identity) throw Object.assign(new Error('Legacy index changed during warmup; recreate the adapter.'), { code: 'LEGACY_INDEX_STALE' });
  parentPort.postMessage({ type: 'ready' });
  parentPort.on('message', ({ type, id, args }) => {
    if (type !== 'search') return;
    try {
      if (legacySnapshotIdentity(workerData.indexFile) !== identity) throw Object.assign(new Error('Legacy index changed; recreate the adapter.'), { code: 'LEGACY_INDEX_STALE' });
      const selected = rows.filter(row => (args.legacyScope === undefined || row.scope === args.legacyScope) && (args.agentId === undefined || row.agentId === args.agentId) && (args.channel === undefined || row.channel === args.channel));
      let view = pool;
      if (selected.length !== rows.length) {
        view = createLegacyRecallPool(selected, space.model);
        // Pinned VectorStore's cache stores already-normalized rows. Copy selected
        // rows from the warm global matrix; never decode them again on a query.
        const valid = view.ordered.flatMap((row, localIndex) => matrixRowByRef.has(row.ref) ? [{ localIndex, matrixRow: matrixRowByRef.get(row.ref) }] : []);
        let m = null;
        if (valid.length) {
          const values = new Float32Array(valid.length * matrix.dim);
          valid.forEach((item, position) => values.set(matrix.matrix.subarray(item.matrixRow * matrix.dim, (item.matrixRow + 1) * matrix.dim), position * matrix.dim));
          m = { matrix: values, dim: matrix.dim, rows: valid.map(item => item.localIndex) };
        }
        view.store.matrices.set(POOL_SCOPE, { version: 0, m });
      }
      const hits = legacyHits(view, view.store.hybridSearch(POOL_SCOPE, args.query, args.queryVector, args.limit));
      parentPort.postMessage({ type: 'result', id, hits });
    } catch (error) { parentPort.postMessage({ type: 'result', id, error: { code: error.code ?? 'LEGACY_QUERY_FAILED', message: error.message } }); }
  });
} catch (error) {
  parentPort.postMessage({ type: 'failed', code: error.code ?? 'LEGACY_WARMUP_FAILED', message: error.message });
}
