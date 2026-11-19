import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, chmod, readFile, readdir, unlink, rename } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';

async function privateDirectory(path) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || s.uid !== process.getuid()) throw Error('ipc_directory_not_private');
}

// Snapshot before arbitration; helper receives the snapshot, never a mutable
// caller path. Existing files are not overwritten or deleted by this candidate.
export async function snapshotAudio(path, volume, folder, allowedRoots, maxSnapshotBytes = 256 * 1024 * 1024) {
  if (!isAbsolute(path) || !Number.isInteger(volume) || volume < 0 || volume > 100) throw Error('audio_input_invalid');
  await privateDirectory(folder);
  if (!Array.isArray(allowedRoots) || !allowedRoots.length) throw Error('audio_roots_required');
  const resolved = await realpath(path), roots = await Promise.all(allowedRoots.map(root => realpath(root)));
  if (!roots.some(root => { const rel = relative(root, resolved); return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); })) throw Error('audio_path_not_allowed');
  // Reject a final symlink as well; do not follow an untrusted leaf.
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024) throw Error('audio_input_invalid');
    bytes = await source.readFile();
    if (bytes.length !== stat.size) throw Error('audio_input_changed');
  } finally { await source.close(); }
  const names = (await readdir(folder)).filter(name => /^audio-[0-9a-f-]{36}\.source$/.test(name));
  let retained = 0;
  for (const name of names) { const s = await lstat(join(folder, name)); if (!s.isFile() || s.isSymbolicLink()) throw Error('snapshot_inventory_invalid'); retained += s.size; }
  if (retained + bytes.length > maxSnapshotBytes) throw Error('snapshot_capacity_reached');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const destination = join(folder, `audio-${randomUUID()}.source`), file = await open(destination, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await chmod(destination, 0o400);
  const d = await open(folder, 'r'); try { await d.sync(); } finally { await d.close(); }
  return { path: destination, sha256, volume };
}

export function helperExecutor({ executable, expectedHelperSha256, stateDir, linkPath, spawnImpl = spawn }) {
  if (!isAbsolute(executable) || !isAbsolute(stateDir ?? '') || !isAbsolute(linkPath ?? '') || !/^[0-9a-f]{64}$/.test(expectedHelperSha256 ?? '')) throw Error('helper_path_or_hash_invalid');
  return async (snapshot, signal) => {
    if (createHash('sha256').update(await readFile(snapshot.path)).digest('hex') !== snapshot.sha256) return { state: 'unknown' };
    const helperStat = await lstat(executable);
    if (!helperStat.isFile() || helperStat.isSymbolicLink() || createHash('sha256').update(await readFile(executable)).digest('hex') !== expectedHelperSha256) return { state: 'unknown' };
    if (signal?.aborted) return { state: 'not_started', guardReleased: true };
    return new Promise(resolve => {
    const child = spawnImpl(executable, ['--file', snapshot.path, '--volume', String(snapshot.volume)],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CANBOT_AUDIO_STATE: stateDir, CANBOT_AUDIO_LINK: linkPath } });
    let text = '', tooLarge = false, completed = false, spawned = false;
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', data => { if (text.length + data.length > 65536) tooLarge = true; else text += data.toString('utf8'); });
    const finish = result => { if (completed) return; completed = true; signal?.removeEventListener('abort', cancel); resolve(result); };
    // An OS-level exec failure before the spawn event cannot have submitted a
    // media operation. Errors after spawn still retain the unknown latch.
    child.once('spawn', () => { spawned = true; });
    child.on('error', error => finish(!spawned && ['EACCES', 'ENOENT'].includes(error?.code)
      ? { state: 'not_started', guardReleased: true } : { state: 'unknown' }));
    child.on('close', async code => {
      let receipt; try { receipt = JSON.parse(text.trim()); } catch { return finish({ state: 'unknown' }); }
      let intact = false; try { intact = createHash('sha256').update(await readFile(snapshot.path)).digest('hex') === snapshot.sha256
        && createHash('sha256').update(await readFile(executable)).digest('hex') === expectedHelperSha256; } catch { /* unknown */ }
      if (!tooLarge && intact && code === 0 && receipt.outcome === 'completed' && receipt.settled === true
          && /^[0-9a-f]{64}$/.test(receipt.wavSha256 ?? '') && Number.isSafeInteger(receipt.frames) && receipt.frames > 0
          && typeof receipt.operationId === 'string' && receipt.operation?.result?.wavSha256 === receipt.wavSha256
          && receipt.operation?.result?.playbackComplete === true && receipt.operation.result.expectedFrames === receipt.frames
          && receipt.operation.result.playbackHeadFrames >= receipt.frames)
        return finish({ state: 'completed', settled: true, guardReleased: true, value: receipt });
      finish({ state: 'unknown' });
    });
    if (signal?.aborted) cancel();
    });
  };
}

