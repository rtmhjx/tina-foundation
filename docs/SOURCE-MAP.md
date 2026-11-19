# 来源映射

公开版来自 T5810 上的运行目录：

```
/home/tina/tina-runtime/
├── releases/tina-fusion-0.2.0-fusion.9-20261116/
└── deployments/tina-fusion-20261114/
```

## 1. 版本

| 组件 | 版本 |
| --- | --- |
| Fusion Host (`package.json`) | `0.2.0-fusion.9` |
| `@tina/self-mem` | `0.4.6-fusion.next.1` |
| Cortico | `0.2.15`（源码树由 `vendor/cortico-source-*` 锁定） |
| `@deepseek-ai/dsh-*` | `0.1.5-rc.2` |
| Cordis | `4.0.2` |
| 部署快照 | 2026-11-19 |

## 2. 保留

| 仓库路径 | 来源 | 说明 |
| --- | --- | --- |
| `src/` | release/src | 57 个 `.mjs`，10,724 行；按发行白名单保留 |
| `integration/` | release/integration | 记忆、引导、Linux shell 验收脚本 |
| `ops/` | release/ops | 被动采集、会话归档与测试 |
| `scripts/` | release/scripts | 构建、打包、安装、验收 |
| `test/` | release/test | 宿主结构测试 |
| `upstream/` | release/upstream | 上游源码；排除 `node_modules` |
| `vendor/` | release/vendor | 离线依赖、来源锁；移除并重建了 self-mem 包 |
| `self-mem/` | deployment 安装包 | 由 `vendor/host-self-mem/package` 提升为顶层源码 |
| `worlds/` | `tina-runtime/packages/*` + `~/canbot-world-0.8.0-*` | 9 个世界扩展，取当前使用版本 |
| `config/` | 新写 | 脱敏模板 |
| `docs/` | 新写 | 架构、记忆、部署、来源、脱敏 |

## 3. 排除

| 内容 | 原因 |
| --- | --- |
| `deployment/prompts/{CONSTITUTION,SEED,WORLDVIEW,ORIENTATION}.md` | 人格与关系，属于私人内容 |
| `deployment/config.json` / `.env` | 含 tokenSecret、设备 ID、内网地址 |
| `providers/*/config.json` / `.env` | 含 API Key 与账号信息 |
| `self-mem/authority` / `replica` | 14.8 GB 原话库 + Git 记忆仓 |
| `deployment/data/` | 会话、媒体、用量、运行记录（约 2.3 GB） |
| `runtime/` | 预编译 DSH 运行时（355 MB，可由源码构建） |
| `backups/`、`recovery/`、`upgrade-*`、`maintenance/`、`imports/` | 部署快照与历史，体量大且含私人内容 |
| `TINA-L0/`、`tina-workspace/` | 明文记忆库与工作区 |
| `*.bak-*`、`.repair-backup-*` | 历史候选与修复副本 |
| 各 world 的 `evidence/` | 真实主机路径、安装回执与哈希 |

## 4. 第三方

`upstream/` 与 `vendor/` 保持原字节（除排除 `node_modules`）。Cortico 与 DSH 均为 MIT；许可与版权见 `THIRD-PARTY-NOTICES.md`。

`self-mem/vendor/cwm027` 是从 `cortico-world-memory 0.2.7`（MIT）转译的向量检索模块，保留 `NOTICE.md` 与 `PROVENANCE.json`。

## 5. 可复现性

- `vendor/*-source-lock.json` 记录上游源码树哈希。
- `vendor/self-mem-lock.json` 记录公开版 self-mem 包的 SHA-256。
- `package-lock.json` 与 `upstream/cortico/pnpm-lock.yaml` 锁定依赖。
- 本仓库不保证与原始部署逐字节相同：公开版做了脱敏、路径替换与 self-mem 重建，差异见 `SANITIZATION.md`。
