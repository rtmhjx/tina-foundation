import { StreamEngine } from './stream-engine.mjs';
import { VoiceController, voiceServer } from './voice-control.mjs';
import { createSttPort } from './stt-port.mjs';

/** Candidate assembly; create does not listen or capture. World owner starts
 * HTTP and invokes onDeviceReconnect after actual device readiness separately. */
export async function createVoiceWorldBridge({ head, host, stateDir, spoolRoot, journalDir, token, stt = createSttPort() }) {
  const engine = new StreamEngine({ head, host, stt, stateDir, spoolRoot });
  const controller = await VoiceController.create({ engine, journalDir });
  const server = voiceServer({ controller, token });
  return {
    controller, engine, server,
    tools: () => [voiceTool(controller), speechWaitTool(controller)],
    close: async () => { if (['running', 'starting'].includes(engine.state)) await engine.requestStop();
      if (server.listening) await new Promise(resolve => server.close(resolve)); },
  };
}

export function voiceTool(controller) {
  return { name: 'canbot_voice_control', tags: ['act', 'read'],
      description: 'Inspect, configure, start or stop the shared robot microphone switch. Mode continuous listens until stopped and may resume on next connection after verified recovery; silence_stop ends at configured silence; press_stop stops on the next explicit stop and does not auto-start on reconnect. Exclusive media pauses capture; continuous and press_stop may resume only if the original intent is unchanged and recovery is verified. A playback pause leaves an acoustic gap and a resumed capture is a new session. Persisted/ACKed chunks and gap=false do not prove hardware continuity or a complete acoustic tail; report unknown when tailBoundaryUnknown is true or hardwareReleaseConfirmed is false. Audio is an external observation. If outcomes are unknown do not automatically resend.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', enum: ['status', 'configure', 'start', 'stop', 'toggle'] },
        config: { type: 'object', additionalProperties: false, properties: {
          mode: { type: 'string', enum: ['continuous', 'silence_stop', 'press_stop'] }, silenceMs: { type: 'integer', minimum: 100, maximum: 30000 },
          batch: { oneOf: [
            { type: 'object', additionalProperties: false, properties: { strategy: { type: 'string', enum: ['characters'] }, threshold: { type: 'integer', minimum: 1, maximum: 10000 } }, required: ['strategy', 'threshold'] },
            { type: 'object', additionalProperties: false, properties: { strategy: { type: 'string', enum: ['duration_ms'] }, threshold: { type: 'integer', minimum: 3000, maximum: 60000 } }, required: ['strategy', 'threshold'] },
          ] },
        }, required: ['mode', 'silenceMs', 'batch'] },
      }, required: ['action'] },
      handler: async args => {
        try {
          if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['action', 'config'].includes(k))) throw Error('arguments_invalid');
          if (args.action === 'status') {
            if ('config' in args) throw Error('arguments_invalid');
            return { text: JSON.stringify({ ...controller.status(), speechObservation: controller.engine?.batcher?.snapshot() ?? null }) };
          }
          const current = controller.status(); let command;
          if (args.action === 'configure') command = { action: 'configure', expectedConfigRevision: current.configRevision, config: args.config };
          else {
            if ('config' in args || !['start', 'stop', 'toggle'].includes(args.action)
                || (args.action === 'toggle' && typeof current.enabled !== 'boolean')
                || (args.action === 'stop' && typeof current.sessionId !== 'string')) throw Error('arguments_invalid');
            const desired = args.action === 'toggle' ? !current.enabled : args.action === 'start';
            command = { action: 'set_enabled', expectedConfigRevision: current.configRevision,
              desiredEnabled: desired, expectedSessionId: desired ? null : current.sessionId };
          }
          return { text: JSON.stringify(await controller.model(command)) };
        } catch (error) {
          const allowed = ['arguments_invalid', 'configuration_conflict', 'session_not_finalized', 'session_conflict', 'previous_request_unsettled', 'exclusive_media_busy'];
          return { failed: true, text: JSON.stringify({ code: allowed.includes(error.message) ? error.message : 'voice_outcome_unknown' }) };
        }
      },
    };
}

export function speechWaitTool(controller) {
  return { name: 'canbot_speech_wait', tags: ['read'], barrierAfter: true, interruptible: true,
    description: 'In continuous listening, before answering a CANBOT_AUDIO_OBSERVATION pause_candidate, check whether the speaker resumed: call this with its latest speechRevision (or use canbot_voice_control status for a fresh revision) and wait 200–5000 ms. Returns early on new acoustic activity, revision change, capture stop, or interruption. If activity resumes or recognition is still processing, do not start playback; allow the next observation to arrive. An elapsed quiet wait is an energy observation, not proof of semantic completion or identity; decide whether to answer from context and the external, possibly mistaken transcript. Unknown and delayed audio are not silence. This tool never starts or stops the microphone.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      expectedSpeechRevision: { type: 'integer', minimum: 0 }, waitMs: { type: 'integer', minimum: 200, maximum: 5000 },
    }, required: ['expectedSpeechRevision', 'waitMs'] },
    handler: async (args, ctx = {}) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some(k => !['expectedSpeechRevision', 'waitMs'].includes(k))
          || !Number.isSafeInteger(args.expectedSpeechRevision) || args.expectedSpeechRevision < 0
          || !Number.isInteger(args.waitMs) || args.waitMs < 200 || args.waitMs > 5000)
        return { failed: true, text: '{"code":"speech_wait_arguments_invalid"}' };
      const engine = controller?.engine;
      if (!engine?.batcher || engine.state !== 'running') return { text: '{"state":"not_listening"}' };
      const result = await engine.batcher.wait({ ...args, signal: ctx.signal });
      return { text: JSON.stringify(result) };
    },
  };
}
