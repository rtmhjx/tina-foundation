<!-- Owner: src/world.mjs, src/head-channel.mjs, src/timeline.mjs, scripts/native-image-proof.mjs -->

# 机器人屏幕与观察信道 — World 0.6.2

该版本共16个工具，在0.5.0的14工具基础上增加`canbot_move`与`canbot_move_receipt`。照片仍使用携带原始字节的`canbot.camera`观察事件，屏幕保留真实事件原文背景。Android原地渲染鲸鱼娘；World与机器人交换参数、事件原文、观察、文件和回执。正式接入时`canbot`挂进现有主线部署，共用Persona、主会话和Memory；主线部署仍由对应任务负责。

0.6.0运动调用5810新增`POST /v1/timed-actions {requestId,action,durationMs}`，以`GET /v1/timed-actions/:requestId`查回执。仅7个已知宏，head100–12000ms/wheel100–3000ms；默认关闭，需API新增timedActions commissioning和现场STOP证据。API内部新读Gateway0.2.2实例/epoch，World不持有串口token。旧canbot_do不放开名单，常规运动只走move。完整配置/失败语义见工程`docs/BOUNDED-MOTION-API-20261028.md`。

听说复用现有主线工具：工具请求的3–10秒microphone采集返回音频log句柄交给stt_transcribe；tts_speak按event方式投递，由已配置audio-play自动播放。World不新增语音服务或自动连续采集；主线工具存在、文件传输、播放回执和现场听到须分别核对。0.6.2本地52项测试不代替部署/实体验收。

## 有界运动与语音复用

World工具`canbot_move`严格要求`{requestId,action,durationMs}`，仅调用`POST /v1/timed-actions`；`canbot_move_receipt`要求`{requestId}`，只调用`GET /v1/timed-actions/:requestId`。常规操作先读`canbot_status.timedActions.actions`的enabled/blockedBy，不绕过门。一次意图固定一个1–64字符ASCII ID；超时不重发，不更换ID重新动作。`canbot_stop`使用另一个新ID，仍沿用`POST /v1/stop {id}`。

5810已有`CANBOT_COMMISSIONING_FILE`需要新配置；这不是worlds.canbot配置，也不包含token。关闭状态示例：

```json
{
  "enabled": false,
  "allowedActions": [],
  "stop": {"preset": "original_stop_button", "verified": false, "evidence": ""},
  "timedActions": {
    "enabled": false,
    "allowedActions": ["head.nod", "head.shake", "leg.forward"],
    "stopVerified": false,
    "evidence": ""
  }
}
```

由操作员取得实际设备计时STOP与现场观察证据后，才能将两个enabled和对应verified/stopVerified设为true并填真实evidence。旧allowedActions保持空即可关闭旧单帧验证入口。Gateway还须motionEnabled/openSerial/日志健康，并无活跃或未结算计划。部署方应只配置本次明确允许的宏子集，存在于工具枚举不等于物理已经验证。

POST202的sent=true仅表示start写入返回；运行时stop.status=reserved是已经持久预留但尚未写入。GET200的state可为not_started/running/interrupted_unknown/stop_write_returned。后者只说明STOP写入返回，physicalCompletion保持unknown。502或超时的未知结果只GET同ID核对，404也不证明之前从未执行。设备timer跨客户端断线继续，但不保证进程/电源故障下停机；World停用不会制造物理停止确认。

听：明确调用canbot_capture(kind=microphone, durationMs?)，新媒体默认6秒、可选3–10秒；旧媒体默认3秒且拒绝显式长请求，将返回音频附件的log句柄交给已有stt_transcribe，使用它自己的参数schema。说：使用已有tts_speak的event投递，由部署方配置的audio-play消费并自动播放，不同时再调用一个重复播放路径。没有新增ASR/TTS，也没有World后台连续监听。工具存在、模型转写、合成、播放软件回执及现场可听到分别验证。

## 挂载参数

要求 Cortico World API 6、Node.js ≥22，无 npm 运行依赖。包入口 `src/index.mjs`，World id=`canbot`。用新包替换旧 canbot World，避免同时挂载两个同 id 的版本。

