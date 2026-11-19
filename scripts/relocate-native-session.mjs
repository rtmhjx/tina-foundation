/** Offline, receipt-backed relocation of a copied native v3 session. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const within = (root, path) => { const rel = relative(root, path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = (code, message) => { throw Object.assign(new Error(message ?? code), { code }); };

async function requireRealDirectory(path, root) {
  path = resolve(path);
  if (!within(root, path)) fail('RELOCATION_PATH_ESCAPE');
  let current = root;
  for (const segment of relative(root, path).split(sep)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('RELOCATION_REDIRECTED_DIRECTORY');
  }
  return realpath(path);
}

async function inventory(directory, prefix = '') {
  const rows = [];
  for (const item of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix + item.name;
    if (item.isDirectory()) rows.push(...await inventory(directory, path + '/'));
    else if (item.isFile()) { const bytes = await readFile(join(directory, path)); rows.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
    else fail('RELOCATION_SOURCE_LINK');
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export async function openNativePersistence(runtime, root, compression = 'zstd') {
  const require = createRequire(join(await realpath(runtime), 'package.json'));
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const [{ Context }, { default: Backend }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-session-persistence-jsonl'),
  ]);
  const ctx = new Context();
  const mount = ctx.plugin(Backend, { root, compression });
  try { await mount.await(); return { backend: ctx.sessionPersistence, close: () => mount.dispose() }; }
  catch (error) { await mount.dispose(); throw error; }
}

export async function readStrictNativeSession(backend, sessionId) {
  const path = await backend.resolveCurrentLog(sessionId);
  if (!path) fail('RELOCATION_CURRENT_V3_REQUIRED');
  const bytes = await readFile(path);
  const stored = await backend.readStoredLog(path, sessionId);
  if (stored.tornTruncateTo !== undefined || stored.recoveredTail.length) fail('RELOCATION_TORN_JOURNAL');
  if (stored.meta.version !== 3) fail('RELOCATION_CURRENT_V3_REQUIRED');
  if (hash(await readFile(path)) !== hash(bytes)) fail('RELOCATION_SOURCE_CHANGED');
  return { path, bytes, stored, journalSha256: hash(bytes), eventsSha256: hash(canonical(stored.events)) };
}

async function workspaceUpdate(home, sessionId, fromCwd, toCwd) {
  const path = join(home, 'storages/workspace.json');
  let bytes;
  try { bytes = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  const data = JSON.parse(bytes);
  if (data.unit?.name !== 'workspace' || data.unit.version !== 2 || !data.tables?.workspaces || data.global?.pendingMutation) {
    fail('RELOCATION_WORKSPACE_SCHEMA_UNSUPPORTED');
  }
  const matches = Object.entries(data.tables.workspaces).filter(([, row]) => row.sessionIds?.includes(sessionId));
  if (matches.length > 1) fail('RELOCATION_DUPLICATE_WORKSPACE_OWNER');
  if (Object.values(data.tables.workspaces).some(row => row.path === toCwd)) fail('RELOCATION_TARGET_WORKSPACE_EXISTS');
  if (!matches.length) return { path, bytes, next: null };
  const [id, row] = matches[0];
  if (row.path !== fromCwd) fail('RELOCATION_WORKSPACE_CWD_MISMATCH');
  if (row.sessionIds.length !== 1) fail('RELOCATION_SHARED_WORKSPACE_REQUIRES_BATCH');
  data.tables.workspaces[id] = { ...row, path: toCwd };
  return { path, bytes, next: Buffer.from(json(data)), id };
}

/** No production service controls and no implicit path or credential discovery. */
export async function relocateNativeSession({ runtime, deploymentRoot, home, sessionId, fromCwd, toCwd,
  backupDir, coldSnapshot = false, apply = false, compression = 'zstd', beforePublish } = {}) {
  if (!coldSnapshot) fail('RELOCATION_COLD_SNAPSHOT_REQUIRED');
  if (!/^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(sessionId ?? '')) fail('RELOCATION_INVALID_SESSION_ID');
  if (!['zstd', 'none'].includes(compression)) fail('RELOCATION_INVALID_COMPRESSION');
  const deployment = await realpath(resolve(deploymentRoot));
  if (deployment !== resolve(deploymentRoot)) fail('RELOCATION_REDIRECTED_DEPLOYMENT');
  home = await requireRealDirectory(home, deployment);
  toCwd = await requireRealDirectory(toCwd, deployment);
  if (toCwd === fromCwd) fail('RELOCATION_CWD_UNCHANGED');
  // The old workspace may be outside the new deployment; never open or write it.
  if (typeof fromCwd !== 'string' || !fromCwd.trim()) fail('RELOCATION_INVALID_OLD_CWD');
  const sessions = await requireRealDirectory(join(home, 'sessions'), deployment);
  backupDir = resolve(backupDir);
  if (!within(deployment, backupDir) || within(sessions, backupDir) || backupDir === sessions
      || within(backupDir, sessions) || within(backupDir, toCwd) || within(toCwd, backupDir) || backupDir === toCwd) fail('RELOCATION_BACKUP_PATH_ESCAPE');
  if (dirname(backupDir) !== deployment) await requireRealDirectory(dirname(backupDir), deployment);
  try { await lstat(backupDir); fail('RELOCATION_BACKUP_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const source = await openNativePersistence(runtime, sessions, compression);
  let lease, stage, oldMoved = false, newPublished = false, workspaceChanged = false;
  let oldDirectory, newDirectory;
  const receipt = { format: 1, sessionId, oldCwd: fromCwd, newCwd: toCwd, deployment,
    home, backupDir, compression, applied: false, modelRequests: 0, canonicalEventsPreserved: false,
    derivedCaches: 'Native projection identity checks cwd; query index reconciles artifact revisions.', startedAt: new Date().toISOString() };
  try {
    const initial = await readStrictNativeSession(source.backend, sessionId);
    assert.equal(initial.stored.meta.cwd, fromCwd, 'Native header cwd differs from the explicit old cwd.');
    oldDirectory = await requireRealDirectory(dirname(initial.path), sessions);
    const files = await inventory(oldDirectory);
    const workspaces = await workspaceUpdate(home, sessionId, fromCwd, toCwd);
    Object.assign(receipt, { oldJournal: initial.path, oldJournalSha256: initial.journalSha256,
      oldFiles: files, eventsSha256: initial.eventsSha256, eventCount: initial.stored.events.length,
      inheritedEventCount: initial.stored.inheritedEventCount, header: { ...initial.stored.meta },
      workspaceId: workspaces?.id ?? null, workspaceUpdate: Boolean(workspaces?.next) });
    if (!apply) return { ...receipt, planned: true, canonicalEventsPreserved: true };

    // The official cross-process lease refuses an active writer without repairing
    // or appending to the source journal. It remains held through publication.
    lease = await source.backend.acquireWriteLease(initial.stored.meta);
    const locked = await readStrictNativeSession(source.backend, sessionId);
    if (locked.journalSha256 !== initial.journalSha256) fail('RELOCATION_SOURCE_CHANGED');
    if (workspaces && !Buffer.from(await readFile(workspaces.path)).equals(workspaces.bytes)) fail('RELOCATION_WORKSPACE_CHANGED');
    await mkdir(backupDir, { mode: 0o700 });
    await cp(oldDirectory, join(backupDir, 'cold-session'), { recursive: true, errorOnExist: true, force: false });
    receipt.coldFiles = await inventory(join(backupDir, 'cold-session'));
    for (const file of files) assert.deepEqual(receipt.coldFiles.find(row => row.path === file.path), file);
    if (workspaces) await writeFile(join(backupDir, 'workspace.original.json'), workspaces.bytes, { flag: 'wx', mode: 0o600 });
    try {
      const cache = await readFile(join(home, 'storages/session_projcache/sessions', sessionId + '.json'));
      await writeFile(join(backupDir, 'projection-cache.original.json'), cache, { flag: 'wx', mode: 0o600 });
      receipt.previousProjectionCacheSha256 = hash(cache);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(join(backupDir, 'receipt.json'), json({ ...receipt, phase: 'cold-backup' }), { flag: 'wx', mode: 0o600 });

    const stagingRoot = join(backupDir, 'staging');
    stage = await openNativePersistence(runtime, stagingRoot, compression);
    const newHeader = { ...initial.stored.meta, cwd: toCwd };
    const handle = await stage.backend.create(newHeader, { inheritedEventCount: initial.stored.inheritedEventCount });
    try {
      // Preserve logical sequence/time/data, and retain bounded batches as
      // separate native frames. The native codec owns all physical encoding.
      for (let offset = 0; offset < initial.stored.events.length; offset += 256) await handle.append(initial.stored.events.slice(offset, offset + 256));
      await handle.flush();
    } finally { await handle.close(); }
    await stage.close(); stage = null;
    stage = await openNativePersistence(runtime, stagingRoot, compression);
    const rewritten = await readStrictNativeSession(stage.backend, sessionId);
    assert.deepEqual(rewritten.stored.meta, newHeader);
    assert.deepEqual(rewritten.stored.events, initial.stored.events);
    assert.equal(rewritten.stored.inheritedEventCount, initial.stored.inheritedEventCount);
    assert.equal(rewritten.eventsSha256, initial.eventsSha256);
    receipt.newJournalSha256 = rewritten.journalSha256;
    receipt.canonicalEventsPreserved = true;
    const stagedDirectory = dirname(rewritten.path);
    const sessionRelative = relative(stagingRoot, stagedDirectory);
    if (sessionRelative.startsWith('..') || isAbsolute(sessionRelative)) fail('RELOCATION_STAGE_PATH_ESCAPE');
    newDirectory = join(sessions, sessionRelative);
    if (newDirectory === oldDirectory) fail('RELOCATION_PHYSICAL_PATH_COLLISION');
    try { await lstat(newDirectory); fail('RELOCATION_TARGET_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await stage.close(); stage = null;
    await beforePublish?.();
    if (hash(await readFile(initial.path)) !== initial.journalSha256) fail('RELOCATION_SOURCE_CHANGED');
    if (workspaces && !Buffer.from(await readFile(workspaces.path)).equals(workspaces.bytes)) fail('RELOCATION_WORKSPACE_CHANGED');
    await mkdir(dirname(newDirectory), { recursive: true });
    await requireRealDirectory(dirname(newDirectory), sessions);
    await rename(oldDirectory, join(backupDir, 'quarantined-session')); oldMoved = true;
    await rename(stagedDirectory, newDirectory); newPublished = true;
    if (workspaces?.next) { await writeFile(workspaces.path, workspaces.next); workspaceChanged = true; }

    // Fresh instance: no in-memory memo may hide duplicate IDs or path errors.
    const verify = await openNativePersistence(runtime, sessions, compression);
    try {
      const published = await readStrictNativeSession(verify.backend, sessionId);
      assert.deepEqual(published.stored.meta, newHeader);
      assert.equal(published.eventsSha256, initial.eventsSha256);
      receipt.newJournal = published.path;
    } finally { await verify.close(); }
    receipt.applied = true;
    receipt.phase = 'published';
    receipt.finishedAt = new Date().toISOString();
    await writeFile(join(backupDir, 'receipt.json'), json(receipt), { mode: 0o600 });
    return receipt;
  } catch (error) {
    const failures = [error];
    if (workspaceChanged) {
      try { await writeFile(join(home, 'storages/workspace.json'), await readFile(join(backupDir, 'workspace.original.json'))); }
      catch (restore) { failures.push(restore); }
    }
    if (newPublished) { try { await rename(newDirectory, join(backupDir, 'failed-new-session')); } catch (restore) { failures.push(restore); } }
    if (oldMoved) { try { await rename(join(backupDir, 'quarantined-session'), oldDirectory); } catch (restore) { failures.push(restore); } }
    try { await writeFile(join(backupDir, 'failure.json'), json({ code: error.code ?? 'RELOCATION_FAILED', rolledBack: failures.length === 1 }), { mode: 0o600 }); }
    catch (write) { if (write.code !== 'ENOENT') failures.push(write); }
    if (failures.length > 1) throw new AggregateError(failures, 'Relocation failed and restoration needs inspection.');
    throw error;
  } finally { await stage?.close(); await lease?.release(); await source.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => args.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
  const required = name => { const value = option(name); if (!value) fail('RELOCATION_OPTION_REQUIRED', '--' + name + ' is required'); return value; };
  const receipt = await relocateNativeSession({ runtime: required('runtime'), deploymentRoot: required('deployment-root'),
    home: required('home'), sessionId: required('session-id'), fromCwd: required('from-cwd'), toCwd: required('to-cwd'),
    backupDir: required('backup-dir'), compression: option('compression') ?? 'zstd',
    coldSnapshot: args.includes('--cold-snapshot'), apply: args.includes('--apply') });
  console.log(json({ planned: receipt.planned ?? false, applied: receipt.applied, sessionId: receipt.sessionId,
    eventCount: receipt.eventCount, eventsSha256: receipt.eventsSha256, backupDir: receipt.backupDir }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(json({ code: error.code ?? 'RELOCATION_FAILED', name: error.name })); process.exitCode = 1; });
}
