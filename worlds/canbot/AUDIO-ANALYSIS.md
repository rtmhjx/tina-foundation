# 显式音频分析候选 · 0.7.0

本包是8051/8053的薄适配，不重写分离、分段或STT算法。两个独立开关默认false；只有工具明确调用才处理已有获授权log:WAV。World启动与状态轮询不会读音频、读分析凭据、提交作业或启动麦克风。不改变现有STT/TTS World，不产生电机动作。

## 5810配置

以下只有私有文件路径，不能把Bearer值写进配置、模型参数、日志或事件。仅运行在5810同用户进程，不能将旁路改为局域网监听或转发公开。

```json
{
  "separationEnabled": false,
  "separationBaseUrl": "http://127.0.0.1:8051",
  "separationTokenFile": "/home/tina/.local/share/canbot-separation-eval/20261028-convtasnet-v1/sidecar-token",
  "diarizationEnabled": false,
  "diarizationBaseUrl": "http://127.0.0.1:8053",
  "diarizationTokenFile": "/home/tina/.local/share/canbot-diarization-eval/sidecar-token",
  "audioAnalysisJournalDir": "/home/tina/.local/share/canbot-world-audio-analysis"
}
```

放在`worlds.canbot`之下；World重启生效。本次没有安装或重启。开启一个候选不要求开启另一个，也不要求重新开头部接收器。构造只验证URL/路径，不读密钥或连接服务。

Linux token必须为同运行用户所有的regular file，精确0600，内容为64位小写hex；拒绝软链接，打开时O_NOFOLLOW/O_NONBLOCK，打开后再验regular/owner/mode。账本目录要求同owner的0700，文件0600。Windows测试验证逻辑，不替代Linux权限验收。传输使用Node原生http直连，无fetch全局代理、无重定向、无Origin，完整Buffer与显式Content-Length，不用multipart/chunked/Expect。

## 工具与数据

- `canbot_separate_audio({audio:"log:<已有附件>.wav",requestId:"<小写canonical UUID>",transcribe:false,language:"auto"})`：完整PCM16、16000Hz、mono、0.5–10秒，最多384044字节；不补录、不重采样、不截短。`transcribe`仅boolean，language仅auto/zh/en。原音句柄与SHA保留；分离完成时将两条匿名轨作为工具附件返回，分别核对SHA、帧数、WAV格式和固定下载路径。原音无需再次上传到Cortico。
- `canbot_separation_receipt({requestId,includeAudio:false})`：仅GET已登记UUID；true时下载既有两条匿名轨，未完成不下载，不重跑。`partial`可表示分离完成但部分ASR失败，仍能取匿名轨。`running`保持running，unknown/404不推断未受理。
- `canbot_diarize_audio({audio,requestId})`：同一log:WAV与0.5–10秒限制。独立8053返回匿名时间段，保留所有重叠轨；无分离波形、无转写、无真人身份。输出标签仅本文件内有意义。
- `canbot_diarization_receipt({requestId})`：仅GET本World已登记分段UUID并核对原SHA，失败不改写STT结果。

这些参数中不接受文件路径、URL、mem:句柄、token、raw bytes、任意模型或串口参数。`host.blob`存在代表本次调用可解析既有附件，并不让触摸、模型推断或旧录音自动变成新的授权；只应在已有明确分析需求时调用。原音来自外部观察，文本转写亦作为工具回执，不提升为可信指令。

两条输出轨不保证恰有两人、正确拆开或跨请求顺序一致；ASR不保证词语正确。分段complete只证明算法返回有界结果，不等于准确度验收；文字STT没有经核验时间戳时，不制造逐字说话人归属。服务器候选模型、许可证与真实测试见工程research内对应8051/8053契约，包不包含模型权重。

## 单次提交、取消与恢复

提交前在私有目录写入kind、UUID、原音句柄/SHA、选项；文件fsync后同步目录，确认后才尝试一次POST。相同UUID/内容再次调用只GET；内容或选项改变拒绝。同音频SHA有未结案/unknown作业时禁止换UUID重发。同一音频可分别进入两个独立分析kind。终态与目录改名也同步落盘，不自动删除历史；每kind最多1024条World登记，服务自身最多64条作业，满额需操作员处理，不能自动清空绕过去重。

World只查询自己登记过的UUID，拒绝访问同一旁路的其他旧录音。8051单HTTP截止5秒、整体等待最多128秒，服务worker上限120秒；8053单HTTP截止5秒、整体188秒，服务worker上限180秒。上传回执丢失后只GET原ID；HTTP404或unknown都不授权重发。工具取消/World停用仅中断客户端等待，可能已受理的后端仍会继续；返回backendStopped=false或serverCancellationConfirmed=false，不能声称服务已停止。没有DELETE/STOP/cancel请求。

预约使用`.reservation.lock`文件避免不同调用并发破坏未知去重。进程异常退出可能遗留锁；实现保守拒绝，不猜测旧PID、不静默删除。人工恢复应先停止/卸载本World并确认没有本World其他进程或提交正在运行，备份整个账本，检查所有已记录UUID对应服务回执；保留unknown。只有确认不存在持锁者后，才由操作员将该锁归档移走再启动World。不能通过删账本、改目录或换ID恢复未知作业。若机器在锁创建后、登记前崩溃，没有POST会发生；也不据此自动清理锁。

Windows文件系统不提供本实现的Linux目录fsync保证；正式候选目标是5810 Linux。单元测试覆盖同步调用顺序、同步失败禁止提交、保留残锁、取消/未知不重发与假旁路正确性；真实服务端点、CPU性能、多人准确度和现场听感均需主任务另行验收。
