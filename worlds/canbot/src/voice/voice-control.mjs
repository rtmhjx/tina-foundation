// Candidate shared controller and native-device HTTP API. No server starts on import.
import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// A rejection that an adapter proves happened before any external effect.
export class BeforeEffectRejection extends Error {
  constructor(code) {
    if (code !== 'exclusive_media_busy') throw Error('invalid_rejection_code');
    super(code); this.name = 'BeforeEffectRejection'; this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const initialConfig = { mode: 'silence_stop', silenceMs: 1500, batch: { strategy: 'duration_ms', threshold: 3000 } };
function finalizationComplete(runtime) {
  if (runtime.state === 'idle' && !runtime.sessionId) return true;
  const c = runtime.capture;
  return ['stopped', 'failed'].includes(runtime.state) && runtime.deviceStopConfirmed === true && c?.settled === true
    && ['flushed', 'empty', 'flushed_read_unknown', 'empty_read_unknown'].includes(c.tailState) && (c.finalProduced === true || c.finalEmpty === true)
    && Number.isSafeInteger(c.finalSequence) && Number.isSafeInteger(c.persistedThroughSequence)
    && Number.isSafeInteger(c.ackThroughSequence) && c.persistedThroughSequence >= c.finalSequence
    && c.ackThroughSequence >= c.finalSequence && c.gap === false;
}
function validConfig(c) {
  return c && Object.keys(c).sort().join() === 'batch,mode,silenceMs'
    && ['continuous', 'silence_stop', 'press_stop'].includes(c.mode)
    && Number.isInteger(c.silenceMs) && c.silenceMs >= 100 && c.silenceMs <= 30000
    && c.batch && Object.keys(c.batch).sort().join() === 'strategy,threshold'
    && ['characters', 'duration_ms'].includes(c.batch.strategy) && Number.isInteger(c.batch.threshold)
    && (c.batch.strategy === 'characters' ? c.batch.threshold >= 1 && c.batch.threshold <= 10000
      : c.batch.threshold >= 3000 && c.batch.threshold <= 60000);
}
async function save(path, state) {
  const temp = `${path}.${randomUUID()}.tmp`, file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
  const folder = await open(dirname(path), 'r'); try { await folder.sync(); } finally { await folder.close(); }
}
const clone = v => JSON.parse(JSON.stringify(v));

export class VoiceController {
  static async create({ engine, journalDir, limits = {} }) {
    if (!engine || !['status', 'start', 'requestStop'].every(k => typeof engine[k] === 'function') || !journalDir) throw Error('controller_ports_required');
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    const path = join(journalDir, 'voice-control.json'); let state;
    try { state = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { version: 1, config: clone(initialConfig), configRevision: 1, desiredEnabled: false, startPending: false, currentReceiver: null,
        sequence: 0, retiredReceivers: [], receipts: {} };
      await save(path, state);
    }
    if (state.version !== 1 || !validConfig(state.config) || !Number.isSafeInteger(state.configRevision)
      || !Number.isSafeInteger(state.sequence) || !Array.isArray(state.retiredReceivers) || !state.receipts) throw Error('controller_journal_invalid');
    state.retiredReceipts ??= {}; state.preflightRejections ??= {}; state.stopReceipt ??= null;
    if (!state.retiredReceipts || typeof state.retiredReceipts !== 'object' || Array.isArray(state.retiredReceipts)
        || !state.preflightRejections || typeof state.preflightRejections !== 'object' || Array.isArray(state.preflightRejections)
        || (state.stopReceipt !== null && typeof state.stopReceipt !== 'object')) throw Error('controller_journal_invalid');
    // A legacy mode or receipt does not establish an outstanding recording intent.
    const migrateIntent = !Object.hasOwn(state, 'desiredEnabled') || !Object.hasOwn(state, 'startPending');
    if (!Object.hasOwn(state, 'desiredEnabled')) state.desiredEnabled = false;
    if (!Object.hasOwn(state, 'startPending')) state.startPending = false;
    if (typeof state.desiredEnabled !== 'boolean' || typeof state.startPending !== 'boolean') throw Error('controller_journal_invalid');
    if (migrateIntent) await save(path, state);
    const bounds = { maxReceipts: 4096, maxRetired: 65536, maxPreflight: 1024, ...limits };
    if (!Number.isInteger(bounds.maxReceipts) || bounds.maxReceipts < 1 || bounds.maxReceipts > 4096
        || !Number.isInteger(bounds.maxRetired) || bounds.maxRetired < 1 || bounds.maxRetired > 65536
        || !Number.isInteger(bounds.maxPreflight) || bounds.maxPreflight < 1 || bounds.maxPreflight > 1024) throw Error('controller_limits_invalid');
    return new VoiceController(engine, path, state, bounds);
  }
  constructor(engine, path, state, limits) { Object.assign(this, { engine, path, state, limits }); this.queue = Promise.resolve(); }
  status() {
    const runtime = this.engine.status();
    return { config: clone(this.state.config), configRevision: this.state.configRevision, desiredEnabled: this.state.desiredEnabled,
      startPending: this.state.startPending,
      receiverInstance: this.state.currentReceiver, receiverLastSequence: this.state.sequence,
      receiptStorage: { detailed: Object.keys(this.state.receipts).length, retired: Object.keys(this.state.retiredReceipts).length,
        preflightRejected: Object.keys(this.state.preflightRejections).length, maxPreflightRejected: this.limits.maxPreflight,
        preflightNearCapacity: Object.keys(this.state.preflightRejections).length >= Math.max(1, Math.floor(this.limits.maxPreflight * 0.9)),
        preflightFull: Object.keys(this.state.preflightRejections).length >= this.limits.maxPreflight,
        emergencyStopOccupied: !!this.state.stopReceipt },
      enabled: ['running', 'paused_playback'].includes(runtime.state) ? true
        : ['idle', 'stopped', 'stopping'].includes(runtime.state) ? false : null,
      configMutable: finalizationComplete(runtime), phase: runtime.phase ?? 'unknown', microphone: runtime.microphone ?? 'unknown',
      captureMode: runtime.captureMode ?? 'unknown', sessionId: runtime.sessionId ?? null, lastError: runtime.lastError ?? null, ...runtime };
  }
  receipt(id) {
    if (!UUID.test(id)) throw Error('request_id_invalid');
    const r = this.state.receipts[id] ?? this.state.preflightRejections[id] ?? (this.state.stopReceipt?.requestId === id ? this.state.stopReceipt : null);
    if (r) return clone(r);
    return this.state.retiredReceipts[id] ? { ...clone(this.state.retiredReceipts[id]), compacted: true } : null;
  }
  compactReceipts() {
    const retired = this.state.retiredReceipts;
    const move = record => {
      if (!record || !['settled', 'rejected'].includes(record.state) || Object.keys(retired).length >= this.limits.maxRetired) return false;
      retired[record.requestId] = { requestId: record.requestId, sha256: record.sha256, state: record.state,
        ...(record.state === 'rejected' ? { code: record.code } : {}) }; return true;
    };
    if (this.state.stopReceipt && move(this.state.stopReceipt)) this.state.stopReceipt = null;
    for (const [id, record] of Object.entries(this.state.preflightRejections)) {
      if (Object.keys(this.state.preflightRejections).length < this.limits.maxPreflight) break;
      if (move(record)) delete this.state.preflightRejections[id];
    }
    for (const [id, record] of Object.entries(this.state.receipts)) {
      if (Object.keys(this.state.receipts).length < this.limits.maxReceipts) break;
      if (move(record)) delete this.state.receipts[id];
    }
  }
  pendingUnknown() {
    return this.state.startPending || Object.values(this.state.receipts).some(r => r.state === 'pending_outcome_unknown')
      || this.state.stopReceipt?.state === 'pending_outcome_unknown';
  }
  async setDesiredEnabled(desiredEnabled, startPending = this.state.startPending) {
    if (typeof desiredEnabled !== 'boolean' || typeof startPending !== 'boolean') throw Error('arguments_invalid');
    const next = { ...this.state, desiredEnabled, startPending };
    await save(this.path, next);
    this.state.desiredEnabled = desiredEnabled; this.state.startPending = startPending;
  }
  async startWithIntent() {
    const previous = this.state.desiredEnabled;
    await this.setDesiredEnabled(true, true);
    try {
      const result = await this.engine.start(clone(this.state.config));
      await this.setDesiredEnabled(true, false);
      return result;
    }
    catch (error) {
      // Only a typed, before-effect rejection permits restoring the old intent.
      // A failed rollback must remain unknown rather than becoming a rejection.
      if (error instanceof BeforeEffectRejection) {
        await this.setDesiredEnabled(previous); // keep pending until rollback is durably confirmed
        await this.setDesiredEnabled(previous, false);
      }
      throw error;
    }
  }
  async apply(action) {
    if (action.expectedConfigRevision !== this.state.configRevision && !(action.action === 'set_enabled' && action.desiredEnabled === false)) throw Error('configuration_conflict');
    const runtime = this.engine.status();
    if (action.action === 'configure') {
      if (!validConfig(action.config) || 'desiredEnabled' in action || 'expectedSessionId' in action) throw Error('arguments_invalid');
      if (!finalizationComplete(runtime)) throw Error('session_not_finalized');
      this.state.config = clone(action.config); this.state.configRevision++;
      await this.setDesiredEnabled(false);
    } else if (action.action === 'set_enabled') {
      if (typeof action.desiredEnabled !== 'boolean' || 'config' in action) throw Error('arguments_invalid');
      if (action.desiredEnabled) {
        if (action.expectedSessionId !== null) throw Error('expected_session_invalid');
        if (['idle', 'stopped', 'failed'].includes(runtime.state)) {
          if (!finalizationComplete(runtime)) throw Error('session_not_finalized');
          await this.startWithIntent();
        } else await this.setDesiredEnabled(true);
      } else {
        // Every native stop must identify the session it intends to stop.
        if (!UUID.test(action.expectedSessionId ?? '')) throw Error('expected_session_required');
        if (runtime.sessionId !== action.expectedSessionId) throw Error('session_conflict');
        await this.setDesiredEnabled(false);
        if (!['running', 'starting', 'stopping'].includes(runtime.state))
          return { ...this.status(), intentOnly: true, physicalStopRequested: false };
        await this.engine.requestStop();
      }
    } else throw Error('arguments_invalid');
    return this.status();
  }
  model(action) {
    const job = this.queue.then(async () => {
      if (this.pendingUnknown()
          && !(action.action === 'set_enabled' && action.desiredEnabled === false)) throw Error('previous_request_unsettled');
      this.compactReceipts();
      if (((action.action === 'set_enabled' && action.desiredEnabled === true) || (action.action === 'configure' && action.config?.mode === 'continuous'))
          && this.state.stopReceipt)
        throw Error('receipt_capacity_reached');
      await save(this.path, this.state); // persist receipt rotation before any new start
      const result = await this.apply(action); await save(this.path, this.state);
      // Screen sends its own explicit start after configure; a model-initiated
      // selection of mode 1 includes a separately observable start request.
      if (action.action === 'configure' && this.state.config.mode === 'continuous') {
        try {
          await this.startWithIntent();
          return { modeSelected: true, startRequested: true, status: this.status() };
        } catch { return { modeSelected: true, startRequested: true, startOutcome: 'unknown', status: this.status() }; }
      }
      return result;
    });
    this.queue = job.catch(() => {}); return job;
  }
  onDeviceReconnect() {
    // Caller invokes after verifying the robot and media channel are online.
    // A missing durable recovery port never becomes authorization to restart.
    const job = this.queue.then(async () => {
      if (this.state.config.mode !== 'continuous') return { autoStart: 'disabled_for_mode' };
      if (!this.state.desiredEnabled) return { autoStart: 'disabled_by_intent' };
      if (this.pendingUnknown()) return { autoStart: 'blocked_unknown_request' };
      const runtime = this.engine.status();
      if (['running', 'paused_playback'].includes(runtime.state)) return { autoStart: 'already_running' };
      if (typeof this.engine.recoveryReady !== 'function') return { autoStart: 'recovery_unknown' };
      const recovery = await this.engine.recoveryReady();
      if (recovery?.safeToStart !== true) return { autoStart: 'recovery_unknown' };
      this.compactReceipts();
      if (this.state.stopReceipt) return { autoStart: 'receipt_capacity_reached' };
      await save(this.path, this.state);
      await this.engine.start(clone(this.state.config));
      return { autoStart: 'requested', status: this.status() };
    });
    this.queue = job.catch(() => {}); return job;
  }
  device(action, raw) {
    const job = this.queue.then(() => this.deviceOnce(action, raw));
    this.queue = job.catch(() => {}); return job;
  }
  async deviceOnce(action, raw) {
    if (!action || typeof action !== 'object' || Array.isArray(action)
      || Object.keys(action).some(k => !['requestId', 'receiverInstance', 'sequence', 'action', 'expectedConfigRevision', 'desiredEnabled', 'expectedSessionId', 'config'].includes(k))
      || !UUID.test(action.requestId ?? '') || !UUID.test(action.receiverInstance ?? '')
      || !Number.isSafeInteger(action.sequence) || action.sequence < 1 || !Number.isSafeInteger(action.expectedConfigRevision)) throw Error('arguments_invalid');
    const hash = createHash('sha256').update(raw).digest('hex');
    const existing = this.state.receipts[action.requestId] ?? this.state.preflightRejections[action.requestId]
      ?? (this.state.stopReceipt?.requestId === action.requestId ? this.state.stopReceipt : null)
      ?? this.state.retiredReceipts[action.requestId];
    if (existing) {
      if (existing.sha256 !== hash) throw Error('request_id_conflict');
      return this.state.retiredReceipts[action.requestId] ? { ...clone(existing), compacted: true } : clone(existing); // never replay
    }
    this.compactReceipts();
    // Validate identity and monotonic sequence before considering the single
    // reserved stop slot. Rejected stale/retired requests have no side effect
    // and can never consume that safety slot.
    const rejectPreflight = async code => {
      const record = { requestId: action.requestId, sha256: hash, state: 'rejected', code };
      if (Object.keys(this.state.preflightRejections).length < this.limits.maxPreflight) {
        this.state.preflightRejections[action.requestId] = record; await save(this.path, this.state); return clone(record);
      }
      // Bounded full storage cannot durably record unlimited invalid requests.
      // No effect occurred; a lost reply needs conservative manual resolution.
      return { ...record, receiptPersisted: false };
    };
    const changedReceiver = action.receiverInstance !== this.state.currentReceiver;
    if (changedReceiver && this.state.retiredReceivers.includes(action.receiverInstance)) return rejectPreflight('receiver_retired');
    const stopAtReceiverCapacity = changedReceiver && this.state.currentReceiver && this.state.retiredReceivers.length >= 64
      && action.action === 'set_enabled' && action.desiredEnabled === false && !('config' in action)
      && UUID.test(action.expectedSessionId ?? '') && action.expectedSessionId === this.engine.status().sessionId;
    if (changedReceiver && this.state.currentReceiver && this.state.retiredReceivers.length >= 64 && !stopAtReceiverCapacity)
      return rejectPreflight('receiver_capacity_reached');
    if (action.sequence <= (changedReceiver ? 0 : this.state.sequence)) return rejectPreflight('sequence_retired');
    if (action.action === 'set_enabled' && action.desiredEnabled === false) {
      if ('config' in action) return rejectPreflight('arguments_invalid');
      if (!UUID.test(action.expectedSessionId ?? '')) return rejectPreflight('expected_session_required');
      if (action.expectedSessionId !== this.engine.status().sessionId) return rejectPreflight('session_conflict');
      const visible = this.status();
      if (visible.state === 'stopped' && !this.state.desiredEnabled) return rejectPreflight('session_already_stopped');
      // A valid same-session stop may close future intent even when the device
      // outcome is unknown. apply() will not retransmit a physical stop then.
    }
    if (action.action === 'set_enabled' && action.desiredEnabled === true && this.state.stopReceipt)
      return rejectPreflight('receipt_capacity_reached');
    const isActiveStop = action.action === 'set_enabled' && action.desiredEnabled === false;
    const useStopSlot = isActiveStop && Object.keys(this.state.receipts).length >= this.limits.maxReceipts && !this.state.stopReceipt;
    const writeReceipt = record => { if (useStopSlot) this.state.stopReceipt = record; else this.state.receipts[action.requestId] = record; };
    const reject = async code => {
      if (Object.keys(this.state.receipts).length >= this.limits.maxReceipts && !useStopSlot) return rejectPreflight(code);
      writeReceipt({ requestId: action.requestId, sha256: hash, state: 'rejected', code });
      await save(this.path, this.state);
      return clone(useStopSlot ? this.state.stopReceipt : this.state.receipts[action.requestId]);
    };
    if (this.pendingUnknown()
        && !(action.action === 'set_enabled' && action.desiredEnabled === false)) return reject('previous_request_unsettled');
    if (Object.keys(this.state.receipts).length >= this.limits.maxReceipts && !useStopSlot) throw Error('receipt_capacity_reached');
    if (changedReceiver && !stopAtReceiverCapacity) {
      if (this.state.currentReceiver) this.state.retiredReceivers.push(this.state.currentReceiver);
      this.state.currentReceiver = action.receiverInstance; this.state.sequence = 0;
    }
    if (!stopAtReceiverCapacity) this.state.sequence = action.sequence;
    writeReceipt({ requestId: action.requestId, sha256: hash, state: 'pending_outcome_unknown' });
    await save(this.path, this.state); // write-ahead before any actuation.
    try {
      const result = await this.apply(action);
      writeReceipt({ requestId: action.requestId, sha256: hash, state: 'settled', result });
    } catch (error) {
      if ((error instanceof BeforeEffectRejection && error.code === 'exclusive_media_busy') || ['configuration_conflict', 'arguments_invalid', 'session_not_finalized', 'expected_session_invalid', 'expected_session_required', 'session_conflict'].includes(error.message)) {
        writeReceipt({ requestId: action.requestId, sha256: hash, state: 'rejected', code: error.message });
      } // An engine error could be after effect: leave pending/unknown.
    }
    try { await save(this.path, this.state); }
    catch (error) { writeReceipt({ requestId: action.requestId, sha256: hash, state: 'pending_outcome_unknown' }); throw error; }
    return clone(useStopSlot ? this.state.stopReceipt : this.state.receipts[action.requestId]);
  }
}

export function voiceServer({ controller, token }) {
  if (!(controller instanceof VoiceController) || typeof token !== 'string' || token.length < 32) throw Error('server_configuration_invalid');
  const key = Buffer.from(`Bearer ${token}`);
  return createServer(async (req, res) => {
    const send = (code, value) => { const body = JSON.stringify(value); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body); };
    try {
      if (req.headers.origin || req.headers['sec-fetch-site']) return send(403, { error: 'browser_origin_forbidden' });
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length !== key.length || !timingSafeEqual(supplied, key)) return send(401, { error: 'unauthorized' });
      if (req.method === 'GET' && req.url === '/v1/voice-status') return send(200, controller.status());
      const match = req.method === 'GET' && /^\/v1\/voice-receipts\/([0-9a-f-]{36})$/.exec(req.url ?? '');
      if (match) { const result = controller.receipt(match[1]); return send(result ? 200 : 404, result ?? { error: 'not_found' }); }
      if (req.method !== 'POST' || req.url !== '/v1/voice-control' || req.headers['content-type'] !== 'application/json') return send(404, { error: 'not_found' });
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 4096) return send(413, { error: 'body_too_large' }); chunks.push(chunk); }
      const raw = Buffer.concat(chunks), action = JSON.parse(raw.toString('utf8'));
      return send(200, await controller.device(action, raw));
    } catch (error) {
      const known = ['arguments_invalid', 'request_id_conflict', 'receiver_retired', 'sequence_retired', 'previous_request_unsettled', 'receipt_capacity_reached', 'receiver_capacity_reached', 'request_id_invalid'].includes(error.message);
      return send(known ? 409 : 500, { error: known ? error.message : 'controller_failure' });
    }
  });
}
