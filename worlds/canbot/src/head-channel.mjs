import { createServer, request as httpRequest } from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { isIP } from 'node:net';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TOUCHES = new Map([
  [0x71, ['head_top', true]], [0x73, ['neck_or_upper_screen_bezel', true]],
  [0x7c, ['right_hand_or_arm', true]], [0x7d, ['left_hand_or_arm', true]],
  [0x7e, ['right_ear', true]], [0x7f, ['left_ear', true]],
  [0x80, ['original_CHEST_unconfirmed', false]], [0x81, ['original_ARSE_unconfirmed', false]],
]);

function privateAddress(host) {
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function base(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !privateAddress(url.hostname) || url.username || url.password
    || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('private_robot_base_url_required');
  return url;
}

async function limited(response, maximum) {
  const parts = []; let length = 0;
  try {
    for await (const part of response.body) {
      length += part.length;
      if (length > maximum) throw new Error('response_too_large');
      parts.push(part);
    }
  } finally { /* fetch's abort signal remains active through the body read */ }
  return Buffer.concat(parts);
}

// Robot traffic goes directly to a validated LAN address, independent of the
// host's web proxy. Responses never follow redirects.
function directFetch(url, options) {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers, Connection: 'close', ...(options.body === undefined ? {} : { 'Content-Length': Buffer.byteLength(options.body) }) };
    const request = httpRequest(url, { method: options.method, headers, signal: options.signal }, response => resolve({
      status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
      headers: { get: name => response.headers[name.toLowerCase()] }, body: response,
    }));
    request.once('error', reject); request.end(options.body);
  });
}

export class ChannelError extends Error {
  constructor(code, details = {}) { super(code); this.details = details; }
}

/** Incremental observed BT- decoder, with explicit byte offsets and gap resets. */
export class TouchStream {
  instance = null; next = null; pending = Buffer.alloc(0);
  power = { lastSignal: 'unknown', reason: 'no_observed_charge_event', physicalPowerVerified: false };

  invalidatePower(reason, events) {
    const changed = this.power.lastSignal !== 'unknown';
    this.power = { lastSignal: 'unknown', reason, physicalPowerVerified: false };
    if (changed) events.push({ type: 'canbot.power', ...this.power, impliesUserAuthorization: false });
  }

  observe(gateway) {
    const events = [];
    if (!gateway || !UUID.test(gateway.instanceId) || !Number.isSafeInteger(gateway.rxBytes) || gateway.rxBytes < 0) {
      this.invalidatePower('gateway_observation_unavailable', events);
      this.instance = null; this.next = null; this.pending = Buffer.alloc(0);
      return events;
    }
    if (this.instance !== gateway.instanceId || this.next === null) {
      this.invalidatePower('gateway_instance_or_stream_changed', events);
      this.instance = gateway.instanceId; this.next = gateway.rxBytes; this.pending = Buffer.alloc(0);
      return events; // Establish a live baseline; do not turn old retained bytes into fresh touches.
    }
    for (const chunk of gateway.recentRx ?? []) {
      if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !Number.isSafeInteger(chunk.bytes)
        || chunk.bytes < 1 || !/^(?:[0-9a-f]{2}){1,64}$/.test(chunk.hex)) continue;
      const end = chunk.offset + chunk.bytes;
      if (end <= this.next) continue;
      if (chunk.offset !== this.next) {
        events.push({ type: 'canbot.sensor_gap', expectedOffset: this.next, actualOffset: chunk.offset });
        this.invalidatePower('serial_gap', events);
        this.pending = Buffer.alloc(0);
      }
      const bytes = Buffer.from(chunk.hex, 'hex'); this.next = end;
      this.pending = Buffer.concat([this.pending, bytes]);
      while (this.pending.length >= 5) {
        if (this.pending[0] !== 0x42 || this.pending[1] !== 0x54 || this.pending[2] !== 0x2d
          || this.pending[3] < 1 || this.pending[3] > 32) { this.pending = this.pending.subarray(1); continue; }
        const size = this.pending[3] + 5;
        if (this.pending.length < size) break;
        if (this.pending[size - 1] !== 0x0a) { this.pending = this.pending.subarray(1); continue; }
        const frame = this.pending.subarray(0, size); this.pending = this.pending.subarray(size);
        const mapping = frame[3] === 1 ? TOUCHES.get(frame[4]) : undefined;
        if (mapping) events.push({ type: 'canbot.touch', code: frame[4], position: mapping[0],
          physicalPositionVerified: mapping[1], frameHex: frame.toString('hex'),
          gatewayInstanceId: gateway.instanceId, lastChunkDeviceAt: chunk.at ?? null,
          source: 'mcu_serial_observed_BT_length_LF', impliesUserAuthorization: false });
        if (!chunk.truncated && bytes.length === chunk.bytes
          && (frame[3] === 1 || frame[3] === 3) && (frame[4] === 0x10 || frame[4] === 0x13)) {
          const lastSignal = frame[4] === 0x13 ? 'charging_candidate' : 'charge_disconnected_candidate';
          const changed = this.power.lastSignal !== lastSignal;
          this.power = { lastSignal, code: frame[4], frameHex: frame.toString('hex'),
            gatewayInstanceId: gateway.instanceId, lastChunkDeviceAt: chunk.at ?? null,
            source: 'original_apk_rx_mapping_candidate', physicalPowerVerified: false };
          if (changed) events.push({ type: 'canbot.power', ...this.power, impliesUserAuthorization: false });
        }
      }
      if (chunk.truncated || bytes.length !== chunk.bytes) {
        events.push({ type: 'canbot.sensor_gap', reason: 'truncated_chunk', offset: chunk.offset });
        this.invalidatePower('serial_truncated', events);
        this.pending = Buffer.alloc(0);
      }
    }
    if (this.next !== gateway.rxBytes) {
      events.push({ type: 'canbot.sensor_gap', expectedOffset: this.next, actualOffset: gateway.rxBytes });
      this.invalidatePower('serial_gap', events);
      this.next = gateway.rxBytes; this.pending = Buffer.alloc(0);
    }
    return events;
  }
}

