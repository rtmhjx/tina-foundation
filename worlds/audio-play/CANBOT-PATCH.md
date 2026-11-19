# CANBOT audio-play 最小适配

版本 `0.4.0-canbot.1`；上游 `cortico-world-audio-play@0.4.0`，MIT。包名、World ID `audio-play` 和 Cortico API 6 保持不变，无新增运行时依赖。原件位于 `research/world/upstream/cortico-world-audio-play-0.4.0/package`，未修改。

上游仓库：<https://github.com/AqualCross/cortico-world-audio-play>；固定 gitHead `88d0b49272e0cdeb6c5abac910b700068b8bf8dc`；原 npm tar SHA256 `5084951ff068e709ca3fe9bb6b22a7e37ca2df136dfb41f581fbc92e376874c0`。这些是已有本地来源记录，本轮未联网刷新。

## 适配契约

- 仅 custom backend 为子进程退出码 **76** 启用特殊语义：`PlaybackError.code=outcome_unknown`，即使先发生 abort 或 timeout 也保留它。其他播放器不启用该退出码特例。
- helper 的未知退出不是成功，也不是已确认取消；不解析或回传 helper 原始 stdout/stderr 作为未知错误正文，不自动重试上传。
- `skip`、`clear` 对当前项只返回 `cancel_requested`。子进程 `close` 前队列不推进。
- 未知结果通过原有 `audio-play.failed` 事件发出，附 `meta.code=outcome_unknown`、`settled=false`、`retryAutomatically=false`。该结果不会被普通取消、World 停止或事件自动播放冷却吞掉。普通取消、普通失败以及其他 backend 的行为保持原样。
- 未知子进程退出后队列仍会处理后续条目；此补丁没有添加远端锁或重新上传。设备端独占 active 检查依然是拒绝重叠的边界。不要把退出事件解释成物理停止。

## 离线测试

运行 `node --test tests/canbot-cancellation.test.mjs`，不安装依赖，不读取凭据，无 HTTP/网络/媒体/设备操作。fixture 是一个真实 Node 子进程，只写临时标志文件并按约定退出。

Windows 本地结果：8 项中 **7 PASS、1 SKIP**。已通过真实子进程退出 76、普通成功/失败、abort 优先分支、clear 队列、普通取消静默、World 关闭期间未知事件以及描述一致性。可移植 abort 分支用 mock 拦住 OS kill，同时让真实子进程退出 76；它不冒充实际 POSIX 信号验收。

真正 `SIGTERM → handler → exit 76 → audio-play.failed` 用例只在 POSIX 系统执行，并检查子进程退出前下一项尚未启动。Windows Node 的 `kill(SIGTERM)` 强制结束子进程，不能执行 POSIX handler，所以明确跳过。本机未提供可用 WSL；没有安装环境或远程执行。主任务需在 Linux 上运行同一测试完成该项，预期 **8/8 PASS**，之后再报告 Linux 实测结果。

`PATCH.diff` 只记录对上游已有文件的修改；新增测试和交接文件由 `SOURCE-HASHES.json` 列出。该清单同时保留上游文件 SHA256，排除自身以避免循环哈希。包 SHA256 在交付目录的旁文件记录。

## 交付边界

本目录及归档是本地构建交付。正式安装、真实 helper、机器人播放可听性与取消停止验收由主任务负责，未由这里执行。helper 必须遵守退出 0=已验证软件播放完成、76=结算未知的约定；普通已确认取消可用 130。本包不保存或携带机器人 token。
