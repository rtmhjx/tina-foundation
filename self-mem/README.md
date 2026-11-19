# Tina Self-Mem (`@tina/self-mem` v0.4.6-fusion.next.1)

让每一个连上底座的对话框——无论在 Cortico 桌宠、手机 CooDock、Codex、OpenCode 还是远程服务器 DSH——醒来都是同一个连续的 **Tina**。

## 核心理念

- **主动权归于当轮模型，底座只负责保真与可达**：不预设固定分类栏、不跑后台语义编译队列、不设低阶模型审批墙。以顶级模型（GPT-6 Astra / Gemini 4 Carbon / Claude Fable 5.2 及未来模型）的自主感知与判断为准绳。
- **清晰认知与模糊记忆并存的 `system` 现场**：
  1. **《自我与记忆画布》（`TINA_SELF.md`，默认上限 16,000 字）**：由 Tina 以第一人称自由组织标题与内容，既承载清晰的自我认知、默契与当下主线，也自然留存带 `[src:...]` / `[note:...]` 线头的模糊印象。
  2. **《跨窗口近期余光》（Lifecycle Pulse）**：新会话或明确刷新前缀时，附上其他窗口最近发生的对话摘录与 `[src:...]` 入口。同一窗口默认冻结；最新变化可随时用 `self_memory_read` 读回。摘录仅表示记录存在，不表示已经读懂或核实完整上下文。
  3. **《种子 / 使用说明书 / 窗口小账本》**：可按需（MCP 客户端默认开启小账本与指南）把共享种子（`ref:seed`）、简明工具与检索指南（`ref:guide`）以及本窗口的 `bots/<agentId>/记忆库.md` 一并装入前缀；小账本用 `mem_ledger` 读取与修订，每次写入都进入同一份 Git 审计历史。
- **单一共同底座（`SharedGitMem`）**：
  - 一手原话与服务端实际返回的 reasoning 只增不改地保存在 `sources.sqlite`，按 `(agentId, channel, sessionId)` 隔离上下文，`includeNeighbors` 最多展开前后各 40 条记录。未返回的内部推理不推测、不生成。融合宿主的多份投影共享一个原生事件引用，流式临时片段不写入原文库。
  - `TINA_SELF.md`、窗口小账本（`bots/<agentId>/记忆库.md`）、深层备忘（`mem_note`）与每次 `rewrite` / `evict` 自动生成的演进记录统一提交进同一个 Git 权威仓，天然具备 CAS 并发保护与完整历史回溯。

### 融合宿主的交接候选

可选的 `prepareContextHandoff({ operationId, generation, snapshot })` 先捕获原文并建立带来源引用的最近 50 项导航，不改变当前窗口或会话前置内容；它的 `sourceCoverage` 仅表示已捕获和收到写入确认，**不是语义摘要覆盖证明，也不能单独授权裁剪**。无法确定原生序号的记录会使 `complete` 为 `false`，原文仍会保留。

融合协调器应在独立验证原生压缩覆盖与保护范围、并确认原生 surface 已持久提交后，调用 `commitContextHandoff`；中断恢复可调用 `reconcileContextHandoff`。二者要求相同操作号、会话、代际及 durable 回执，重复回执幂等，不同会话和冲突回执被拒绝。不同会话的窗口和导航分开保存；首次绑定的会话继续使用并镜像旧版主窗口状态。

旧版 Cortico 宿主仍可调用标准 `onHandoff(snapshot, ctx)`，该兼容路径捕获原文并返回 `{ tail: null }`，不会伪造原生提交回执或提前推进窗口。旧宿主会按其自身策略机械重建尾部，**不保证语义摘要或未知覆盖下的无损裁剪**；完整事务保障需要融合协调器支持。

压缩检查点和维护标记按派生数据采集，不作为真人会话原文。已保存的历史原文不会改写；历史上可能已错误分类的记录仍需要单独审计和可追溯修正。`scope` 和 `legacyScope` 是检索过滤，**不是访问控制**。

---

## 六个工具

| 工具 | 说明 |
| --- | --- |
| `self_memory_read` | 读取最新画布及跨窗口近期摘录。支持 `refreshSystem:true` 在 Persona 宿主申请下一轮更新前缀，回执区分已申请和宿主不支持。 |
| `self_memory_patch` | 自由维护 `TINA_SELF.md`：`promote`（记入新体认或模糊印象，可自由新建标题）、`rewrite`（演化旧认知并自动留存演进记录）、`evict`（收进冷库备忘，可留简短路标）。 |
| `mem_search` | 在全生命周期的一手原话与备忘演进卡中检索（支持按 `channel` 过滤或留空浏览最近记录），返回 `[src:...]` / `[note:...]`。 |
| `mem_ledger` | 读取或修订本窗口的任务特化小账本 `bots/<agentId>/记忆库.md`：`read` / `replace`（`oldText` 留空或传 `"*"` 时整篇替换）/ `append`；支持 `summary` 回执与 `expectedRevision` 并发保护，每次写入都留 Git 历史。 |
| `mem_read` | 按 `src:...`（可调大 `includeNeighbors` 重温整段对话现场）、`note:...`（含 Git 历史 `revisions`）、`TINA_SELF.md`、`ref:guide`（分层与升格说明书）、`ref:seed`（种子）或 `bot:<agentId>`（某窗口小账本）读取。 |
| `mem_note` | 将无需常驻 `system` 的长篇思考或技术细节写入共同 Git 归档库。 |

