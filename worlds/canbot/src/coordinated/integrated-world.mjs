import { CanbotWorld } from '../world.mjs';
import { ChannelError } from '../head-channel.mjs';
import { createVoiceWorldBridge, voiceTool, speechWaitTool } from '../voice/stream-world-bridge.mjs';
import { StreamGuard } from '../voice/stream-guard.mjs';
import { ArbitrationJournal } from './journal.mjs';
import { withReleaseProof } from './guard-adapter.mjs';
import { installControllerListener } from './controller-listener.mjs';
import { MediaCoordinator } from './coordinator.mjs';
import { createAudioIpc, helperExecutor } from './audio-ipc.mjs';
import { ReconnectLatch } from './reconnect-latch.mjs';

// Candidate assembly. Importing/constructing does not start a service. All
// other media users must be migrated to this coordinator before deployment.
export class CoordinatedCanbotWorld extends CanbotWorld {
  constructor({ voice, media, ...options }) {
    super(options); Object.assign(this, { voiceOptions: voice, mediaOptions: media, voiceBridge: null, mediaIpc: null, coordinator: null, voiceMonitor: null, voiceSeenOnline: false, voiceReconnectError: null });
  }
  tools() {
    const tool = voiceTool(null);
    return [...super.tools(), { ...tool, handler: async (...args) => {
      if (!this.voiceBridge) return { failed: true, text: '{"code":"voice_not_started"}' };
      const result = await this.voiceBridge.tools()[0].handler(...args);
      if (args[0]?.action === 'status' && !result.failed) {
        try { result.text = JSON.stringify({ ...JSON.parse(result.text), reconnectError: this.voiceReconnectError }); } catch { /* preserve original response */ }
      }
      return result;
    } }, { ...speechWaitTool(null), handler: async (...args) => {
      if (!this.voiceBridge) return { failed: true, text: '{"code":"voice_not_started"}' };
      return this.voiceBridge.tools()[1].handler(...args);
    } }];
  }
  async start(host) {
    const v = this.voiceOptions, m = this.mediaOptions;
    if (!v || !m || !this.head || !v.token || !v.stateDir || !v.spoolRoot || !v.journalDir || !m.journalDir
      || !m.ipcDir || !m.allowedRoots || !m.helper || !m.helperSha256 || !m.linkPath) throw Error('coordinated_world_configuration_missing');
    const voiceToken = typeof v.token === 'function' ? await v.token() : v.token;
    if (typeof voiceToken !== 'string' || voiceToken.length < 32 || voiceToken === this.head.mediaToken() || voiceToken === this.head.avatarToken()) throw Error('voice_token_invalid_or_reused');
    await super.start(host);
    try {
      this.voiceBridge = await createVoiceWorldBridge({ head: this.head, host, token: voiceToken, stateDir: v.stateDir,
        spoolRoot: v.spoolRoot, journalDir: v.journalDir, ...(v.stt ? { stt: v.stt } : {}) });
      const listener = installControllerListener(this.voiceBridge.controller);
      const journal = new ArbitrationJournal(m.journalDir); await journal.init();
      const reconnectLatch = new ReconnectLatch(m.journalDir);
      if (await reconnectLatch.pending()) this.voiceReconnectError = 'voice_reconnect_outcome_unknown';
      this.coordinator = new MediaCoordinator({ listener, journal, head: this.head,
        guardFactory: () => withReleaseProof(new StreamGuard({ stateDir: v.stateDir })),
        audioExecutor: helperExecutor({ executable: m.helper, expectedHelperSha256: m.helperSha256, stateDir: v.stateDir, linkPath: m.linkPath }) });
      this.head.capture = async (kind, signal, durationMs, cue) => {
        const result = await this.coordinator.capture(kind, signal, durationMs, cue);
        if (result.arbitration.state === 'rejected' && result.arbitration.reason === 'device_unavailable' && result.arbitration.playbackSent === false)
          throw new ChannelError('device_unavailable', { outcome: 'rejected', playbackSent: false });
        if (result.arbitration.state !== 'completed' || !result.resultAvailable) throw Error('coordinated_media_outcome_unknown');
        return result.result;
      };
      this.mediaIpc = await createAudioIpc({ coordinator: this.coordinator, folder: m.ipcDir, allowedRoots: m.allowedRoots,
        ...(m.maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes: m.maxSnapshotBytes }),
        ...(m.maxAdmissions === undefined ? {} : { maxAdmissions: m.maxAdmissions }) });
      await new Promise((resolve, reject) => { this.voiceBridge.server.once('error', reject); this.voiceBridge.server.listen(v.port ?? 7334, v.bindHost ?? '127.0.0.1', resolve); });
      const inspect = async () => {
        if (!this.voiceBridge || !this.lifecycle) return;
        let online = false;
        try {
          try { const s = await this.head.request('media', '/v1/status'); online = s.foreground === true && s.microphoneCapture?.supportsStream === true; } catch { /* offline */ }
          if (online && !this.voiceSeenOnline) {
            try {
              if (await reconnectLatch.pending()) throw Error('previous_reconnect_unsettled');
              await reconnectLatch.begin();
              await this.voiceBridge.controller.onDeviceReconnect();
              await reconnectLatch.confirm(); this.voiceReconnectError = null;
            }
            catch { this.voiceReconnectError = 'voice_reconnect_outcome_unknown'; try { host.log?.warn?.('CANBOT voice reconnect outcome unknown; manual controls remain available.'); } catch { /* keep monitoring */ } }
          }
          this.voiceSeenOnline = online;
        } finally {
          if (this.voiceBridge && this.lifecycle) { this.voiceMonitor = setTimeout(() => { void inspect(); }, v.pollMs ?? 5000); this.voiceMonitor.unref?.(); }
        }
      };
      await inspect();
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    if (this.voiceMonitor) clearTimeout(this.voiceMonitor); this.voiceMonitor = null;
    if (this.mediaIpc) { const ipc = this.mediaIpc; this.mediaIpc = null; await ipc.close(); }
    const bridge = this.voiceBridge; this.voiceBridge = null;
    if (bridge) { await bridge.close(); if (bridge.engine.runner) await bridge.engine.runner; }
    await super.stop();
  }
}
