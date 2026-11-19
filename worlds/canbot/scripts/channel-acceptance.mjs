#!/usr/bin/env node
// Explicit real-device check. This does not load Cortico, a Persona, providers or memory.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { HeadChannel } from '../src/head-channel.mjs';

const [configPath, evidencePath] = process.argv.slice(2);
if (!configPath || !evidencePath) throw new Error('usage: node channel-acceptance.mjs PRIVATE_CONFIG EVIDENCE_DIRECTORY');
if (process.platform !== 'win32' && (statSync(configPath).mode & 0o077)) throw new Error('private_config_mode_600_required');
const config = JSON.parse(readFileSync(configPath, 'utf8')), evidence = resolve(evidencePath);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
let firstTouch = null, stopping = false;
const channel = new HeadChannel({ ...config, avatarToken: () => config.avatarToken, mediaToken: () => config.mediaToken,
  emit: async (type, meta) => {
    const observation = { observedAt: new Date().toISOString(), type, ...meta };
    appendFileSync(join(evidence, 'sensor-events.jsonl'), JSON.stringify(observation) + '\n', { mode: 0o600 });
    if (type === 'canbot.touch') { firstTouch ??= observation; console.log(JSON.stringify({ stage: 'real_touch_received', position: meta.position })); }
  },
});
const receipt = { schemaVersion: 1, startedAt: new Date().toISOString(), mode: 'real-device-channel-check',
  corticoStarted: false, personaOrMemoryMigrated: false, physicalCommandsSubmitted: 0, media: [], performance: [] };
const samples = new Set();
process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
let sampling;
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
try {
  const address = await channel.start(); save('listener.json', { pid: process.pid, address, startedAt: receipt.startedAt });
  console.log(JSON.stringify({ stage: 'listening', pid: process.pid, address }));
  sampling = setInterval(() => {
    const status = channel.status(); save('latest-uplink.json', status);
    if (channel.latest && !samples.has(channel.latest.eventId)) {
      samples.add(channel.latest.eventId); const avatar = channel.latest.avatar;
      receipt.performance.push({ receivedAt: status.lastReceivedAt, sampleSequence: channel.latest.sampleSequence,
        framesReturned: avatar.framesReturned, fps: avatar.fps, p95FrameIntervalMs: avatar.p95FrameIntervalMs, renderCpuMs: avatar.renderCpuMs, native: avatar.native });
    }
  }, 1000);
  const connectionDeadline = Date.now() + 55000;
  while (!channel.status().observationFresh && !stopping && Date.now() < connectionDeadline) await wait(500);
  if (!channel.status().observationFresh) throw new Error('no_authenticated_device_upload_before_deadline');
  receipt.uplink = { accepted: true, instanceId: channel.receiverInstance, sampleSequence: channel.highSequence };
  console.log(JSON.stringify({ stage: 'authenticated_upload_received', sampleSequence: channel.highSequence }));
  const id = randomUUID(); receipt.avatarAccepted = await channel.avatar({ requestId: id, expression: 'happy', motion: 'idle', gazeX: -.65, gazeY: .2, mouthOpen: .8, durationMs: 12000 });
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await channel.request('avatar', `/v1/operations/${id}`);
    if (result.drawReturned) { receipt.avatarDrawReceipt = result; break; }
    await wait(100);
  }
  if (!receipt.avatarDrawReceipt?.drawReturned) throw new Error('accepted_visual_state_did_not_reach_a_successful_draw');
  for (const kind of ['photo', 'video', 'microphone', 'tone']) {
    if (stopping) break;
    const { blobs, ...result } = await channel.capture(kind);
    for (const blob of blobs) writeFileSync(join(evidence, blob.name), blob.bytes, { mode: 0o600 });
    receipt.media.push({ kind, ...result, files: blobs.map(blob => ({ name: blob.name, mime: blob.mime, bytes: blob.bytes.length, sha256: createHash('sha256').update(blob.bytes).digest('hex') })) });
    console.log(JSON.stringify({ stage: 'media_saved_on_5810', kind, bytes: blobs.reduce((total, blob) => total + blob.bytes.length, 0) }));
  }
  receipt.avatarAfterMedia = await channel.request('avatar', '/v1/status');
  const second = await channel.avatar({ expression: 'love', motion: 'keep', gazeX: .4, gazeY: 0, mouthOpen: -1, durationMs: 30000 });
  receipt.secondVisualCommand = second; save('runtime-progress.json', receipt);
  console.log(JSON.stringify({ stage: 'ready_for_touch', holdSeconds: 180 }));
  const observationDeadline = Date.now() + 180000;
  while ((!firstTouch || samples.size < 15) && !stopping && Date.now() < observationDeadline) await wait(500);
  receipt.touch = firstTouch; receipt.latestUplink = channel.status();
  receipt.finishedAt = new Date().toISOString(); receipt.transportAccepted = Boolean(receipt.uplink.accepted && receipt.avatarDrawReceipt.drawReturned && receipt.media.length === 4);
  save('runtime-acceptance.json', receipt);
  console.log(JSON.stringify({ stage: 'completed', transportAccepted: receipt.transportAccepted, touchReceived: Boolean(firstTouch), performanceSamples: receipt.performance.length }));
} catch (error) {
  receipt.error = error.message; receipt.finishedAt = new Date().toISOString(); save('runtime-failure.json', receipt);
  console.log(JSON.stringify({ stage: 'failed', code: error.message })); process.exitCode = 1;
} finally {
  if (sampling) clearInterval(sampling);
  try { await channel.avatar({ expression: 'neutral', motion: 'idle', gazeX: 0, gazeY: 0, mouthOpen: -1, durationMs: 0 }); } catch { /* No POST retry. */ }
  await channel.stop();
}
