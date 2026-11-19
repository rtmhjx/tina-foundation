import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { request as httpRequest } from 'node:http';

export const AUDIO_HANDLE = /^log:[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.wav$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export class AnalysisError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'AnalysisError'; this.details = details; }
}

export function parseAnalysisWav(value, { minSeconds = 0.5, maxSeconds = 10 } = {}) {
  if (!(value instanceof Uint8Array)) throw new AnalysisError('analysis_wav_bytes_required');
  if (value.length < 44 || value.length > 384044) throw new AnalysisError('analysis_wav_invalid');
  const bytes = Buffer.from(value); // a bounded independent snapshot, never mutate the original blob
  if (bytes.length < 44 || bytes.length > 384044 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new AnalysisError('analysis_wav_invalid');
  }
  let offset = 12, fmt = null, data = null;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new AnalysisError('analysis_wav_invalid');
    const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size, next = end + (size % 2);
    if (end > bytes.length || next > bytes.length) throw new AnalysisError('analysis_wav_invalid');
    if (name === 'fmt ') {
      if (fmt || size !== 16) throw new AnalysisError('analysis_wav_invalid');
      fmt = bytes.subarray(start, end);
    } else if (name === 'data') {
      if (data) throw new AnalysisError('analysis_wav_invalid');
      data = bytes.subarray(start, end);
    }
    offset = next;
  }
  if (!fmt || !data || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1
    || fmt.readUInt32LE(4) !== 16000 || fmt.readUInt32LE(8) !== 32000
    || fmt.readUInt16LE(12) !== 2 || fmt.readUInt16LE(14) !== 16 || data.length % 2) {
    throw new AnalysisError('analysis_wav_format_unsupported');
  }
  const frames = data.length / 2, seconds = frames / 16000;
  if (seconds < minSeconds || seconds > maxSeconds) throw new AnalysisError('analysis_wav_duration_unsupported');
  return { bytes, sha256: sha256(bytes), frames, seconds, sampleRateHz: 16000, channels: 1, bitsPerSample: 16 };
}

export async function resolveLogAudio(host, audioHandle) {
  if (typeof audioHandle !== 'string' || !AUDIO_HANDLE.test(audioHandle)) throw new AnalysisError('analysis_log_wav_handle_required');
  let blob;
  try { blob = await host?.blob?.(audioHandle); } catch { /* no paths or host errors in model output */ }
  if (!blob || (blob.mime && !['audio/wav', 'audio/x-wav', 'audio/wave'].includes(blob.mime))) {
    throw new AnalysisError('analysis_audio_handle_unavailable');
  }
  return { audioHandle, ...parseAnalysisWav(blob.bytes) };
}

export function sidecarURL(baseURL, port) {
  let url;
  try { url = new URL(baseURL); } catch { throw new AnalysisError('analysis_loopback_url_required'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(port)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new AnalysisError('analysis_loopback_url_required');
  }
  return url;
}

async function privateOpen(path, flags = constants.O_RDONLY) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('private_file_required');
  const file = await open(path, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (process.platform !== 'win32'
      && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()))) throw new Error('private_file_required');
    return file;
  } catch (error) { await file.close(); throw error; }
}

export async function readSidecarToken(tokenFile) {
  if (typeof tokenFile !== 'string' || !isAbsolute(tokenFile)) throw new AnalysisError('analysis_private_token_file_required');
  let file;
  try {
    file = await privateOpen(tokenFile);
    if ((await file.stat()).size > 128) throw new Error('invalid');
    const token = (await file.readFile('utf8')).trim();
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('invalid');
    return token;
  } catch { throw new AnalysisError('analysis_private_token_unavailable'); }
  finally { await file?.close(); }
}

// node:http with a private direct Agent bypasses fetch/global proxy dispatchers.
// Only the caller's already validated loopback URL is accepted. No redirects.
export function directLoopbackFetch(url, options) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method ?? 'GET', headers: options.headers,
      signal: options.signal, agent: false }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { res.destroy(new Error('analysis_response_too_large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(new Response([204, 205, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), {
          status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers)
            .filter(([, v]) => typeof v === 'string')),
        })); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (options.body) req.end(options.body); else req.end();
  });
}

export async function syncAnalysisDirectory(directory) {
  if (process.platform !== 'win32') {
    const file = await open(directory, constants.O_RDONLY);
    try { await file.sync(); } finally { await file.close(); }
  }
}

export class AnalysisJournal {
  constructor(directory, kind, { syncDirectory = syncAnalysisDirectory } = {}) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) throw new AnalysisError('analysis_private_journal_required');
    this.directory = directory; this.kind = kind; this.syncDirectory = syncDirectory;
  }
  path(id) {
    if (!UUID.test(id)) throw new AnalysisError('analysis_request_id_invalid');
    return join(this.directory, `${this.kind}-${id}.json`);
  }
  async read(id) {
    let file;
    try { file = await privateOpen(this.path(id)); return JSON.parse(await file.readFile('utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new AnalysisError('analysis_journal_unavailable'); }
    finally { await file?.close(); }
  }
  async reserve({ requestId, audioHandle, sha256: hash, options }) {
    // Require an existing parent: only this private journal directory is created.
    // Sync its parent as well so a first-run directory entry survives a crash.
    try { await mkdir(this.directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw new AnalysisError('analysis_journal_unavailable'); }
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32'
      && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw new AnalysisError('analysis_private_journal_required');
    let lock;
    const lockPath = join(this.directory, '.reservation.lock');
    try {
      lock = await open(lockPath, 'wx', 0o600);
      const prior = await this.read(requestId);
      if (prior) {
        if (prior.audioSha256 !== hash || JSON.stringify(prior.options) !== JSON.stringify(options)) {
          throw new AnalysisError('analysis_request_id_conflict');
        }
        return { prior, reserved: false };
      }
      const names = (await readdir(this.directory)).filter(n => n.startsWith(`${this.kind}-`) && n.endsWith('.json'));
      if (names.length >= 1024) throw new AnalysisError('analysis_journal_capacity_reached');
      for (const name of names) {
        const id = name.slice(this.kind.length + 1, -5);
        const record = await this.read(id);
        if (record.audioSha256 === hash && !['complete', 'partial', 'failed', 'rejected'].includes(record.state)) {
          throw new AnalysisError('analysis_unsettled_audio_use_original_request_id', { requestId: id });
        }
      }
      const record = { schemaVersion: 1, kind: this.kind, requestId, audioHandle, audioSha256: hash,
        options, state: 'outcome_unknown', recordedAt: new Date().toISOString(), retryAutomatically: false };
      const file = await open(this.path(requestId), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
      await this.syncDirectory(this.directory);
      await syncAnalysisDirectory(dirname(this.directory));
      return { prior: record, reserved: true };
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      throw new AnalysisError('analysis_journal_unavailable');
    } finally { if (lock) { await lock.close(); await unlink(lockPath); } }
  }
  async settle(id, state) {
    const record = await this.read(id);
    if (!record) return;
    const temporary = `${this.path(id)}.tmp-${process.pid}`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ ...record, state })); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, this.path(id));
    await this.syncDirectory(this.directory);
  }
}
