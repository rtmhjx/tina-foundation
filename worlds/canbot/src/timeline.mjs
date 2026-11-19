import { randomUUID } from 'node:crypto';

export function splitOriginal(text, maximum = 1800) {
  const chunks = [];
  for (let from = 0; from < text.length;) {
    let end = Math.min(text.length, from + maximum);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    chunks.push(text.slice(from, end)); from = end;
  }
  return chunks.length ? chunks : [''];
}

/** A display sink. Reads source records and never pushes an event back to Core. */
export class EventTimeline {
  constructor(head, { historyEvents = 40, pollIntervalMs = 750 } = {}) {
    if (!Number.isInteger(historyEvents) || historyEvents < 0 || historyEvents > 200
      || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 5000) throw new Error('timeline_configuration_invalid');
    Object.assign(this, { head, historyEvents, pollIntervalMs });
    this.host = null; this.timer = null; this.running = null; this.abort = null;
    this.streamId = randomUUID(); this.instanceId = null; this.sequence = 0;
    this.sourceCursor = 0; this.bootCursor = 0; this.pending = null; this.wire = null;
    this.outputs = []; this.outputIds = new Set(); this.outputTurn = false; this.droppedOutputs = 0; this.sourceGaps = 0;
    this.lastError = null; this.lastAcceptedAt = null;
  }
  start(host) {
    if (!host.store?.get || !host.store?.latestCursor || !host.store?.range) throw new Error('timeline_event_reader_required');
    this.host = host; this.abort = new AbortController(); this.resetReader(); this.schedule(0);
  }
  resetReader() {
    this.bootCursor = this.host.store.latestCursor();
    const tail = this.historyEvents ? this.host.store.range({ limit: this.historyEvents }) : [];
    this.sourceCursor = tail.length ? tail[0].cursor - 1 : this.bootCursor;
    this.pending = null; this.wire = null; this.sequence = 0;
  }
  schedule(delay = this.pollIntervalMs) {
    if (!this.host) return;
    this.timer = setTimeout(() => { this.running = this.poll().finally(() => { this.running = null; this.schedule(); }); }, delay);
    this.timer.unref?.();
  }
  async stop() {
    this.host = null; clearTimeout(this.timer); this.timer = null; this.abort?.abort();
    await this.running; this.pending = null; this.wire = null;
  }
  output(event) {
    const item = event?.type === 'response.output_item.done' ? event.item : null;
    if (!this.host || item?.type !== 'message' || item.role !== 'assistant' || !item.id || this.outputIds.has(item.id)) return;
    const text = (item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
    if (!text) return;
    this.outputIds.add(item.id); while (this.outputIds.size > 128) this.outputIds.delete(this.outputIds.values().next().value);
    this.outputs.push({ id: `assistant:${item.id}`, source: 'assistant', type: 'assistant.output',
      ts: new Date().toISOString(), text, mode: 'live', cursor: null });
    while (this.outputs.length > 64) { this.outputs.shift(); this.droppedOutputs++; }
  }
  nextRecord() {
    const latest = this.host.store.latestCursor();
    if (latest < this.sourceCursor) { this.resetReader(); this.streamId = randomUUID(); }
    if (this.outputs.length && (this.outputTurn || this.sourceCursor >= latest)) {
      this.outputTurn = false; return this.outputs.shift();
    }
    for (let scanned = 0; scanned < 128 && this.sourceCursor < latest; scanned++) {
      const event = this.host.store.get(this.sourceCursor + 1);
      if (!event) { this.sourceCursor++; this.sourceGaps++; continue; }
      return { id: `core:${event.run ?? 'archive'}:${event.cursor}`, source: event.source,
        type: event.type, ts: event.ts, text: event.text, cursor: event.cursor,
        mode: event.cursor <= this.bootCursor ? 'replay' : 'live' };
    }
    return null;
  }
  async poll() {
    if (!this.host || this.abort.signal.aborted) return;
    try {
      const status = await this.head.request('avatar', '/v1/status', { signal: this.abort.signal });
      if (status.timeline?.schemaVersion !== 'canbot.timeline.v1') throw new Error('receiver_timeline_not_supported');
      if (status.instanceId !== this.instanceId) { this.instanceId = status.instanceId; this.resetReader(); }
      if (!this.pending) {
        const event = this.nextRecord(); if (!event) { this.lastError = null; return; }
        const text = splitOriginal(event.text); this.pending = { event, chunks: text, offset: 0 };
      }
      const pending = this.pending;
      if (!this.wire) this.wire = {
        schemaVersion: 'canbot.timeline.v1', instanceId: this.instanceId, streamId: this.streamId,
        sequence: this.sequence + 1, mode: pending.event.mode,
        entries: pending.chunks.slice(pending.offset, pending.offset + 16).map((text, index) => ({
          id: pending.event.id, source: pending.event.source, type: pending.event.type, ts: pending.event.ts,
          text, part: pending.offset + index, parts: pending.chunks.length,
        })),
      };
      const reply = await this.head.request('avatar', '/v1/timeline', { method: 'POST', body: this.wire, signal: this.abort.signal });
      if (reply.accepted !== true || reply.instanceId !== this.instanceId || reply.streamId !== this.streamId
        || reply.sequence !== this.wire.sequence) throw new Error('timeline_receipt_mismatch');
      this.sequence = this.wire.sequence; pending.offset += this.wire.entries.length; this.wire = null;
      if (pending.offset === pending.chunks.length) {
        if (pending.event.cursor !== null) { this.sourceCursor = pending.event.cursor; this.outputTurn = true; }
        this.pending = null;
      }
      this.lastError = null; this.lastAcceptedAt = new Date().toISOString();
    } catch (error) { this.lastError = error.message; }
  }
  status() {
    return { enabled: true, sourceCursor: this.sourceCursor, sourceLatestCursor: this.host?.store.latestCursor() ?? null,
      streamId: this.streamId, receiverInstanceId: this.instanceId, lastAcceptedSequence: this.sequence,
      pendingChunks: this.pending ? this.pending.chunks.length - this.pending.offset : 0,
      queuedOutputs: this.outputs.length, droppedOutputs: this.droppedOutputs, sourceGaps: this.sourceGaps,
      lastAcceptedAt: this.lastAcceptedAt, lastError: this.lastError, modelInputsFromDisplay: 0, physicalCommandsFromDisplay: 0 };
  }
}
