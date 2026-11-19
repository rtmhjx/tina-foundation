<!-- Owner: src/world.mjs, src/store.mjs -->

# 主从事件联络 World

World API 6，Node 24，无第三方运行依赖。两个部署各挂一份，`lane`、端口与数据目录独立，`peers` 指向同机另一份 World 的 loopback HTTP 地址，共用私密令牌变量 `CORTICO_TINALINK_TOKEN`。

普通增量使用 `piggyback` 入队，不启动模型；达到 `batchSize` 或收到显式唤醒、`needs_user_action` 时，通过 Core 的 `promotePending` 放行。Core 的暂停与投递闸门仍有效。已有输入自然唤醒时，一并带入积压事件。

发送前写持久 outbox；传输失败由纯代码重试，稳定事件 ID、时间和原文保持不变。收件箱保存来源引用并拒绝同 ID 不同内容。收到、投递、实际完成与人类已读分别记录。World 不写 Persona Memory、不另开模型。

配置示例：

```json
{"enabled":true,"lane":"main","port":7801,"tokenSecret":"CORTICO_TINALINK_TOKEN","batchSize":6,"peers":{"dsh":"http://127.0.0.1:7802"}}
```

DSH 路使用 `lane:dsh`、端口 7802、peer `main:http://127.0.0.1:7801`。工具是 `tinalink_send` 与 `tinalink_recent`，HTTP 仅接受 loopback 与部署令牌。

验证：`npm test`。测试覆盖静默积累、阈值唤醒、显式唤醒、幂等冲突、恢复、持久 outbox、来源和认证。
