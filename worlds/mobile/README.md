# Tina 手机通道 World v0.1.1

0.1.1 增加来源明确的图片与语音附件、按需读取以及 `mobile_send_media`。旧数据库只新增媒体表；媒体、消息与 feed 一起提交，失败时回滚。主 App 的文字发送流程与此前版本一致。

这是可独立安装的 Cortico World API 6 扩展。第一阶段由服务器上的 Tina 处理手机对话；Android 保存原文和待发消息，并轮询取得服务端回复、状态和有来源的外部事实。这个包不改 Cortico 核心，不迁移旧手机记忆库，不启动另一个模型，不安装 DSH/Codex，不做蒸馏。

运行要求：Node.js 24 或以上，提供 World API 6 的 Cortico（本次对照检出的 Cortico 0.2.3）。运行时无第三方 npm 依赖。SQLite 使用 Node 内置 `node:sqlite`。

## 安装与连接

1. 将本目录完整复制到 Linux，例如 `/srv/tina-mobile/world`。在 Cortico WebUI 的「扩展 → World」中选择本机目录安装。源码与 `ENV_PROMPT.md`、`describe.json` 均须保留。可以先在 Cortico 仓库运行 `pnpm check:extension /srv/tina-mobile/world`；此检查不会启动 World 或调用模型。
2. 在目标 Cortico **部署**的密钥设置或私密 `.env` 中配置 `TINA_MOBILE_TOKEN`。令牌由部署 `ctx.secret('TINA_MOBILE_TOKEN')` 取得；包中没有真实密钥。Android 填入同一个令牌。密钥变更后重启 World。
3. 将 [examples/world-config.json](examples/world-config.json) 合并到该部署的 `config.json`，或在 World 页配置 `mobile`。不要覆盖其他配置。重新启动/挂载该 World；默认监听 `127.0.0.1:7799`。
4. 通过已有 VPN/反向代理将手机流量送到该地址。若现有 VPN 直接访问服务器接口，可将 `host` 设为服务器 **VPN 接口地址**。`127.0.0.1` 只接受本机连接，手机不能直接连接服务器的 loopback。
5. Android 中填写能实际到达的基础 URL 和令牌；连接检测调用 `/v1/health`。这只证明通道正常；真正的模型回复仍须在该 Cortico 会话中调用 `mobile_reply`。

可选命令行安装方式遵循 Cortico 官方扩展文档：在该 Cortico 的独立 `extensions/` 目录中运行 `corepack pnpm add /srv/tina-mobile/world`，然后重启。已有扩展目录和 workspace 文件由该部署维护，不在此包里生成或覆盖。

本 World 的固定 ID 是 `mobile`。同一部署已有同 ID 的 World 时不能同时挂载，需选择一个；不同部署使用各自的数据目录和监听端口。

## 流程与状态的准确含义

```text
Android 原文 / 待发箱
    → POST /v1/messages
    → SQLite 同一事务保存原文 + user_message feed
    → host.pushEvent(external, trigger=flush)
    → Cortico 会话收到 mobile.message
    → Tina 调用 mobile_reply
    → SQLite 保存完整回复 + assistant_message feed
    → Android GET /v1/feed 拉取
```

接收后先保存再推送。成功 HTTP 接收返回 `accepted`，不是模型已读。只有 Cortico 的 `onEventsSettled(..., 'delivered')` 通知事件已写入主会话后，才生成 `message_state: delivered`。这仍不证明模型理解或人类阅读。操作者清空队列则记录 `discarded`；不会自动复活/重投该输入。相同输入 ID 的 HTTP 重试不能制造第二次唤醒。

`mobile_reply` 必须携带确切的 `device_id`、`in_reply_to`。回复 ID 从真实工具调用的 `callId`、部署目录与 role 生成，因此同次工具调用的重试只写入一次；同 ID 改了正文则冲突，不静默覆盖。回复持久化只代表 `queued_for_phone`，不代表手机已收到或已读。普通 assistant 正文不会自动转发到手机。

World 重启时，会补推已保存而尚未写入 Cortico 事件库的输入。若 Cortico 已保存事件、但 World 在写本地 cursor 前退出，则通过 `senderKey` 在 `host.store` 找回原事件，避免再唤醒一次。`delivered` 回调本身若在崩溃时丢失，状态保持保守的 `accepted`；不会据此猜测已读。