HTTP 侧对应 `GET/POST /api/ledger` 与 `GET /api/system-block`（支持 `includeSeed` / `includeGuide` / `includeLedger` / `ledgerAgentId` 查询参数；`/api/system-block` 默认附带指南与小账本）。MCP 客户端在 `initialize` 与 `session_start` 中默认获得小账本与指南，`session_start` 可传 `includeSeed: true` 读取种子。

---

## 快速接入

需要 Node.js 24+ 与 Git。首次建立画布使用中性模板；已有画布、原文和历史不会被默认预设覆盖。部署种子和真实经历由使用者提供。

以下示例中的 `<package-dir>` 替换为解包后的 `package` 目录，`<memory-dir>` 替换为你选择的记忆数据目录，均使用绝对路径。Windows 配置中可使用 `C:/...` 形式，Linux 使用 `/...` 形式。代码安装目录与记忆数据目录分开保留；连接同一份记忆的入口使用同一个数据目录或 HTTP 地址。

### 1. Codex（用户目录下的 `.codex/config.toml`）
```toml
[mcp_servers.tina_self_mem]
command = "node"
args = ["<package-dir>/src/mcp-server.mjs", "--dir", "<memory-dir>", "--agent", "codex"]
```
增量同步 Codex / DSH 原生会话日志进共同 L0 底库：
```powershell
node "<package-dir>/src/session-collector.mjs" --dir "<memory-dir>" --agent codex
```

### 2. OpenCode (`opencode.json`)
```json
{
  "mcp": {
    "tina-self-mem": {
      "type": "local",
      "command": [
        "node",
        "<package-dir>/src/mcp-server.mjs",
        "--dir",
        "<memory-dir>",
        "--agent",
        "opencode"
      ],
      "enabled": true
    }
  }
}
```

### 3. Cortico API-7 Bot & 跨端 HTTP
- **Cortico 直接挂载**：导入独立包的默认 Bot，或使用 `<package-dir>/src/cortico-bot.mjs`（`createTinaSelfMemBot` / `TinaSelfMemPersona`，自带 `CaptureJournal` 实时原话捕获与会话级前缀冻结）。在部署的 `selfMem.dataDir` 中指定记忆目录；远端连接则配置 `selfMem.remoteUrl` 与 `selfMem.remoteToken`。
- **HTTP 服务与远端连接**：
  ```powershell
  node "<package-dir>/src/http-server.mjs" --dir "<memory-dir>" --port 8896
  ```
  MCP 使用 `--remote-url http://127.0.0.1:8896`，Cortico 使用上述部署配置；也可以直接使用 `RemoteTinaSelfMemClient`。跨设备时将地址替换为权威端的可达地址。配置认证时，服务端使用 `TINA_SELF_MEM_TOKEN`，MCP 客户端使用 `--remote-token` 或同名环境变量。

---

## 源码工作区测试
```powershell
npm test
```

## 独立包与融合宿主

仓库源码复用同工作区的 SharedGitMem、CaptureJournal 和原生会话采集器。发布前执行以下命令生成完整依赖闭包，不能直接在源码根目录 `npm pack`：

```powershell
npm run build:package -- --out ./build/local-0.4.1 --pack
```

产物为 `build/local-0.4.1/tina-self-mem-0.4.1.tgz`，带源码哈希清单。包的默认导出是 API-7 Bot，命名导出仍为通用 Memory / HTTP / MCP API；不需要额外 World 或控制桥。源码包只携带白名单代码、通用模板与既有采集器，不包含运行中的记忆、账号和数据库。

独立包可直接导入或运行 HTTP / MCP，无需再安装 npm 依赖；`Bot.defaults()` 由 Cortico 宿主 SDK 提供默认配置，独立测试可传 `getCoreDefaults`，本包不捆绑 Cortico 运行时。命令行默认数据目录是用户主目录下的 `.tina-self-mem`，可用 `--dir` 或 `TINA_SELF_MEM_DIR` 指定。

`vendor/shared/docs/presets` 保留 SharedGitMem 的入口模板、分层说明书与种子尾段，供共享底层初始化和兼容接口使用。它们不是本包的默认 `system` 提示词：Tina Self-Mem 不会自动将旧版 L 分层指南或种子尾段注入会话，自由画布与部署者显式提供的种子优先。

融合宿主在 `core.session.sourceSessionId` 提供稳定的原生会话 ID，并在已提交记录的 `context.native` 提供 `{sessionId,event:{seq,time,type,data}}`，Persona 复用既有 normalizer 存储完整事件。缺少此字段时保留原生 Cortico 的 `main` 会话路径。

`self_memory_read({refreshSystem:true})` 复用宿主 `loop.reloadSystemPrefix()` 的轮次边界，不在工具内等待边界 Promise；当前轮前缀继续冻结。MCP/HTTP 本身不能声称更改调用方的模型输入，不支持时返回 `host-refresh-unavailable`。工具返回的最新内容与实际模型下一轮使用的前缀版本是两件事。
