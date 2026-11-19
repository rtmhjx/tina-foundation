// Independent stream consumer core; actual Android HTTP schema is not wired yet.
// Ack is an injected port and is called only after chunk and manifest fsync.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Segmenter, SEGMENT_DEFAULTS, rmsDb } from './upstream/package/src/segmenter.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

async function durableFile(path, data) {
  const handle = await open(path + '.tmp', 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await rename(path + '.tmp', path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export function pcmOf(wav, expectedRate) {
  const bytes = Buffer.from(wav);
  if (bytes.length < 46 || bytes.length > 192044 || bytes.toString('ascii', 0, 4) !== 'RIFF'
      || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw Error('wav_invalid');
  let at = 12, pcm, fmt;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw Error('wav_invalid');
    const name = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), start = at + 8, end = start + size;
    if (end + (size & 1) > bytes.length) throw Error('wav_invalid');
    if (name === 'data') { if (pcm) throw Error('wav_invalid'); pcm = bytes.subarray(start, end); }
    if (name === 'fmt ') { if (fmt || size !== 16) throw Error('wav_invalid'); fmt = bytes.subarray(start, end); }
    at = end + (size & 1);
  }
  if (!fmt || !pcm || pcm.length % 2 || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1
      || fmt.readUInt32LE(4) !== expectedRate || fmt.readUInt32LE(8) !== expectedRate * 2
      || fmt.readUInt16LE(12) !== 2 || fmt.readUInt16LE(14) !== 16 || pcm.length / 2 > expectedRate * 3) throw Error('wav_format_invalid');
  return { bytes, frames: pcm.length / 2, pcm };
}

export class StreamSpool {
  constructor({ folder, streamId, mode, sampleRate, silenceMs = 1500, maxBytes = 512 * 1024 * 1024, ack }) {
    if (!UUID.test(streamId) || !['continuous', 'silence_stop', 'press_stop'].includes(mode)
      || ![8000, 16000].includes(sampleRate) || !Number.isInteger(silenceMs) || silenceMs < 100 || silenceMs > 30000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 200000 || typeof ack !== 'function') throw Error('stream_configuration_invalid');
    this.folder = folder; this.streamId = streamId; this.mode = mode; this.sampleRate = sampleRate; this.silenceMs = silenceMs; this.maxBytes = maxBytes; this.ack = ack;
    this.chunks = []; this.firstSequence = 1; this.nextFrame = 0; this.bytes = 0; this.gap = false; this.deviceFault = null; this.finished = false; this.ackedThrough = 0; this.finalState = null; this.hasSpeech = false; this.silentFrames = 0;
    this.segmenter = new Segmenter({ ...SEGMENT_DEFAULTS }, 20); this.remainder = Buffer.alloc(0);
  }

  async init() {
    // New independent session only. A pre-existing manifest must be explicitly
    // recovered in a future implementation, never overwritten as a fresh stream.
    await mkdir(this.folder, { mode: 0o700, recursive: true });
    try { await readFile(join(this.folder, 'manifest.json')); throw Error('stream_manifest_already_exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await durableFile(join(this.folder, 'manifest.json'), Buffer.from(JSON.stringify(this.manifest())));
  }

  manifest() { return { version: 1, streamId: this.streamId, mode: this.mode, sampleRate: this.sampleRate, firstSequence: this.firstSequence, chunks: this.chunks,
    frames: this.nextFrame, bytes: this.bytes, gap: this.gap, deviceFault: this.deviceFault,
    ackedThrough: this.ackedThrough, finished: this.finished, finalState: this.finalState }; }

  async recordDeviceFault(status) {
    this.deviceFault = { operationId: status.operationId, instanceId: status.instanceId, gap: status.gap ?? null,
      state: status.state ?? 'unknown', tailState: status.tailState ?? 'unknown', settled: status.settled === true };
    await durableFile(join(this.folder, 'manifest.json'), Buffer.from(JSON.stringify(this.manifest())));
  }

  async ackCommitted(sequence) {
    await this.ack(sequence);
    if (sequence > this.ackedThrough) {
      this.ackedThrough = sequence;
      await durableFile(join(this.folder, 'manifest.json'), Buffer.from(JSON.stringify(this.manifest())));
    }
  }

  async ingest({ sequence, startFrame, frameCount, sha256, wav }) {
    if (this.finished || this.gap) throw Error('stream_closed');
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(frameCount)
      || !/^[0-9a-f]{64}$/.test(sha256 ?? '') || !(wav instanceof Uint8Array)) throw Error('chunk_invalid');
    const parsed = pcmOf(wav, this.sampleRate), actual = digest(parsed.bytes);
    if (actual !== sha256 || parsed.frames !== frameCount) throw Error('chunk_hash_or_length_mismatch');
    if (sequence < this.firstSequence) throw Error('chunk_already_retired');
    const prior = this.chunks[sequence - this.firstSequence];
    if (prior) {
      if (prior.startFrame !== startFrame || prior.frameCount !== frameCount || prior.sha256 !== sha256) throw Error('chunk_conflict');
      await this.ackCommitted(sequence); return { duplicate: true, shouldStop: false };
    }
    if (sequence !== this.firstSequence + this.chunks.length || startFrame !== this.nextFrame) {
      this.gap = true; await durableFile(join(this.folder, 'manifest.json'), Buffer.from(JSON.stringify(this.manifest()))); throw Error('stream_gap');
    }
    if (this.bytes + parsed.bytes.length > this.maxBytes) throw Error('spool_capacity_exceeded');
    const name = `chunk-${String(sequence).padStart(10, '0')}.wav`;
    await durableFile(join(this.folder, name), parsed.bytes);
    const item = { sequence, startFrame, frameCount, sha256, file: name, bytes: parsed.bytes.length };
    this.chunks.push(item); this.nextFrame += frameCount; this.bytes += parsed.bytes.length;
    await durableFile(join(this.folder, 'manifest.json'), Buffer.from(JSON.stringify(this.manifest())));
    // The same ACK can be retried if its response is lost; no new POST capture.
    await this.ackCommitted(sequence);
    let shouldStop = false;
    if (this.mode === 'silence_stop') {
      let converted = parsed.pcm;
      if (this.sampleRate === 8000) {
        converted = Buffer.alloc(parsed.pcm.length * 2);
        for (let i = 0; i < parsed.pcm.length / 2; i++) {
          const sample = parsed.pcm.readInt16LE(i * 2);
          converted.writeInt16LE(sample, i * 4); converted.writeInt16LE(sample, i * 4 + 2);
        }
      }
      const data = Buffer.concat([this.remainder, converted]); let offset = 0;
      while (offset + 640 <= data.length) {
        const pcm = new Int16Array(320);
        for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(offset + i * 2);
        const segments = this.segmenter.push(pcm);
        if (this.segmenter.active || segments.length) this.hasSpeech = true;
        if (this.hasSpeech && rmsDb(pcm) >= SEGMENT_DEFAULTS.thresholdDb) this.silentFrames = 0;
        else if (this.hasSpeech) this.silentFrames += pcm.length;
        if (this.hasSpeech && this.silentFrames * 1000 / 16000 >= this.silenceMs) shouldStop = true;
        offset += 640;
      }
      this.remainder = data.subarray(offset);
    }
    return { duplicate: false, shouldStop };
  }

  async pruneThrough(frame) {
    if (this.mode !== 'continuous' || !Number.isSafeInteger(frame) || frame < 0) throw Error('prune_invalid');
    let count = 0;
    while (count < this.chunks.length) {
      const c = this.chunks[count];
      if (c.startFrame + c.frameCount > frame || c.sequence > this.ackedThrough) break;
      count++;
    }
    if (!count) return 0;
    const retired = this.chunks.slice(0, count);
    this.chunks = this.chunks.slice(count); this.firstSequence += count;
    this.bytes -= retired.reduce((sum, c) => sum + c.bytes, 0);
    // Persist the processed boundary before removing only confirmed data.
    // A crash can leave harmless private orphan files; never the reverse.
    await durableFile(join(this.folder, 'manifest.json'), Buffer.from(JSON.stringify(this.manifest())));
    for (const c of retired) { try { await unlink(join(this.folder, c.file)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return count;
  }

  async finish({ settled, finalSequence, finalEmpty, tailState }) {
    if (this.gap || settled !== true || !['flushed', 'empty', 'flushed_read_unknown', 'empty_read_unknown'].includes(tailState) || !Number.isSafeInteger(finalSequence)
      || finalSequence !== this.firstSequence + this.chunks.length - 1 || this.ackedThrough < finalSequence || typeof finalEmpty !== 'boolean') throw Error('stream_not_safely_finalized');
    this.finished = true;
    this.finalState = { settled, finalSequence, finalEmpty, tailState };
    await durableFile(join(this.folder, 'manifest.json'), Buffer.from(JSON.stringify(this.manifest())));
    return { streamId: this.streamId, files: this.chunks.map(c => join(this.folder, c.file)), frames: this.nextFrame,
      gap: false, deviceSettled: true, finalEmpty, tailBoundaryVerified: ['flushed', 'empty'].includes(tailState), hardwareContinuityVerified: false };
  }
}