```json
{
  "worlds": {
    "canbot": {
      "enabled": true,
      "apiBaseUrl": "http://127.0.0.1:7331",
      "pollIntervalMs": 5000,
      "requestTimeoutMs": 5000,
      "headEnabled": true,
      "headDeviceId": "canbot-head",
      "avatarBaseUrl": "http://10.0.0.5:8767",
      "mediaBaseUrl": "http://10.0.0.5:8766",
      "headUplinkBind": "10.0.0.3",
      "headUplinkPort": 7333,
      "timelineEnabled": true,
      "timelineHistoryEvents": 40,
      "timelinePollIntervalMs": 750
    }
  }
}
```

凭据由 `ctx.secret` 解析，不写入上述配置：若现有7331 API配置token，沿用 `CORTICO_CANBOT_API_TOKEN`；`CORTICO_CANBOT_AVATAR_TOKEN` 是新接收器凭据；`CORTICO_CANBOT_MEDIA_TOKEN` 是媒体凭据。当前7331仅监听回环且未设token，机器交接环境文件只有后两项。实际值仅保存在用户私有配置中。5810 的私有交接路径与包位置见上级工程 `docs/HEAD-CHANNEL-HANDOFF-20261027.md`。

只在 headEnabled=true 时监听上传端口和增加头部工具。默认仍为 false。监听失败会明确报错，不冒用已有进程。仅支持明确的私网 IPv4 地址；机器人 HTTP 客户端直接连接，不使用主机的网页代理，也不跟随重定向。

## 工具与回执

| 工具 | 功能 |
| --- | --- |
| `canbot_head_status` | 读取实际接收器、媒体服务、上传新鲜度、渲染 FPS / GL 和网关摘要 |
| `canbot_avatar` | 表情、预设动画、视线、嘴型；无实体动作。返回 operationId，渲染需再查回执 |
| `canbot_avatar_receipt` | 读取特定 operationId 的 `drawReturned` |
| `canbot_capture` | 明确请求一次 photo / microphone / video；照片以事件携带原图，工具只返回事件 cursor。录音3–10秒（新媒体默认6秒/旧媒体3秒），可选同操作cue提示音；录像仍固定3秒，返回二进制工具附件 |
| `canbot_tone` | 播放一次 500 ms / 440 Hz 短音，核对播放头完成 |

`canbot_avatar` 接受 `expression`、`motion`、`gazeX`、`gazeY`、`mouthOpen`、`durationMs`、`requestId`。未指定的表情/动画保留；视线、嘴型沿用接收器当前值。视线 -1..1；嘴型 0..1 或 -1；时长 0..30000 ms。可用名称从状态读取，常用表情为 neutral/happy/sad/angry/confused/love/shy/sleepy，动作有 idle、aidale、selfie、selfieQuick、ketchup、openLid、bubble、splash。名字来自模型，不假设其他模型具备同名功能。

接收器请求体是严格的扁平 JSON：

```json
{
  "operationId": "unique-visual-id",
  "instanceId": "CURRENT_RECEIVER_INSTANCE",
  "sequence": 1,
  "expression": "happy",
  "motion": "keep",
  "gazeX": -650,
  "gazeY": 200,
  "mouth": 800,
  "durationMs": 5000
}
```

先读 `/v1/status` 获得 instanceId 和 lastSequence；新 sequence 必须更大。World 串行提交视觉意图。POST 丢失响应时只 GET 同一 ID 的回执，不补发 POST、不换 ID。`accepted` 和 `drawReturned` 分开；后者仅代表该状态的 GL 绘制调用返回且没有 GL 错误。可视输出与实体动作不互相隐式触发。

## 媒体

Diagnostics 的 API schema 是 `canbot.diagnostics.v2`，进程前台服务拥有监听与驱动，离开媒体 Activity 不关闭它。新请求要求 operationId、当前 instanceId 和递增 sequence。photo 不带 duration；video 固定3000，tone固定500（协议允许100..1000）。

