import { CANBOT_DEFAULTS, CANBOT_SECRET, AVATAR_SECRET, MEDIA_SECRET, VOICE_SECRET } from './config.mjs';
import { CanbotWorld } from './world.mjs';
import { CoordinatedCanbotWorld } from './coordinated/integrated-world.mjs';
import { join, isAbsolute } from 'node:path';

const allTools = new CoordinatedCanbotWorld({ cfg: { ...CANBOT_DEFAULTS, headEnabled: true, separationEnabled: true, diarizationEnabled: true },
  experienceDir: '/describe/canbot-experience', developmentWorkspace: '/describe/canbot-workspace', developmentProjectId: 'example' }).tools();

export const CANBOT = {
  id: 'canbot',
  label: 'CANBOT',
  describe: {
    tools: allTools.map(({ name, description, parameters, tags }) => ({ name, description, parameters, tags })),
    events: [
      { type: 'canbot.speech', description: '机器人麦克风转写的外部观察，身份未验证。', trigger: 'flush' },
      { type: 'canbot.speech.partial', description: '分段转写进度，仅归档供界面展示；不是说完或身份确认。', trigger: 'piggyback' },
      { type: 'canbot.speech.pause', description: '已归档转写之后观察到的暂时停顿或采集停止，不代表语义已结束。', trigger: 'flush' },
      { type: 'canbot.connection', description: 'API、设备能力或连接状态发生变化。', trigger: 'flush' },
      { type: 'canbot.command', description: '命名动作或停止的 API 回执，物理完成仍需另外核对。', trigger: 'flush' },
      { type: 'canbot.program', description: '逻辑程序保存或删除的存储回执。', trigger: 'flush' },
      { type: 'canbot.camera', description: '本次请求采集的原图字节、设备来源和采集回执。', trigger: 'flush' },
      { type: 'canbot.touch', description: '来源为 external 的机器人触摸传感器事件。', trigger: 'flush' },
      { type: 'canbot.power', description: '来源为 external 的候选充电连接或断开观察；不验证电机供电或动作完成。', trigger: 'flush' },
      { type: 'canbot.sensor_gap', description: '串口观察字节出现缺口，缺失内容未知。', trigger: 'flush' },
    ],
  },
  defaults: () => structuredClone(CANBOT_DEFAULTS),
  create: (ctx) => {
    const workspace = process.env.CANBOT_WORLD_WORKSPACE;
    const project = process.env.CANBOT_WORLD_WORKSPACE_PROJECT;
    const opts = { cfg: ctx.cfg,
      experienceDir: typeof ctx.dataDir === 'string' && isAbsolute(ctx.dataDir) ? join(ctx.dataDir, 'worlds', 'canbot', 'experience') : null,
      developmentWorkspace: workspace && isAbsolute(workspace) ? workspace : null,
      developmentProjectId: project || null,
      token: () => ctx.secret(CANBOT_SECRET), avatarToken: () => ctx.secret(AVATAR_SECRET),
      mediaToken: () => ctx.secret(MEDIA_SECRET) };
    if (!ctx.cfg.coordinatedVoiceEnabled) return new CanbotWorld(opts);
    return new CoordinatedCanbotWorld({ ...opts,
      voice: { token: () => ctx.secret(VOICE_SECRET), bindHost: ctx.cfg.voiceControlBind, port: ctx.cfg.voiceControlPort,
        stateDir: ctx.cfg.voiceStateDir, spoolRoot: ctx.cfg.voiceSpoolRoot, journalDir: ctx.cfg.voiceJournalDir },
      media: { journalDir: ctx.cfg.mediaArbitrationJournalDir, ipcDir: ctx.cfg.mediaIpcDir,
        allowedRoots: ctx.cfg.mediaAllowedRoots, helper: ctx.cfg.mediaPlaybackHelper,
        helperSha256: ctx.cfg.mediaPlaybackHelperSha256, linkPath: ctx.cfg.mediaPlaybackLinkPath,
        maxSnapshotBytes: ctx.cfg.mediaMaxSnapshotBytes, maxAdmissions: ctx.cfg.mediaMaxAdmissions } });
  },
};