export class HeadChannel {
  constructor({ avatarBaseUrl, mediaBaseUrl, deviceId, bindHost, bindPort, avatarToken, mediaToken,
    emit = async () => {}, fetchImpl = directFetch, clock = Date.now }) {
    this.avatarUrl = base(avatarBaseUrl); this.mediaUrl = base(mediaBaseUrl);
    if (!privateAddress(bindHost) || !Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(deviceId)) throw new Error('head_channel_configuration_invalid');
    Object.assign(this, { deviceId, bindHost, bindPort, avatarToken, mediaToken, emit, fetchImpl, clock });
    this.server = null; this.latest = null; this.lastReceivedAt = null; this.receiverInstance = null;
    this.highSequence = 0; this.retiredInstances = new Set(); this.receipts = new Map();
    this.touches = new TouchStream(); this.deliveryErrors = 0; this.visualQueue = Promise.resolve(); this.mediaQueue = Promise.resolve();
  }

  token(kind) {
    const token = (kind === 'avatar' ? this.avatarToken : this.mediaToken)();
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw new ChannelError(`${kind}_credential_missing_or_invalid`);
    return token;
  }

  async request(kind, path, { method = 'GET', body, signal, binary = false } = {}) {
    if (!/^\/v1\/[A-Za-z0-9/._:-]+$/.test(path) || path.includes('..')) throw new ChannelError('path_invalid');
    const token = this.token(kind);
    const response = await this.fetchImpl(new URL(path, kind === 'avatar' ? this.avatarUrl : this.mediaUrl), {
      method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: binary ? '*/*' : 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    });
    const bytes = await limited(response, binary ? 16 * 1024 * 1024 : 65536);
    if (binary) {
      if (!response.ok) throw new ChannelError('media_download_rejected', { httpStatus: response.status });
      return { bytes, mime: response.headers.get('content-type')?.split(';')[0] };
    }
    let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new ChannelError('device_response_not_json'); }
    if (!response.ok) throw new ChannelError('device_request_rejected', { httpStatus: response.status, error: value.error });
    return value;
  }

  async start() {
    if (this.server) throw new Error('head_channel_already_started');
    this.token('avatar'); this.token('media');
    const server = createServer((req, res) => void this.receive(req, res));
    server.on('connection', socket => { const deadline = setTimeout(() => socket.destroy(), 3000); socket.once('close', () => clearTimeout(deadline)); });
    server.headersTimeout = 3000; server.requestTimeout = 3000; server.maxConnections = 4;
    server.keepAliveTimeout = 1000; this.server = server;
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.bindPort, this.bindHost, resolve); }); }
    catch (error) { this.server = null; server.close(); throw error; }
    return server.address();
  }

  async stop() {
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }

  status() {
    const observationFresh = this.lastReceivedAt !== null && this.clock() - this.lastReceivedAt < 10000;
    const powerFresh = observationFresh && this.latest?.gateway?.instanceId === this.touches.instance
      && this.latest?.gateway?.serialOpen !== false;
    return { enabled: true, listening: Boolean(this.server?.listening), deviceId: this.deviceId,
      lastReceivedAt: this.lastReceivedAt === null ? null : new Date(this.lastReceivedAt).toISOString(),
      observationFresh,
      receiverInstanceId: this.receiverInstance, sampleSequence: this.highSequence, deliveryErrors: this.deliveryErrors,
      avatar: this.latest?.avatar ?? null, gateway: this.latest?.gateway ?? null,
      power: powerFresh ? { ...this.touches.power, linkFresh: true }
        : { lastSignal: 'unknown', reason: 'uplink_stale_or_gateway_unavailable', physicalPowerVerified: false, linkFresh: false },
      physicalCommandsFromIngress: false, corticoPersonaPerceptionVerified: false };
  }

  async receive(req, res) {
    const send = (status, value) => { if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' }).end(JSON.stringify(value)); };
    let timer;
    try {
      const auth = req.headers.authorization, expected = `Bearer ${this.token('avatar')}`;
      const names = req.rawHeaders.filter((_value, index) => index % 2 === 0).map(value => value.toLowerCase());
      if (names.filter(name => name === 'authorization').length !== 1) { send(401, { error: 'unauthorized' }); return; }
      if (typeof auth !== 'string' || Buffer.byteLength(auth) !== Buffer.byteLength(expected)
        || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) { send(401, { error: 'unauthorized' }); return; }
      if (req.method !== 'POST' || req.url !== '/v1/device-events') { send(404, { error: 'not_found' }); return; }
      if (req.headers.origin || req.headers['transfer-encoding'] || req.headers['content-type'] !== 'application/json'
        || !/^[1-9][0-9]{0,4}$/.test(req.headers['content-length'] ?? '') || Number(req.headers['content-length']) > 65536) { send(400, { error: 'request_invalid' }); return; }
      timer = setTimeout(() => req.destroy(), 3000); const parts = []; let length = 0;
      for await (const part of req) { length += part.length; if (length > 65536) throw new Error('too_large'); parts.push(part); }
      const raw = Buffer.concat(parts), event = JSON.parse(raw.toString('utf8'));
      if (event.schemaVersion !== 'canbot.device-event.v1' || event.deviceId !== this.deviceId
        || !UUID.test(event.instanceId) || !Number.isSafeInteger(event.sampleSequence) || event.sampleSequence < 1
        || event.eventId !== `${event.instanceId}:${event.sampleSequence}` || event.avatar?.instanceId !== event.instanceId
        || event.avatar?.schemaVersion !== 'canbot.avatar.v1') { send(400, { error: 'event_invalid' }); return; }
      const digest = createHash('sha256').update(raw).digest('hex'), old = this.receipts.get(event.eventId);
      if (old !== undefined && old !== digest) { send(409, { error: 'event_id_conflict' }); return; }
      if (old === undefined) {
        if (this.receiverInstance !== event.instanceId) {
          if (this.retiredInstances.has(event.instanceId)) { send(409, { error: 'instance_retired' }); return; }
          if (this.receiverInstance) this.retiredInstances.add(this.receiverInstance);
          while (this.retiredInstances.size > 16) this.retiredInstances.delete(this.retiredInstances.values().next().value);
          this.receiverInstance = event.instanceId; this.highSequence = 0;
        }
        if (event.sampleSequence <= this.highSequence) { send(409, { error: 'sequence_retired' }); return; }
        this.highSequence = event.sampleSequence; this.latest = event; this.receipts.set(event.eventId, digest);
        while (this.receipts.size > 128) this.receipts.delete(this.receipts.keys().next().value);
        this.lastReceivedAt = this.clock();
        const events = this.touches.observe(event.gateway);
        send(202, { accepted: true, deviceId: this.deviceId, instanceId: event.instanceId, sampleSequence: event.sampleSequence });
        for (const observed of events) {
          try { if (await this.emit(observed.type, observed) === false) this.deliveryErrors++; } catch { this.deliveryErrors++; }
        }
        return;
      }
      send(200, { accepted: true, duplicate: true, deviceId: this.deviceId, instanceId: event.instanceId, sampleSequence: event.sampleSequence });
    } catch { send(400, { error: 'event_incomplete_or_invalid' }); }
    finally { if (timer) clearTimeout(timer); }
  }

  avatar(args, signal) {
    const work = this.visualQueue.then(() => this.changeAvatar(args, signal));
    this.visualQueue = work.catch(() => {}); return work;
  }

  async changeAvatar(args, signal) {
    const allowed = ['expression', 'motion', 'gazeX', 'gazeY', 'mouthOpen', 'durationMs', 'requestId'];
    if (!args || Object.keys(args).some(k => !allowed.includes(k))) throw new ChannelError('avatar_arguments_invalid');
    const id = args.requestId ?? randomUUID();
    if (typeof id !== 'string' || !OPERATION.test(id)) throw new ChannelError('operation_id_invalid');
    for (const [key, min, max] of [['gazeX', -1, 1], ['gazeY', -1, 1], ['mouthOpen', -1, 1]]) {
      if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isFinite(args[key]) || args[key] < min || args[key] > max)) throw new ChannelError('visual_value_out_of_range');
    }
    if (args.mouthOpen !== undefined && args.mouthOpen < 0 && args.mouthOpen !== -1) throw new ChannelError('mouth_open_invalid');
    if (args.durationMs !== undefined && (!Number.isInteger(args.durationMs) || args.durationMs < 0 || args.durationMs > 30000)) throw new ChannelError('visual_duration_invalid');
    const status = await this.request('avatar', '/v1/status', { signal });
    if (status.schemaVersion !== 'canbot.avatar.v1') throw new ChannelError('avatar_protocol_mismatch');
    const expression = args.expression ?? 'keep', motion = args.motion ?? 'keep';
    if (!(expression === 'keep' || status.expressions?.includes(expression)) || !(motion === 'keep' || status.motions?.includes(motion))) throw new ChannelError('model_name_unknown');
    const body = { operationId: id, instanceId: status.instanceId, sequence: status.lastSequence + 1,
      expression, motion, gazeX: args.gazeX === undefined ? status.current.gazeX : Math.round(args.gazeX * 1000),
      gazeY: args.gazeY === undefined ? status.current.gazeY : Math.round(args.gazeY * 1000),
      mouth: args.mouthOpen === undefined ? status.current.mouth : args.mouthOpen < 0 ? -1 : Math.round(args.mouthOpen * 1000), durationMs: args.durationMs ?? 5000 };
    try { const reply = await this.request('avatar', '/v1/state', { method: 'POST', body, signal }); return { ...reply, operationId: id, physicalControl: false }; }
    catch (error) {
      if (error instanceof ChannelError && error.details.httpStatus) throw error;
      // A response can be lost after acceptance. Read the same ID; do not repeat POST.
      try { return { operationId: id, postResponseLost: true, operation: await this.request('avatar', `/v1/operations/${id}`, { signal }), retryAutomatically: false }; }
      catch { throw new ChannelError('avatar_outcome_unknown', { operationId: id, retryAutomatically: false }); }
    }
  }

  capture(kind, signal, durationMs, cue = false) {
    const work = this.mediaQueue.then(() => this.captureOnce(kind, signal, durationMs, cue));
    this.mediaQueue = work.catch(() => {}); return work;
  }

  async captureOnce(kind, signal, durationMs, cue = false) {
    if (!['photo', 'microphone', 'video', 'tone'].includes(kind)) throw new ChannelError('media_kind_invalid');
    if (typeof cue !== 'boolean') throw new ChannelError('microphone_cue_invalid');
    if (cue && kind !== 'microphone') throw new ChannelError('cue_only_supported_for_microphone');
    if (durationMs !== undefined && kind !== 'microphone') throw new ChannelError('duration_only_supported_for_microphone');
    if (durationMs !== undefined && (!Number.isInteger(durationMs) || durationMs < 3000 || durationMs > 10000)) {
      throw new ChannelError('microphone_duration_invalid');
    }
    const status = await this.request('media', '/v1/status', { signal });
    if (status.schemaVersion !== 'canbot.diagnostics.v2' || !status.foreground) throw new ChannelError('media_service_not_ready');
    const microphone = status.microphoneCapture;
    if (cue && microphone?.supportsCue !== true) throw new ChannelError('microphone_cue_unsupported');
    // Only trust the advertised extended contract. The media service default is
    // 3000ms, but this World explicitly requests 6000ms on capable versions.
    const extendedMicrophone = microphone?.minDurationMs === 3000
      && microphone?.maxDurationMs === 10000 && microphone?.defaultDurationMs === 3000;
    const captureDurationMs = kind === 'microphone' ? durationMs ?? (extendedMicrophone ? 6000 : 3000)
      : kind === 'tone' ? 500 : 3000;
    if (kind === 'microphone' && !extendedMicrophone && captureDurationMs > 3000) {
      throw new ChannelError('microphone_duration_unsupported', { requestedDurationMs: captureDurationMs, supportedMaxDurationMs: 3000 });
    }
    const id = randomUUID(), body = { operationId: id, instanceId: status.instanceId, sequence: status.lastSequence + 1,
      ...(kind === 'photo' ? {} : { durationMs: captureDurationMs }),
      // Omit false for old devices with strict request-field validation. A cue
      // is part of this one MIC operation, never a separate tone request.
      ...(cue ? { cue: true } : {}) };
    try { await this.request('media', `/v1/${kind}`, { method: 'POST', body, signal }); }
    catch (error) { if (error instanceof ChannelError && error.details.httpStatus) throw error; }
    // A 10s MIC operation has a 13s device deadline; allow 4s for receipt
    // transport/cleanup. Legacy 3s MIC and other kinds keep their 10s budget.
    const pollBudgetMs = kind === 'microphone' ? captureDurationMs + 7000 : 10000;
    const deadline = this.clock() + pollBudgetMs; let receipt;
    const pollTimeout = AbortSignal.timeout(pollBudgetMs);
    const pollSignal = signal ? AbortSignal.any([signal, pollTimeout]) : pollTimeout;
    while (this.clock() < deadline) {
      try {
        receipt = await this.request('media', `/v1/operations/${id}`, { signal: pollSignal });
        if (receipt.settled) break;
      } catch (error) { if (signal?.aborted) throw new ChannelError('media_outcome_unknown', { operationId: id, retryAutomatically: false }); }
      if (pollSignal.aborted) break;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(150, deadline - this.clock()))));
    }
    if (!receipt?.settled || receipt.state !== 'complete') throw new ChannelError('media_not_complete', { operationId: id, state: receipt?.state ?? 'unknown', retryAutomatically: false });
    const media = receipt.result?.media;
    if (!media) return { receipt, blobs: [] };
    if (!UUID.test(media.id) || !Number.isInteger(media.bytes) || media.bytes < 1 || media.bytes > 16 * 1024 * 1024
      || !['image/jpeg', 'audio/wav', 'video/mp4', 'video/3gpp'].includes(media.mime)) throw new ChannelError('media_descriptor_invalid');
    const download = await this.request('media', `/v1/media/${media.id}`, { signal, binary: true });
    if (download.bytes.length !== media.bytes || download.mime !== media.mime) throw new ChannelError('media_download_mismatch');
    if (media.mime === 'image/jpeg' && !(download.bytes[0] === 255 && download.bytes[1] === 216 && download.bytes.at(-2) === 255 && download.bytes.at(-1) === 217)) throw new ChannelError('jpeg_signature_invalid');
    if (media.mime === 'audio/wav' && !(download.bytes.subarray(0, 4).toString() === 'RIFF' && download.bytes.subarray(8, 12).toString() === 'WAVE')) throw new ChannelError('wav_signature_invalid');
    return { receipt, sha256: createHash('sha256').update(download.bytes).digest('hex'),
      blobs: [{ bytes: new Uint8Array(download.bytes), mime: media.mime, name: `${kind}-${media.id}.${media.mime === 'image/jpeg' ? 'jpg' : media.mime === 'audio/wav' ? 'wav' : media.mime === 'video/3gpp' ? '3gp' : 'mp4'}`,
        fallbackText: `机器人 ${kind} 采集文件；来源是 CANBOT 实际设备。当前提供方能否读取此格式须另行验证。` }] };
  }
}