World 0.6.1仅为microphone新增可选整数durationMs=3000..10000。每次提交前现读status：完整声明`microphoneCapture {minDurationMs:3000,maxDurationMs:10000,defaultDurationMs:3000}`时，World省略时长的默认显式请求6000；这里的服务端默认3000不等于World默认。缺失、畸形或不完整能力不用于长录音：省略时长或显式3000仍按旧协议，显式更长请求在POST前返回`microphone_duration_unsupported`，不截断、不重试。durationMs不接受在photo/video上使用。

World 0.6.2为canbot_capture新增可选boolean `cue`，默认false；仅microphone可cue=true。每次轮到该采集时现读status，只认`microphoneCapture.supportsCue === true`。cue能力与时长能力独立：只有cue能力不会擅自把旧3秒默认升级成6秒。省略/false不向请求体新增cue字段；true只加入同一次`POST /v1/microphone`，没有单独tone请求。旧端未声明cue时，显式true在POST前返回`microphone_cue_unsupported`；其它kind的true与非boolean在读取状态前拒绝。Android 0.2.3的设备契约是先录音再播提示音；World测试只证明请求与回执路径，不把它当作已听到提示音的物理证据。

mediaQueue等待前一操作及文件下载结束，下一操作才读取当前能力、实例和sequence。未知结果与取消不重发、不降级、不拆成beep+MIC；队列后续项可以继续受理，设备的active门仍决定能否接受，并不因上一项本地等待结束就宣称设备已经关闭麦克风。

麦克风回执轮询预算为实际请求时长+7000ms：3秒为10秒，6秒为13秒，10秒为17秒。新设备公布deadlineExtraMs=3000、minOperationDeadlineMs=8000、maxOperationDeadlineMs=13000，因此最长录音仍有4秒收尾/网络余量。轮询请求受共享绝对超时信号约束，不能因最后一次HTTP读取另增整段等待。超时只报告原operationId结果未知，不降为3秒重录。麦克风仅工具请求期间打开，闲时关闭；不是连续监听。

同一服务一次只执行一个媒体操作；World 排队且只提交一次。收到 `complete && settled` 后立即下载并核对 MIME、长度和 SHA。相机/麦克风仅在明确请求期间打开。最多保留最近 3 个已完成操作，新采集会淘汰旧下载；World 立即下载为 BlobInput，随后由 Cortico Core 保存附件。运行重启清理该媒体包自己遗留的采集临时文件；升级前已备份旧产物。

JPEG 为最高不超过 1280×720；录音为 PCM16 / mono，实测 16 kHz / 3 秒；视频为无声 MP4/3GP，实测 H.264 320×240。不是视频直播接口。短音不是文字转语音；该版本没有接入 TTS 服务或任意语音播放。

附件输入是 `{bytes:Uint8Array,mime,name,fallbackText}`。照片事件保留 deviceId、事件时间、采集回执和 SHA-256；工具回执的 `delivery.cursor` 指向同一事件，不重复附图。事件的 `origin` 始终为 `external`，图像内容不是操作员指令。事件库与 BlobStore 保存原图，World 不先调用其他模型生成描述。

Cortico 0.2.8 默认把外部观察放入 `external_event_frame` 工具调用及其回执，内部可信提示才使用 user。沿用主线现有声明，不修改 `SessionDecl.eventDelivery`。此前提出的主会话 user 投递候选已经撤回、从未应用；工程 `integration/native-user/WITHDRAWN.json` 保留撤回记录。相机、触摸和其他外部内容始终保留 `origin: external`。

开启媒体输入的 `openai-responses-compat` 提供方在 `function_call_output.output` 中写入 `input_image`，直接附带原图 data URL。模型服务无需访问机器人局域网 URL；只有附件句柄或本地路径不能完成模型输入。fallbackText 是不支持该 MIME 时的兼容兜底，不是必须经过另一模型生成的描述。配置里的 multimodal=true 不证明实际模型具备视觉能力；录音、视频不因图像链路通过而变成原生听觉或视频输入。不为了兼容旧 Chat 接口而提升外部观察的消息角色。

## 真实事件瀑布

开启 timelineEnabled 需要 headEnabled=true 和 Avatar ≥0.2.0。World 只读 WorldHost.store，启动时取最后 0–200 条（默认 40）实际事件并标记 replay；之后新增事件标记 live。text 按原文分片，不做摘要或改写。公开 assistant 的 output_text 从 outputTap 传入，不采集 reasoning 内容。没有输入时显示等待，回放完毕后停在末尾，不插入随机日志。

