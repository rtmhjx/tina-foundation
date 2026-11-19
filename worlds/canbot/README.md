> **0.8.0-candidate.8：独立候选。** 在既有充电候选观察的基础上增加可追溯使用心得、机器人 World 工作区指示，以及计时动作名单变化事件。心得区别观察与推测；更正追加新记录。用户授权可经现有主从联络与 DSH 工程桥修改机器人 World。代码、正式加载和实际动作分别验收。

> **0.8.0-candidate.6 历史说明：** 持续听的模型事件包含分段、停顿和时间观察；主线应先检查是否又开始说话，再结合语义判断是否回应。对播放 helper 在启动前被系统拒绝执行的情况，明确记录未播放并释放仲裁；启动后结果不明仍保持锁定。候选测试、正式挂载及实机验收分别记录，模型仍可能不遵循等待提示。具体准备及回退见 [UPGRADE-ROLLBACK.md](UPGRADE-ROLLBACK.md)；任何旧切换命令均需依据当前主线状态重新核对。以下原 README 描述 0.7.0 基础功能；关于语音的最新条件见环境提示和候选说明。

<!-- Owner: src/definition.mjs, src/world.mjs -->

# CANBOT World

**0.7.0 增加默认关闭的显式音频分析候选。** `canbot_separate_audio` 复用5810现有8051声源分离旁路，`canbot_diarize_audio` 复用独立8053匿名分段旁路。两者只解析已获授权的既有 `log:` WAV，最长10秒；没有新的麦克风、常听、运动、ASR替代或Core修改。匿名分离轨与匿名重叠时间段是不同结果，均不证明身份或实际准确度。提交账本、私有凭据、调用与恢复约束见 [AUDIO-ANALYSIS.md](AUDIO-ANALYSIS.md)。此包只完成本地假旁路测试，未以此构建执行主线部署或真实分离验收。

**0.6.2 增加同一次录音内的可选提示音。** `canbot_capture({kind:"microphone", durationMs:6000, cue:true})` 要求实时媒体状态声明 `microphoneCapture.supportsCue=true`，将 `cue:true` 放入同一次麦克风POST；Android契约为先录音再播提示音，避免先独立tone再请求MIC的模型往返空档。`cue`默认false，省略/false不新增请求字段以兼容旧设备；旧设备显式true在POST前返回 `microphone_cue_unsupported`，不降级、不拆分、不自动重试。能力、队列和未知回执已有离线测试，真实提示音时序与可听性需设备验收。

**0.6.1 扩展按工具请求的麦克风录音窗口。** `canbot_capture({kind:"microphone", durationMs:3000..10000})` 在完整扩展能力可用时默认6秒，旧媒体默认仍3秒；旧媒体显式请求超过3秒返回 `microphone_duration_unsupported`，不会截短或重试。10秒录音的回执观察预算为17秒，覆盖设备13秒截止和4秒收尾/网络余量。闲时麦克风关闭，没有连续监听。照片和3秒无声录像契约保持不变。

**0.6.0 增加设备端限时运动与持久回执查询工具。** `canbot_move` 只提交明确开放的原厂宏，Android Gateway 0.2.2 本地计时发送 STOP；`canbot_move_receipt` 只读同一 ID 的计划回执。默认仍关闭，需单独配置并记录设备计时 STOP 的现场验收。旧 `canbot_do` 保留兼容，不扩大原头部验证名单。听说说明复用主线现成 `stt_transcribe`、`tts_speak(event)` 与 `audio-play`，不新增 ASR/TTS 服务。

保留0.5.0的真实事件原文背景与本地 Live2D 前景。原文、柔化、滚动速度和暂停开关只影响显示。照片仍以原始字节随 `canbot.camera` 外部事件投递，沿用 Core 的工具回执，由 Responses 在 `function_call_output.output` 中附带 `input_image`。保持主线现有 Persona、主会话和 Memory，不需要修改 `eventDelivery`；不调用辅助视觉模型。接口、凭据与开关见 [HEAD-CHANNEL.md](HEAD-CHANNEL.md)。默认 headEnabled=false、timelineEnabled=false。

