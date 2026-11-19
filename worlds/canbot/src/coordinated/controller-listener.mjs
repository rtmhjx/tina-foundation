// Candidate adapter around the real VoiceController/StreamEngine ports. All
// control calls must pass through this controller; direct engine.start bypasses
// the intent CAS and is therefore forbidden when this adapter is installed.
import { BeforeEffectRejection } from '../voice/voice-control.mjs';
import { withReleaseProof } from './guard-adapter.mjs';

export function installControllerListener(controller) {
  if (!controller?.engine || typeof controller.apply !== 'function' || typeof controller.status !== 'function') throw Error('controller_invalid');
  const engine = controller.engine, originalApply = controller.apply.bind(controller), originalReconnect = controller.onDeviceReconnect.bind(controller), originalStatus = controller.status.bind(controller);
  let revision = 0, pausedSession = null, exclusive = false, resuming = false;
  const desired = () => controller.state.desiredEnabled === true;
  controller.status = () => {
    const status = originalStatus();
    return pausedSession ? { ...status, enabled: desired(), phase: 'paused_playback', state: 'paused_playback', sessionId: pausedSession } : status;
  };
  const originalStart = engine.start.bind(engine);
  engine.start = async config => {
    if (exclusive && !resuming) throw Error('exclusive_media_busy');
    const value = await originalStart(config); revision++; return value;
  };
  const enqueue = fn => { const job = controller.queue.then(fn); controller.queue = job.catch(() => {}); return job; };
  controller.apply = async action => {
    if (exclusive) {
      if (action.action === 'set_enabled' && action.desiredEnabled === false && action.expectedSessionId === engine.sessionId) {
        const active = ['running', 'starting', 'stopping'].includes(engine.state);
        if (active) await originalApply(action);
        else if (action.expectedSessionId !== pausedSession) throw Error('session_conflict');
        else await controller.setDesiredEnabled(false);
        revision++; return { ...controller.status(), ...(!active ? { intentOnly: true, physicalStopRequested: false } : {}) };
      }
      // Existing control state machine cannot yet defer config or starts until
      // exclusive operation completion; refuse explicitly instead of racing.
      throw new BeforeEffectRejection('exclusive_media_busy');
    }
    const result = await originalApply(action);
    if (action.action === 'set_enabled' || action.action === 'configure') revision++;
    return result;
  };
  controller.onDeviceReconnect = async () => {
    if (exclusive) return { autoStart: 'exclusive_media_busy' };
    const r = await originalReconnect();
    if (r.autoStart === 'requested' || r.autoStart === 'already_running') revision++;
    return r;
  };
  const proof = async sessionId => {
    const c = engine.client, s = c?.status(), tail = c?.spool?.finalState;
    if (!c || engine.sessionId !== sessionId || engine.state !== 'stopped' || !c.finished || !tail || s?.capture?.gap !== false) return null;
    const released = await withReleaseProof(c.guard).waitReleased();
    return { sessionId, settled: tail.settled === true, deviceStopConfirmed: s.deviceStopConfirmed === true,
      guardReleased: released, finalTailPersisted: c.spool.finished === true,
      finalAcked: c.spool.ackedThrough >= tail.finalSequence, gap: c.spool.gap,
      tailBoundaryUnknown: s.capture.tailBoundaryUnknown };
  };
  return {
    beginExclusive: () => enqueue(async () => { if (exclusive) throw Error('exclusive_media_busy'); exclusive = true; }),
    endExclusive: () => enqueue(async () => { exclusive = false; pausedSession = null; }),
    snapshot: async () => {
      const s = engine.status(), mode = controller.state.config.mode;
      const active = ['running', 'starting'].includes(s.state), idle = ['idle', 'stopped'].includes(s.state);
      const p = s.state === 'stopped' && s.sessionId ? await proof(s.sessionId) : null;
      const initialIdle = s.state === 'idle' && !s.sessionId;
      let connected = false;
      try { const live = await engine.head.request('media', '/v1/status'); connected = live.foreground === true && (!engine.client?.operation || live.instanceId === engine.client.operation.instanceId); } catch { /* unverified */ }
      return { intentEnabled: desired(), intentRevision: revision, mode, connected,
        listening: active ? 'active' : idle ? 'idle' : 'unknown', sessionId: s.sessionId,
        guardReleased: initialIdle || p?.guardReleased === true, deviceStopConfirmed: initialIdle || p?.deviceStopConfirmed === true,
        finalTailPersisted: initialIdle || p?.finalTailPersisted === true, finalAcked: initialIdle || p?.finalAcked === true };
    },
    pauseForPlayback: ({ sessionId, intentRevision }) => enqueue(async () => {
      if (pausedSession || revision !== intentRevision || engine.sessionId !== sessionId || !['running', 'starting'].includes(engine.state)) return { accepted: false };
      pausedSession = sessionId;
      await engine.requestStop('playback_pause');
      return { accepted: true };
    }),
    waitSettled: async ({ sessionId }) => { await engine.runner; return await proof(sessionId); },
    resumeIfUnchanged: async ({ expectedIntentRevision, previousSessionId }) => {
      const started = await enqueue(async () => {
        if (pausedSession !== previousSessionId || revision !== expectedIntentRevision || !desired()
            || !['continuous', 'press_stop'].includes(controller.state.config.mode)) {
          pausedSession = null; return { state: 'not_resumed' };
        }
        if (engine.state !== 'stopped') return { state: 'unknown' };
        let live;
        try { live = await engine.head.request('media', '/v1/status'); } catch { return { state: 'not_resumed' }; }
        if (live.foreground !== true || live.instanceId !== engine.client?.operation?.instanceId || live.activeOperation !== null) return { state: 'not_resumed' };
        try { resuming = true; await engine.start(JSON.parse(JSON.stringify(controller.state.config))); }
        finally { resuming = false; }
        pausedSession = null;
        return { state: 'starting', sessionId: engine.sessionId, revision };
      });
      if (started.state !== 'starting') return started;
      // Do not hold the controller queue while awaiting an observed start: a
      // concurrent explicit stop must remain able to stop this new session.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const s = engine.status();
        if (revision !== started.revision || !desired() || s.sessionId !== started.sessionId || s.state === 'stopping' || s.state === 'stopped') return { state: 'not_resumed' };
        if (s.state === 'running' && s.microphone === 'active') return { state: 'resumed' };
        if (s.state === 'failed') return { state: 'unknown' };
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return { state: 'unknown' };
    },
  };
}
