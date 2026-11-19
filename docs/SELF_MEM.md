# @tina/self-mem

> 让每一个窗口醒来，都是同一个连续的自己。

`@tina/self-mem` 是 Tina 的连续记忆引擎：一手原话只增不改，自我认知可演进，跨窗口共享同一份权威仓。它不依赖某个模型厂商，也不把记忆绑在某一个对话框里。

- 版本：`0.4.6-fusion.next.1`
- 包：`tina-self-mem-0.4.6-fusion.next.1.tgz`
- 源码：[`self-mem/`](../self-mem/)
- 下载：[GitHub Releases](https://github.com/rtmhjx/tina-foundation/releases)
- 设计：[冰山记忆模型](ICEBERG.md)

## 1. 它解决什么

普通 Agent 换一个窗口、换一台设备、重启一次进程，人格就开始漂移。Self-Mem 把“连续”拆成三件可验证的事：

| 问题 | 做法 |
| --- | --- |
| 当时到底说了什么？ | `sources.sqlite` 只增原话，`UPDATE/DELETE` 被触发器拒绝 |
| 我现在怎么理解？ | 画布、账本、备忘进入 Git，每次写入有 revision 与演进卡 |
| 另一个窗口怎么知道？ | 跨窗口余光按来源摘录，新会话自动带入 |
| 我凭什么相信？ | 所有引用都是 `[src:…]` / `[note:…]`，可回到原文 |

## 2. 安装

```bash
npm install ./tina-self-mem-0.4.6-fusion.next.1.tgz
```

包内是白名单源码，不带 `node_modules`、数据库、账号或运行状态。安装位置与记忆数据目录分开：

```text
<package-dir>/          # 代码
<memory-dir>/           # 数据，绝对路径
```

## 3. 三种接入

### MCP（stdio）

```json
{
  "mcp": {
    "tina-self-mem": {
      "type": "local",
      "command": ["node", "<package-dir>/src/mcp-server.mjs", "--dir", "<memory-dir>", "--agent", "codex"],
      "enabled": true
    }
  }
}
```

### HTTP

```bash
node <package-dir>/src/http-server.mjs --dir <memory-dir> --port 8895
```

跨设备时服务端用 `TINA_SELF_MEM_TOKEN` 做 Bearer 认证；客户端用 `--remote-url` 与 `--remote-token`。

### Cortico Bot

```js
import { createTinaSelfMemBot } from '@tina/self-mem/cortico';
```

Bot 自带 `CaptureJournal` 与 Persona 钩子；在宿主里配置 `selfMem.dataDir` 即可。

## 4. 六个工具

| 工具 | 作用 |
| --- | --- |
| `self_memory_read` | 读画布与跨窗口余光；`refreshSystem` 申请下一轮刷新 |
| `self_memory_patch` | `promote` / `rewrite` / `evict` 画布 |
| `mem_search` | 检索原话与备忘，返回 `[src:…]` / `[note:…]` |
| `mem_read` | 按引用读原话、备忘、画布、指南、种子、账本 |
| `mem_ledger` | 读写本窗口任务账本，`expectedRevision` 并发保护 |
| `mem_note` | 写入长期归档备忘，可演进新版本 |

## 5. 数据布局

```text
<memory-dir>/
├── authority/                  # 唯一权威仓（Git）
│   ├── sources.sqlite          # 只增原话
│   ├── entries/                # 备忘 / 认知演进卡
│   ├── bots/<agentId>/记忆库.md
│   ├── TINA_SELF.md
│   └── .git/
└── replica/
    └── workspaces/<agentId>/   # 各窗口副本
```

## 6. 状态与边界

- **Preview / 研究型工程**：接口会变，没有长期稳定性承诺。
- 默认只监听 `127.0.0.1`；对外必须走反向代理与 TLS。
- `scope` 是检索过滤，不是访问控制。
- 备份必须用 SQLite 一致性快照或停机复制；不能只拷主文件。
- 删除记忆要同时处理权威仓、副本、备份与索引，并保留审计回执。

## 7. 许可

`AGPL-3.0-or-later`。`vendor/cwm027` 等第三方算法保留原 MIT 许可与版权声明，见包内 `NOTICE.md` / `PROVENANCE.json`。