本扩展连接 CANBOT HTTP API。Android 保留为机器人通信节点，现有 MCU 固件继续负责底层动作；API 可运行在 5810。默认配置关闭，默认 API 地址为 `http://127.0.0.1:7331`。

扩展采用 Cortico Minecraft World 的事件与动作回执模式。CANBOT 没有沿用 Minecraft 的坐标、寻路、战斗反射或自动撤退。0.2.0 增加具备 revision 的逻辑程序存储；动作默认禁用，只有 API 的显式 commissioning 配置和 Android 网关双重开放后才可能发送少量命名验证动作。20 个原厂静态预设保持只读，不被自动标记为物理已验证。

## 工具

| 工具 | 行为 |
| --- | --- |
| `canbot_status` | `GET /v1/status`：连接状态、能力与阻塞原因 |
| `canbot_observe` | `GET /v1/frames?limit=N`：最近 1–100 个带来源信息的 UDP 帧 |
| `canbot_actions` | `GET /v1/actions`：原厂静态预设与逐项 enabled/blockedBy |
| `canbot_move` | `POST /v1/timed-actions`：严格 requestId/action/durationMs，设备本地计划 STOP |
| `canbot_move_receipt` | `GET /v1/timed-actions/:requestId`：只读同 ID 持久回执，不重发 |
| `canbot_do` | 兼容旧 `POST /v1/actions` 验证入口；常规运动使用 move，不放开旧名单 |
| `canbot_stop` | `POST /v1/stop`：停止请求；是否证实物理停止由回执明确报告 |
| `canbot_programs` | 列出自定义程序、当前全局 revision、数量和步数限制 |
| `canbot_program_get` | 读取一个程序；结果含当前全局 revision |
| `canbot_program_save` | 使用 expectedRevision 创建或替换逻辑；不执行 |
| `canbot_program_delete` | 使用 expectedRevision 删除自定义逻辑；保留原厂预设 |
| `canbot_separate_audio` | 可选8051：只对既有log:WAV显式分离成两条匿名轨，可选原音/轨ASR |
| `canbot_separation_receipt` | 仅GET本World已登记UUID，按需校验下载匿名WAV，不重跑 |
| `canbot_diarize_audio` | 可选8053：既有log:WAV的匿名说话人时间段，保留重叠，不分离音轨 |
| `canbot_diarization_receipt` | 仅GET已登记分段UUID，不新上传、不制造逐字说话人归属 |

状态轮询仅在 API 可达性、接收状态、网关启动标识、能力、逻辑 revision 或阻塞原因变化时生成 `canbot.connection` 事件。帧计数、lastRx 和时间戳增加不会唤醒 Persona。命令响应生成 `canbot.command` 事件；`accepted` 仅表示 API 受理，`sent` 仅表示串口写入返回，`physicalCompletion` 始终为 `unknown`。逻辑修改产生 `canbot.program` 事件，其 `storageOutcome` 区分 committed、rejected、unknown。

程序最多 50 个、每个 32 步、每步等待 0–10000 ms、等待总和不超过 60000 ms。只接受预设动作名称和 waitMs；waitMs 不代表物理动作时长。当前没有程序运行工具。API 的参数、凭证与持久化契约见上级目录 `API-CONTRACT.md`。

World 停用只结束轮询与 HTTP 请求，不能证明物理停机，`shutdownVerification()` 返回 `unknown`。历史用户观察已确认前进宏两轮转动并在约3秒停止、头部宏涉及两个轴；这不替代新设备计时STOP接口的现场验收。World 不改写 Persona Memory。

`canbot_status.timedActions` 列出当前 allowed/blocked 状态。动作白名单为 head.nod/head.shake/head.look_right、leg.forward/leg.backward/leg.turn_left/leg.turn_right，配置可以进一步缩小；头部窗口100–12000ms，轮部100–3000ms，均为整数。它们是组合宏，不是独立电机角度或速度接口。运行时STOP回执可能为 reserved；stop_write_returned仍只表示串口写入。超时后只查同ID回执，不重发、换ID或改用旧接口。需要显式停止时，canbot_stop使用与动作不同的新requestId。设备计时器能跨客户端断线，不能跨进程/电源故障保证停机。