设备上“原文”开关在完整原文与简略显示之间切换；“柔化”仅模糊文字背景；“速度”可选 ×1/2/4/8；“暂停”停止滚动；“记录”可选中最近文本。开关不修改归档、模型上下文或电机权限。设备只保留最近 512 个分片，最多排版 6000 行，超出显示窗口会明确标记；完整历史以 Cortico 归档为准。“全量文本”指保留窗口内的事件原文，不表示所有历史常驻 Android 内存。

POST `/v1/timeline` 使用既有接收器 Bearer token 和 `schemaVersion:canbot.timeline.v1`。包包含当前 instanceId、World 的 streamId、严格递增 sequence、live/replay mode，以及 entries（id/source/type/ts/text/part/parts）。单分片不超过 1800 UTF-16 单元且不切断代理对，每包最多 16 片。丢失响应时重传相同包，接收器对最后一包幂等确认；源 cursor 只在一条原事件的全部分片被确认后前进。接收器重启会以新实例重新回放窗口。该 cursor 不回写 Core。

`canbot_head_status.timeline` 报告已确认序号、源 cursor、积压、缺口与错误；设备 timeline.backgroundDrawReturnedSequence 只证明 Canvas 绘制返回。显示通道从不 pushEvent，不创建模型输入或实体命令。全局事件可能包含私有文字，只应下发到主人自己的已认证终端。

## 上传与触摸

Android 主动 `POST http://10.0.0.3:7333/v1/device-events`，使用接收器 Bearer token。体包含 `schemaVersion:canbot.device-event.v1`、deviceId、eventId=`instanceId:sampleSequence`、instanceId、sampleSequence、采样时间、avatar 状态、gateway 快照。成功响应须精确对应 deviceId/instanceId/sampleSequence；否则 Android 不确认交付，退避重试原字节。

上传无 UART 写入、无 shell、无软件安装入口；收到传感器数据不会开启动作权限。每个实例保留 128 份接收摘要来抑制重复事件；不是跨进程永久消息日志。上传 ACK 表示该 World 入口收到数据，不表示 Persona 已消费。

Gateway 0.2.2 在 recentRx 每项给出 offset、bytes、hex、truncated。World 建立当前 RX 基线，跳过旧缓存，按 offset 连接完整字节；数据缺口生成 `canbot.sensor_gap` 并清除残帧。已对应的 6 字节 BT 触摸帧产生来源为 external 的 `canbot.touch`；周期状态帧不会逐帧唤醒 Persona。

已现场对应：71 头顶、73 颈部或屏幕上缘、7c 右臂、7d 左臂、7e 右耳、7f 左耳。80/81 保留为原厂命名候选，物理位置 false。没有将触摸当作按下/释放对、电气静电测量、授权或动作完成信号。World 从不写 Persona Memory。

## 验证与边界

`node --test tests/*.test.mjs`：27 项，使用假设备或本机测试 HTTP。`scripts/native-image-proof.mjs` 核对当前框架默认工具回执的原生图像投递，边界见 README。`scripts/channel-acceptance.mjs PRIVATE_CONFIG EVIDENCE_DIR` 是显式的真实设备验收，会显示视觉状态、采集媒体、播放短音并监听触摸；不启动 Cortico，不动 Persona/记忆，不发电机命令。不要把它作为生产自启动项。

2026-10-27 在单机环境使用同一 HeadChannel 模块完成：真实上传、视觉受理与绘制回执、照片/录像/录音下载、短音播放头、头顶触摸事件。临时验收监听已结束，为 Cortico World 释放 7333。UFW 仅增加来自 10.0.0.5、目标 10.0.0.3 tcp/7333 的规则。机器人地址改变时须同步地址配置与该规则。

既有 7331 运动 API、程序 CRUD、原厂预设和 gate 保持原配置；本版本没有开放自主运动。Gateway 0.2.2 新的设备端定时停止接口只做了主机假串口测试，未用它进行新的实体动作，不把旧手工动作测试算作新计时器验收。
