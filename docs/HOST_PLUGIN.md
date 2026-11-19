# @tina/dsh-plugin-cortico

> 把 Cortico 的 World 能力，挂到一个**已经在运行的 DSH 会话**上。  
> 不另起 DSH，不另起 Cordis，不复制第二套 AgentLoop。

- 包：`@tina/dsh-plugin-cortico`
- 版本：`0.2.0-fusion.9`
- 入口：`src/host-entry.mjs`
- 下载：[GitHub Releases](https://github.com/rtmhjx/tina-foundation/releases)
- 依赖：宿主已有的 DSH `0.1.5-rc.2` + Cordis `4.0.2`

## 1. 它是什么

这是一个 **DSH/Cordis 宿主插件**，不是独立应用。

```text
已有 DSH 会话（宿主）
  └─ @tina/dsh-plugin-cortico
       ├─ host-chat World      ← 把当前对话框包成一个 World
       ├─ Cortico Worlds       ← 工具 / 事件投影到 native Agent
       ├─ Prompt / History 路由
       └─ 可选：Self-Mem Persona
```

它复用宿主的：

- `SessionController` / `AgentLoop` / `Tools` / `LLM`
- 模型选择、审批、凭据、会话、附件
- 已有的 Cordis 插件树与生命周期

它**不包含**：

- DSH 运行时闭包
- 第二套 Cordis
- 第二个 AgentLoop
- 独立 Web 控制台（宿主 UI 就是界面）
- 真实记忆数据（默认 Persona 会新建自己的 state 目录）

## 2. 宿主必须满足什么

插件 `inject` 了 15 个服务：

```text
agentLoop  agents  sessions  sessionController  tools  llm  loader
settings  systemPrompt  agentDefaultModel  approval
credentialsController  sessionProjections  attachments
```

还要求这些版本化契约：

- `sessionController.hostRoutingVersion === 1`
- `sessionController.registerPromptRoute` / `registerHistoryPresentation`
- `agentLoop.registerRequestHead`
- `agentLoop.requestDeliveryVersion === 1`
- `agentLoop.requestPlanningVersion === 1`
- `tools.hasContentFinalizer`
- `session.externalEventVersion === 1`
- 目标 `sessionId` 已经加载，且处于 idle

缺任何一项，插件会拒绝挂载并返回 `HOST_CAPABILITY_MISSING`，不会偷偷替换宿主。

## 3. 安装与挂载

在宿主自己的插件目录里安装：

```bash
npm install ./tina-dsh-plugin-cortico-0.2.0-fusion.9.tgz
```

宿主用正常插件加载方式加载它，`main` 指向 `src/host-entry.mjs`。配置至少需要：

```json
{
  "sessionId": "<已加载的 DSH 会话 ID>",
  "stateDir": "C:/Tina/plugin-state"
}
```

- `stateDir` 必须与工作区分离，插件会拒绝包含/被包含的关系；
- 同一宿主同时只允许一个 active attachment；
- 挂载/卸载在会话 idle 边界进行，不抢正在跑的轮次。

## 4. 两种 Persona 模式

### 默认：带 Self-Mem

不传 `botDefinition` 时，插件会：

- 创建 `@tina/self-mem` Persona；
- 把 `host-chat` 作为唯一启用的 World；
- 关闭独立 console 与 memory ingress；
- 使用 `<stateDir>/self-mem` 作为记忆目录。

适合“我想在现有 DSH 对话框里继续拥有连续记忆”。

### 自带 Persona：不带 Self-Mem

传一个 `botDefinition`（Cortico API 7 的 Bot 定义）即可跳过 Self-Mem：

```js
await mountHostPlugin(ctx, {
  sessionId,
  stateDir,
  botDefinition: myMinimalBot,
});
```

此时插件只负责：

- `host-chat` World
- Cortico World 的工具/事件投影
- prompt / history 路由

记忆完全交给宿主自己。

## 5. World 兼容做到什么程度

| 能力 | 状态 |
| --- | --- |
| World 工具注册到 native Agent | ✅ |
| World 事件进入模型上下文 | ✅ |
| `host_chat_send` 向当前对话框发言 | ✅ |
| Prompt / History 路由 | ✅ |
| 审批与执行策略 | ✅ 沿用宿主 |
| Fusion Web 控制台 | ❌ 宿主 UI 替代 |
| World 自定义配置面板 | ❌ 宿主需自己渲染 |
| 第二套 AgentLoop | ❌ 明确不创建 |

## 6. 它不是什么

- **不是 Coopanion 成品**：Coopanion 是自带 Cortico 循环的 Electron 桌面应用，不走 DSH 宿主插件这条路。
- **不是通用聊天壳**：宿主必须是暴露上述服务的 DSH/Cordis 宿主。
- **不是“把 DSH 删掉”**：它借的就是宿主的 DSH；删掉 DSH 就没有执行内核。

## 7. 验证状态

- ✅ 源码静态检查、包构建、依赖闭包检查
- ✅ 与 `self-mem/` 源码同包构建
- ⏳ **未在真实 DSH 宿主上完成挂载验收**（当前公开环境没有可用的 0.1.5-rc.2 宿主）
- ⏳ 未做长期运行、World 面板、真实 Provider 往返验收

所以它是 **Preview**：接口和挂载契约还可能变，先在隔离宿主里试。

## 8. 许可

`AGPL-3.0-or-later`。Cortico、DSH、Cordis 的 MIT 许可与版权保留在包内 `LICENSE` / `THIRD-PARTY-NOTICES.md`。
