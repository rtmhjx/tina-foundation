#!/usr/bin/env node
// Bounded robot-only display check. Reads an existing event archive without opening a Core store.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { HeadChannel } from '../src/head-channel.mjs';
import { EventTimeline } from '../src/timeline.mjs';

const [configPath, archivePath, evidencePath, secondsArg = '600'] = process.argv.slice(2);
if (!evidencePath) throw new Error('Usage: stage-acceptance.mjs PRIVATE_CONFIG SOURCE_EVENTS_JSONL EVIDENCE_DIR [SECONDS]');
const seconds = Number(secondsArg);
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 1800) throw new Error('duration_out_of_range');
if (process.platform !== 'win32' && (statSync(configPath).mode & 0o077)) throw new Error('private_config_mode_600_required');
const config = JSON.parse(readFileSync(configPath, 'utf8')), evidence = resolve(evidencePath);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const archive = resolve(archivePath);
if (statSync(archive).size > 100 * 1024 * 1024) throw new Error('archive_too_large_for_scratch_view');
let records = [], byCursor = new Map(), stamp = '';
const refresh = () => {
  const info = statSync(archive), current = `${info.size}:${info.mtimeMs}`;
  if (stamp === current) return;
  const text = readFileSync(archive, 'utf8');
  // A writer may be in the middle of its final line. Only consume complete records.
  records = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (records.some(x => !Number.isSafeInteger(x.cursor) || typeof x.text !== 'string'
      || typeof x.source !== 'string' || typeof x.type !== 'string' || typeof x.ts !== 'string')) throw new Error('invalid_source_archive');
  records.sort((a, b) => a.cursor - b.cursor); byCursor = new Map(records.map(x => [x.cursor, x])); stamp = current;
};
const store = {
  get(cursor) { refresh(); return byCursor.get(cursor); },
  latestCursor() { refresh(); return records.at(-1)?.cursor ?? 0; },
  range({ limit }) { refresh(); return records.slice(-limit); },
};
const head = new HeadChannel({ ...config, avatarToken: () => config.avatarToken, mediaToken: () => config.mediaToken });
const timeline = new EventTimeline(head, { historyEvents: 40, pollIntervalMs: 250 });
let stopping = false;
process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), pid: process.pid,
  sourceArchive: archive, sourceReader: 'readonly-jsonl-view', formalWorldMounted: false,
  corticoStarted: false, mainDeploymentChanged: false, modelRequests: 0, physicalCommands: 0, samples: [] };
try {
  report.address = await head.start();
  timeline.start({ store });
  save('listener.json', { pid: process.pid, address: report.address, startedAt: report.startedAt });
  console.log(JSON.stringify({ stage: 'listening', pid: process.pid, address: report.address, realSourceRecords: records.length }));
  const deadline = Date.now() + seconds * 1000;
  while (!stopping && Date.now() < deadline && !existsSync(join(evidence, 'stop'))) {
    const status = await head.request('avatar', '/v1/status');
    report.samples.push({ at: new Date().toISOString(), fps: status.fps, p95FrameIntervalMs: status.p95FrameIntervalMs,
      renderCpuMs: status.renderCpuMs, framesReturned: status.framesReturned, native: status.native,
      rendererError: status.rendererError, visible: status.visible, timeline: status.timeline, uplink: status.uplink });
    report.timeline = timeline.status(); report.uplink = head.status();
    save('progress.json', report);
    if (report.samples.length % 5 === 0) console.log(JSON.stringify({ stage: 'sample', count: report.samples.length,
      fps: status.fps, chunks: status.timeline?.retainedChunks, cursor: report.timeline.sourceCursor,
      latest: report.timeline.sourceLatestCursor, error: report.timeline.lastError }));
    await new Promise(done => setTimeout(done, 2000));
  }
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  await timeline.stop(); await head.stop();
  report.finishedAt = new Date().toISOString(); report.timeline = timeline.status();
  save('acceptance.json', report);
  console.log(JSON.stringify({ stage: 'finished', samples: report.samples.length, error: report.error ?? null }));
}