5810 API commissioning新增timedActions配置见 [HEAD-CHANNEL.md](HEAD-CHANNEL.md)，完整工程审计记录位于工程`docs/BOUNDED-MOTION-API-20261028.md`。World不读取设备串口凭据，模型不提交instanceId或epoch；这些由API在受理前新读状态取得。旧allowedActions可保持空，只开新的有界子集。程序CRUD仍不执行动作。

## 配置与安装

要求 Cortico World API 6、Node.js 22 或更新版本；已针对 5810 的 Cortico 0.2.8 核对接口。该包可作为本机扩展目录安装，无额外 npm 依赖。

```json
{
  "worlds": {
    "canbot": {
      "enabled": false,
      "apiBaseUrl": "http://127.0.0.1:7331",
      "pollIntervalMs": 5000,
      "requestTimeoutMs": 5000
    }
  }
}
```

配置项变化在 World 重启后生效。远程 API 地址要求 `CORTICO_CANBOT_API_TOKEN`，由 Cortico 的 `WorldContext.secret()` 读取；token 只放入 Authorization 请求头。API 若仅绑定 5810 回环地址，Windows 上的 Cortico 不能直接连接该地址，需要在同机运行或单独配置 SSH 转发。

在 Cortico 仓库执行 `node --import tsx scripts/extension-check.ts <本包绝对路径>`，只检查 manifest、构造与工具声明，不连接 API。之后可通过控制台扩展页选择本机目录安装；新扩展在 Cortico 进程重启后加载。检查通过不等于已经安装、挂载或真实控制机器人。

## 验证

在本包目录运行 `node --test tests/*.test.mjs`。52 项测试以假请求及临时本地 HTTP 服务验证状态变化去重、来源与原图字节保留、照片事件投递、存储失败不重复采集、上传认证、视觉回执、409 动作/停止拒绝、超时不重试、停用中断、逻辑 CRUD，以及长原文分片、回放标记、丢回执幂等、公开输出去重和接收器重启；包含有界动作窗口/名单、原ID只读回执、超时不重发、状态变化与自描述一致性，以及麦克风能力协商、默认/边界时长、旧媒体拒绝、最长录音收尾预算和照片/视频契约回归，以及cue能力协商、严格布尔值、单POST、未知/取消不重试、队列顺序和逐次刷新能力/sequence。它们不连接机器人。`node scripts/write-describe.mjs`只构造工具声明并同步describe.json，不启动World。

`scripts/native-image-proof.mjs FRAMEWORK_DIR BOT_ENTRY SAMPLE_JPEG REPORT_JSON` 针对 Cortico 0.2.8 执行本地兼容检查：读取未修改的实际 Bot 主会话声明，使用真实事件库、附件库、Session 和 Responses 序列化代码，核对 `external → external_event_frame → function_call_output.output/input_image`、原图字节一致和工具没有重复附图。采集边界使用本地 JPEG；Persona 的投递钩子未运行，不启动真实 Bot，不请求模型服务。该脚本使用此版本的内部投递方法，不是生产接入 API。旧 `native-user` 候选已撤回，未应用于主线。

事件瀑布需要 Android Avatar 0.2.0 或更新版本。开启 `headEnabled` 与 `timelineEnabled` 后，从 WorldHost.store 读取原事件文本，公开 assistant 输出来自 outputTap。不会为显示而再次 pushEvent 或调用模型。设备保留最近 512 个分片，屏幕最多排版 6000 行；这是显示窗口，完整历史仍以 Cortico 归档为准。历史记录标记 replay；没有新文本时不制造滚动内容。

同机运行 `node scripts/live-smoke.mjs` 可检查运行中的 API。脚本以独立测试宿主构造 World，仅 GET 状态、帧、动作列表和程序列表，要求 commissioning 未开放；不会发送停止、动作或存储修改请求，不会在 Cortico 正式挂载 World，也不会关闭 API。

