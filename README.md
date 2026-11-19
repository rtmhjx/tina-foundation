# Tina Foundation

> 一个把「人格、记忆、世界」装进同一条原生 Agent 运行时的底座。

**Tina** 是一套持续存在的个人 Agent 运行时：它不把对话当成一次性请求，而是把每一轮原话、每一次上下文压缩、每一份自我认知都记录在可追溯的存储里；下一次醒来时，人格与记忆仍然连续。

这个仓库是 Tina 在 2026-11 的**运行底座公开版**：融合宿主、记忆引擎、世界扩展与部署文档。原始记忆内容、人格提示词与凭据不在仓库内。

> 展示页：<https://rtmhjx.github.io/tina-foundation/> · 仓库：<https://github.com/rtmhjx/tina-foundation>

> **Windows 预览。** Windows 10/11 的 PowerShell 安装、启动与计划任务脚本在 `windows` 分支；尚未完成端到端验收，请先读 [`docs/WINDOWS.md`](docs/WINDOWS.md)。

```
Cordis / DSH 原生循环  ─┐
Cortico Bot / World    ─┼─►  Tina Fusion Host  ─►  Web / Mobile / TTS / 硬件世界
@tina/self-mem         ─┘        (src/)
```

---

## 它由什么组成

| 模块 | 位置 | 说明 |
| --- | --- | --- |
| **Fusion Host** | `src/` | 约 1.1 万行 ESM。把 Cortico 的 Bot/World API、DSH 原生 Agent 循环、Self-Mem 机器人与上下文策略组合到同一个进程，同时提供 standalone 与 Cordis 插件两种入口。 |
| **Self-Mem** | `self-mem/` | 约 6.5 千行。连续自我与记忆引擎：只增不改的原话库、Git 权威仓、`TINA_SELF.md` 画布、跨窗口余光、MCP/HTTP 服务。 |
| **Worlds** | `worlds/` | 可插拔通道：`canbot`、`mobile`、`stt`、`tts`、`audio-play`、`codex-bridge`、`linux-tools`、`tinalink`、`tina-main-bot`。 |
| **Upstream** | `upstream/` | 上游源码固定版本：`cortico 0.2.15` + 7 个 `@deepseek-ai/dsh-* 0.1.5-rc.2` 包（均为 MIT）。 |
| **Ops** | `ops/` | 被动采集与原生会话归档，不重放模型请求、不伪造未发生的动作。 |
| **Vendor** | `vendor/` | 离线依赖 tarball 与来源锁，保证无网环境可复现安装。 |

## 三个可下载件

| 件 | 是什么 | 入口 |
| --- | --- | --- |
| **Foundation** | 完整融合宿主：Cortico + DSH + Self-Mem + Worlds | 当前仓库 |
| **Self-Mem** | 连续记忆引擎，可单独接 MCP / HTTP / Cortico Bot | [包说明](docs/SELF_MEM.md) · [冰山模型](docs/ICEBERG.md) · [Releases](https://github.com/rtmhjx/tina-foundation/releases) |
| **DSH Host Plugin** | 把 Cortico Worlds 挂到已有 DSH 会话，不自带第二套运行时 | [包说明](docs/HOST_PLUGIN.md) · [Releases](https://github.com/rtmhjx/tina-foundation/releases) |

## 设计要点

- **单运行时，多入口。** `src/fusion-app.mjs` 是独立进程入口，`src/host-entry.mjs` 是 Cordis 宿主插件入口；两者共享同一套会话、Provider、World 与上下文实现。
- **记忆是底座，不是补丁。** 原话与模型实际返回的 reasoning 进入 `sources.sqlite`，只追加；自我认知、窗口账本与备忘进入同一个 Git 权威仓，天然具备 CAS 并发保护与完整历史。
- **上下文由策略驱动。** `context.maxTokens / keepRatio / softRatio` 与 `loop.softCap / hardCap` 决定压缩时机；`fusion-context-*` 负责维护、交接与投影。
- **World 即插件。** 每个世界声明自己的工具、事件与配置模式；启用或停用不改宿主代码。
- **一切可回滚。** 发布目录、状态目录、记忆库分开放置；升级走候选目录 + 切换 + 回执，不原地覆盖。

## 快速开始

> 这是一套**真实部署**，不是一条命令就能跑的 npm 包。第一次搭建请按 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) 逐步来。Windows 10/11 请看 [`docs/WINDOWS.md`](docs/WINDOWS.md)。

环境要求：

- Linux（参考环境：Ubuntu 24.04，x86_64）
- Node.js **24.12+**（24.x）
- pnpm **11.28.6**
- Git、ripgrep、原生构建工具链

最短路径：

```bash
git clone https://github.com/<you>/tina-foundation.git
cd tina-foundation

# 1. 安装宿主依赖（全部来自 vendor/，可离线）
npm ci --ignore-scripts

# 2. 安装并构建上游 Cortico
cd upstream/cortico
pnpm install --frozen-lockfile
pnpm run build:web
cd ../..

# 3. 构建原生覆盖层（需先准备 runtime/dsh-0.1.5-rc.2）
node scripts/build-fusion-native.mjs

# 4. 初始化状态目录与记忆 Bot
export CORTICO_FUSION_STATE="$PWD/state"
npm run setup:memory

# 5. 写入配置（setup 会生成最小 config，这里替换成完整模板）
cp config/config.example.json "$CORTICO_FUSION_STATE/deployment/config.json"
cp config/env.example "$CORTICO_FUSION_STATE/deployment/.env"

# 6. 启动
npm start
```

> `runtime/dsh-0.1.5-rc.2` 不在仓库内，需要先从发布包或 DSH 源码取得；详见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) 的 2.1 节。

