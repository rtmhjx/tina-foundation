#!/usr/bin/env node
// Self-mem's sink adapter for the existing native agent intake. Discovery,
// cursors, replay, raw bytes and DSH decoding belong to agent-intake.mjs.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { collectAgentSources, createIntakeState, normalizeNativeRecord } from '../vendor/intake/src/agent-intake.mjs';
import { TinaSelfMem } from './core.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isoTime = value => {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** Compatibility helper only. All native shape handling lives in the shared normalizer. */
export function parseTranscriptLine(line, { format, lineNumber = 1 } = {}) {
  if (!line?.trim()) return null;
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  format ??= record.type === 'response_item' || record.type === 'session_meta' ? 'codex'
    : record.event || ['user/message', 'assistant/message'].includes(record.type) ? 'dsh' : 'messages';
  const parsed = normalizeNativeRecord(record, {
    format, line: lineNumber, includeReasoning: true,
    originalLineBase64: Buffer.from(line, 'utf8').toString('base64'),
  });
  if (!['user', 'assistant'].includes(parsed.role) || (!parsed.text && !parsed.reasoning)) return null;
  return { role: parsed.role, content: parsed.text, reasoning: parsed.reasoning ?? null,
    createdAt: isoTime(parsed.createdAt), itemId: parsed.id, original: parsed };
}

/** Producer identity survives copied paths; receipt is issued only after L0 ingestion. */
export function createSelfMemIntakeSink({ mem, onInserted = () => {} }) {
  return { async ingestConversation(batch) {
    const receipt = { sourceIds: [], added: 0, jobIds: [] };
    for (const message of batch.messages) {
      const sourceId = `native:${hash([batch.sourceSystem, batch.deviceId, batch.conversationId, batch.epoch ?? '1', message.id])}`;
      const dialogue = ['user', 'assistant'].includes(message.role) && Boolean(message.text || message.reasoning);
      const result = await mem.ingestSource({
        sourceId, agentId: `${batch.sourceSystem}-${hash(batch.deviceId).slice(0, 12)}`,
        deviceId: batch.deviceId, sourceSystem: batch.sourceSystem,
        channel: batch.sourceSystem, sessionId: batch.conversationId, role: message.role,
        kind: dialogue ? 'conversation' : 'native_trace',
        content: message.text ?? '', reasoning: message.reasoning ?? null,
        createdAt: isoTime(message.createdAt ?? message.timestamp),
        original: message,
        meta: { nativeMessageId: message.id, sourceSystem: batch.sourceSystem, epoch: batch.epoch ?? '1',
          authority: message.authority ?? 'native_event_record' },
      });
      receipt.sourceIds.push(result.sourceId ?? sourceId);
      if (result.inserted) { receipt.added++; onInserted({ dialogue, sourceId }); }
    }
    return receipt;
  } };
}

/** One incremental pass; callers may schedule further passes. No background process is installed. */
export async function collectSessionLogs({
  mem, sessionsRoot = join(homedir(), '.codex', 'sessions'), agentId = 'codex', channel = 'codex-cli',
  originDeviceId = agentId, format = agentId.toLowerCase().includes('dsh') ? 'dsh'
    : agentId.toLowerCase().includes('codex') ? 'codex'
    : agentId.toLowerCase().includes('opencode') ? 'opencode' : 'generic',
  conversationId, allowMissingHeader = true, maxFiles = 50,
  maxRecords = 1000, maxRecordsPerFile = 200, maxDurationMs = 45_000,
  batchSize = 50, maxBatchChars = 200_000, dshCodecModule,
} = {}) {
  await mem.ensureReady(agentId);
  const root = resolve(sessionsRoot);
  if (!existsSync(root)) return { filesScanned: 0, messagesIngested: 0, sourcesIngested: 0, errors: [] };
  // Local source location scopes only its cursor. Native record IDs deliberately exclude it.
  const id = `selfmem:${hash([agentId, channel, originDeviceId, format, root, conversationId ?? null])}`;
  const state = createIntakeState(join(mem.deviceDir ?? mem.dataDir, 'session-intake.sqlite'));
  let messagesIngested = 0;
  try {
    const sink = createSelfMemIntakeSink({ mem,
      onInserted({ dialogue }) { if (dialogue) messagesIngested++; } });
    const report = await collectAgentSources({
      sources: [{ id, kind: format, root, originDeviceId, conversationId, allowMissingHeader, includeReasoning: true }],
      sink, state, cacheDir: join(mem.deviceDir ?? mem.dataDir, 'session-intake-cache'),
      maxFiles, maxRecords, maxRecordsPerFile, maxDurationMs, batchSize, maxBatchChars, dshCodecModule,
    });
    return { ...report, filesScanned: report.sources.filter(source => source.readLines > 0).length,
      messagesIngested, sourcesIngested: report.added };
  } finally { state.close(); }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const dataDir = option('--dir') ?? process.env.TINA_SELF_MEM_DIR ?? join(homedir(), '.tina-self-mem');
  const agentId = option('--agent') ?? 'codex';
  const mem = new TinaSelfMem({ dataDir: resolve(dataDir), defaultBotId: agentId });
  try {
    const result = await collectSessionLogs({ mem, sessionsRoot: option('--sessions'), agentId,
      channel: `${agentId}-session`, originDeviceId: option('--origin-device') ?? agentId,
      ...(option('--format') ? { format: option('--format') } : {}) });
    console.log('[tina-self-mem collector]', JSON.stringify(result));
    if (result.errors.length) process.exitCode = 1;
  } finally { await mem.close(); }
}