若 Core 明确返回 `contextDelivery:'archive-only'`（例如通道被隐藏，仅归档而不进入对话），立即记录 `discarded` 及说明，保留原文且不重唤醒。恢复时若查回的旧记录没有该属性，也没有 settled 证据，则保持 `accepted` 表示投递结果未知，不猜测 `delivered` 或 `discarded`。

当前一条输入正等待写入 host 时，新输入会合并为一次待处理信号；本次写入结束后立即继续，不等待重试计时器。失败条目本身不会造成无限即时重试；停用后也不会重新启动分发。

## HTTP 协议 `tina-mobile/1`

所有 `/v1` 路由都需要请求头 `Authorization: Bearer <部署令牌>`，包括 health。POST 使用 JSON。输入 ID 必须跨重试稳定；同 ID 不同内容返回 HTTP 409。日期保留调用方原始时间戳，feed 顺序按服务端 SQLite `seq`，不依赖设备时钟排序。

| 路由 | 用途与结果 |
| --- | --- |
| `GET /v1/health` | `{protocol:'tina-mobile/1', server_id, ok:true}`。server_id 在该 World 数据库中稳定保存。 |
| `POST /v1/messages` | 输入 `{id, device_id, text, created_at}`；返回 `{id, state:'accepted'\|'delivered', server_seq}`。首次 201，幂等重试 200。 |
| `POST /v1/facts` | 输入 `{id, device_id, text, created_at, source_ref}`，source_ref 必填；返回 `{id,state:'stored',server_seq}`。仅静默存储，**不会触发模型**。 |
| `GET /v1/feed?device_id=X&after=N&limit=100` | `{server_id,items,next_cursor,has_more}`。仅该 device_id、严格 seq 升序、limit 范围 1–100。无新条目时 cursor 不倒退。 |
| `GET /v1/source?id=...` | 返回 `{server_id,record,external_source_retrieved:false}`。record 是本 World 保存的原文；外部 fact 的 source_ref 仅为指针，未替你读取外部源头。 |

feed 条目统一包含 `seq,id,device_id,kind,text,created_at`；按条目类型可含 `source_ref,in_reply_to,state`。kind 为 `user_message`、`assistant_message`、`message_state`、`fact`。状态条目正文通常为空，明确仅归档时可携带说明，`in_reply_to` 指向原手机消息。server_seq 是首次创建原条目的 feed 序号。

当原消息被 `discarded` 后重试 POST，仍返回历史接收语义的 `accepted`，但不重入队；以 feed 中的 `discarded` 状态为准。要重新发出新输入，应由用户显式产生新消息 ID。

`device_id` 是通道分流键；一个令牌代表一个可信部署，各端共享令牌可以查询指定通道。这里没有把 device_id 伪装为独立账号认证。多个手机身份需由部署分开令牌/通道，后续再扩展协议。

## 数据和可替换边界

- 数据库：`<该部署 dataDir>/mobile.sqlite`，含 WAL。停机后整体备份；运行时由 SQLite 一致性备份能力处理，不能单拷主文件当作完整备份。
- `records` 保存原始手机输入、原始工具回复和有来源 fact，正文不被覆盖；`feed` 追加可拉取的消息/状态。唯一状态变化是输入的投递状态和 Cortico cursor。
- fact 不会被自动转换为主人事实，不会重复摘要或触发第二个模型。它由既有 Cortico/DSH 汇总发布，手机只显示保存的正文和来源。
- 本次不提供音频上传/TTS、后台常驻通知、移动端模型循环、全记忆查询或端侧控制；后续可在稳定消息通道上接入。
- 停用 World 会关闭 HTTP listener、清理重试计时器、等候当前入队操作并关闭数据库；不改其他 World、已有会话或模型设置。

## 验证

```bash
cd /srv/tina-mobile/world
npm test
npm run check
```

测试使用临时 SQLite、内存假 host 和本地临时 HTTP 端口；不会连接真实 Cortico、调用模型、读取个人凭据或产生假生产回复。覆盖认证、消息幂等与冲突、delivered/discarded、fact 静默保存、设备隔离与稳定分页、原文读取、工具重试、事务回滚、重启补投与端口释放。

源码交付与本地协议验证不等于已正式挂载、真实 LLM 往返、手机实装或长期稳定性验收。生产中只有真实 `mobile_reply` 工具调用才能形成 assistant_message。

官方机制参考：[Cortico 扩展安装](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md)、[World 契约](https://github.com/Pal-AI-Lab/Cortico/blob/main/src/core/types.ts)。本包 MIT。