默认只监听回环地址：Web 控制台 `127.0.0.1:7789`，Self-Mem HTTP `127.0.0.1:8895`。状态目录的结构见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 目录

```
.
├── src/                 # Fusion Host（standalone + Cordis plugin）
├── self-mem/            # @tina/self-mem 记忆引擎
├── worlds/              # 通道与设备扩展
├── upstream/            # 固定版本上游源码（MIT）
├── vendor/              # 离线依赖与来源锁
├── integration/         # 端到端验收脚本
├── ops/                 # 被动采集 / 会话归档
├── scripts/             # 构建、打包、安装
├── test/                # 宿主单元与集成测试
├── config/              # 公开配置模板（不含密钥）
└── docs/                # 架构、记忆、部署、来源与脱敏说明
```

## 文档

- [架构](docs/ARCHITECTURE.md) — 分层、请求流、提示词组装、端口
- [记忆](docs/MEMORY.md) — 原话库、Git 画布、六个工具、生命周期
- [冰山模型](docs/ICEBERG.md) — 水下原话、水上理解、引用与纪律
- [Self-Mem 包](docs/SELF_MEM.md) — 独立安装、MCP/HTTP、数据布局
- [DSH Host Plugin](docs/HOST_PLUGIN.md) — 挂到已有 DSH 会话、World 兼容边界
- [部署](docs/DEPLOYMENT.md) — 构建、配置、systemd、备份
- [Windows 预览](docs/WINDOWS.md) — PowerShell 安装、计划任务、限制
- [来源映射](docs/SOURCE-MAP.md) — 版本、上游、保留与删除清单
- [脱敏说明](docs/SANITIZATION.md) — 公开版删了什么、为什么

## 这个仓库里没有什么

公开版**刻意不包含**：

- `sources.sqlite` 原始对话库（约 15 GB、83 万条）与任何真实会话日志
- 人格提示词 `CONSTITUTION / SEED / WORLDVIEW` 与私人记忆画布
- API Key、Token、Cookie、SSH 私钥、设备凭据
- 备份、发布快照、模型缓存、`node_modules`

这既是隐私边界，也是可维护性边界。底座应当能独立于某一个人的记忆被阅读和复用。

## 状态

`0.2.0-fusion.9`，2026-11 快照。代码在生产环境单机常驻运行，但仍是研究型工程：接口会变，部署需要手工步骤，没有面向公众的稳定性承诺。

## 许可

本项目代码采用 **AGPL-3.0-or-later**，延续 Coopanion 项目的开源协议。完整文本见 [LICENSE](LICENSE)。

`upstream/`、`vendor/` 与各 `worlds/*/LICENSE` 中的第三方组件保留其原始 MIT 许可与版权声明；AGPL 不改变这些上游文件的许可。逐项来源见 [docs/SOURCE-MAP.md](docs/SOURCE-MAP.md) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

如果你在网络上运行修改后的版本，AGPL 要求向使用者提供对应源码。部署时请保留本仓库地址与你的修改说明。