// UNIX socket must be under a pre-created 0700 directory owned by this UID;
// server never removes an existing socket. Both Worlds must use this same owner.
export async function createAudioIpc({ coordinator, folder, allowedRoots, timeoutMs = 120000, maxSnapshotBytes = 256 * 1024 * 1024, maxAdmissions = 4096 }) {
  await privateDirectory(folder);
  if (!Array.isArray(allowedRoots) || !allowedRoots.length || allowedRoots.some(root => !isAbsolute(root))) throw Error('audio_roots_required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120000) throw Error('timeout_invalid');
  if (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 1 || maxSnapshotBytes > 1024 * 1024 * 1024 || !Number.isInteger(maxAdmissions) || maxAdmissions < 1 || maxAdmissions > 4096) throw Error('storage_limit_invalid');
  const path = join(folder, 'media.sock');
  let admissionsQueue = Promise.resolve();
  const prepare = value => {
    const job = admissionsQueue.then(async () => {
      const names = await readdir(folder);
      if (names.filter(name => /^admission-[0-9a-f-]{36}\.json$/.test(name)).length >= maxAdmissions) throw Error('admission_capacity_reached');
      const admission = await open(join(folder, `admission-${value.requestId}.json`), 'wx', 0o600);
      try { await admission.writeFile(JSON.stringify({ requestId: value.requestId, state: 'pending_outcome_unknown' })); await admission.sync(); } finally { await admission.close(); }
      const dir = await open(folder, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      try { return await snapshotAudio(value.file, value.volume, folder, allowedRoots, maxSnapshotBytes); }
      catch (error) {
        const safe = ['audio_path_not_allowed', 'audio_input_invalid', 'snapshot_capacity_reached'].includes(error.message);
        if (safe) {
          const temp = join(folder, `admission-${value.requestId}.${randomUUID()}.tmp`), f = await open(temp, 'wx', 0o600);
          try { await f.writeFile(JSON.stringify({ requestId: value.requestId, state: 'rejected', code: error.message })); await f.sync(); } finally { await f.close(); }
          await rename(temp, join(folder, `admission-${value.requestId}.json`));
          const d = await open(folder, 'r'); try { await d.sync(); } finally { await d.close(); }
        }
        throw error;
      }
    });
    admissionsQueue = job.catch(() => {}); return job;
  };
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    let input = '', dispatched = false; const abort = new AbortController();
    socket.setTimeout(timeoutMs, () => { abort.abort(); socket.destroy(); });
    socket.on('close', () => { sockets.delete(socket); abort.abort(); });
    socket.on('error', () => abort.abort());
    socket.on('data', async data => {
      if (dispatched) return; input += data.toString('utf8');
      if (input.length > 8192) { dispatched = true; socket.destroy(); return; }
      if (!input.includes('\n')) return;
      dispatched = true;
      let dispatchedToCoordinator = false;
      try {
        const value = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.requestId ?? '')) throw Error('request_id_invalid');
        if (value.action === 'receipt' && Object.keys(value).sort().join() === 'action,requestId') {
          const receipt = await coordinator.receipt(value.requestId);
          let admitted = null; try { admitted = JSON.parse(await readFile(join(folder, `admission-${value.requestId}.json`), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') admitted = { state: 'pending_outcome_unknown' }; }
          socket.end(JSON.stringify({ requestId: value.requestId, receipt: receipt ?? admitted }) + '\n'); return;
        }
        if (value.action !== 'play' || Object.keys(value).sort().join() !== 'action,file,requestId,volume') throw Error('arguments_invalid');
        // The immutable exclusive admission makes a replay of this request ID
        // read-only, including failures before the coordinator journal exists.
        if (await coordinator.receipt(value.requestId)) throw Error('request_already_exists_use_receipt');
        const snapshot = await prepare(value);
        dispatchedToCoordinator = true;
        const result = await coordinator.audio(snapshot, abort.signal, value.requestId);
        const ok = result.arbitration.state === 'completed' && result.arbitration.playbackState === 'completed';
        const unavailable = result.arbitration.state === 'rejected' && result.arbitration.reason === 'device_unavailable'
          && result.arbitration.playbackSent === false;
        const notStarted = result.arbitration.state === 'completed' && result.arbitration.playbackState === 'not_started'
          && result.arbitration.playbackSent === false;
        const rejected = unavailable || notStarted;
        let cleanup = 'retained', confirmed = false;
        if (ok || rejected) {
          // Clean up only after the durable terminal receipt proves the result.
          const receipt = await coordinator.receipt(value.requestId);
          confirmed = (ok && receipt?.state === 'completed' && receipt.playbackState === 'completed')
            || (unavailable && receipt?.state === 'rejected' && receipt.reason === 'device_unavailable' && receipt.playbackSent === false)
            || (notStarted && receipt?.state === 'completed' && receipt.playbackState === 'not_started' && receipt.playbackSent === false);
          if (confirmed && ok) {
            try {
              await unlink(snapshot.path);
              const dir = await open(folder, 'r'); try { await dir.sync(); } finally { await dir.close(); }
              await unlink(join(folder, `admission-${value.requestId}.json`));
              const again = await open(folder, 'r'); try { await again.sync(); } finally { await again.close(); }
              cleanup = 'removed_confirmed';
            } catch { cleanup = 'cleanup_unknown'; }
          } else if (confirmed && rejected) cleanup = 'retained_confirmed_rejected';
        }
        socket.end(JSON.stringify({ requestId: value.requestId, outcome: confirmed && ok ? 'completed' : confirmed && rejected ? 'rejected' : 'unknown',
          ...(confirmed && rejected ? { code: notStarted ? 'playback_not_started' : 'device_unavailable' } : {}), cleanup }) + '\n');
      } catch (error) {
        const known = ['audio_path_not_allowed', 'audio_input_invalid', 'snapshot_capacity_reached', 'admission_capacity_reached'].includes(error.message);
        socket.end(JSON.stringify(known && !dispatchedToCoordinator ? { outcome: 'rejected', code: error.message } : { outcome: 'unknown' }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  const socketStat = await lstat(path);
  if (!socketStat.isSocket() || socketStat.uid !== process.getuid() || (socketStat.mode & 0o077)) { server.close(); throw Error('socket_permissions_invalid'); }
  return { server, path, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
