# 脱敏说明

公开版的边界是：**代码与架构完整，个人记忆与凭据为零**。

## 1. 删除

| 内容 | 处理 |
| --- | --- |
| 人格提示词 `CONSTITUTION / SEED / WORLDVIEW / ORIENTATION` | 未复制；仓库只保留中性模板 |
| 真实 `TINA_SELF.md` 画布 | 未复制 |
| `sources.sqlite`（14.8 GB，83 万条） | 未复制 |
| `replica/`、`bots/*/记忆库.md`、`entries/*.md` | 未复制 |
| 会话日志、`data/`、媒体、用量账本 | 未复制 |
| `providers/*/.env`、`deployment/.env`、`.credentials.yaml` | 未复制 |
| SSH 私钥、隧道身份、设备凭据 | 未复制 |
| `TINA-L0/`、`tina-workspace/` | 未复制 |
| `tina-self-mem-*.tgz` 原始包 | 删除（内含私人种子文档），改为从脱敏源码重建 |
| `worlds/linux-tools/evidence/` | 删除（含真实主机路径与安装回执） |
| `worlds/canbot/P5-PRIVATE-PATCH.json` | 删除（私有补丁元数据） |
| 所有 `*.bak-*` | 删除 |

## 2. 替换

| 类别 | 公开版处理 |
| --- | --- |
| 私人称呼与桌宠昵称 | 改为 `使用者` / `用户` 与通用示例 |
| 本机局域网地址 | 改为 RFC 5737 文档示例地址 |
| 本机 Windows 用户名与主机名 | 改为 `tina` / 通用占位 |
| 本机开发目录（Windows 盘符路径） | 改为环境变量或通用描述 |
| 云账号项目标识 | 配置模板中留空 |
| 上游源码锁里的本机原始路径 | 改为 `deepseek-harness/...` 相对描述 |

具体替换清单不在此复述，避免二次记录敏感值。

## 3. 审计方法与结果

对整理后的 1,878 个文件做了以下检查：

1. **真实密钥反查**：从部署 `.env`、4 个 Provider `.env` 与 `.credentials.yaml` 提取 18 个真实凭据值，逐字节搜索整个仓库 → **0 命中**。
2. **高熵/密钥模式**：`sk-*`、`oc_*`、`ghp_*`、`github_pat_*`、`AKIA*`、`xox*`、JWT、PEM 私钥、`Bearer` → 仅命中上游测试里的假 key 与公开的 DeepSeek 控制台链接。
3. **PII 词表**：真实姓名、QQ、B 站 ID、地点、宠物名、Windows 用户名、主机名、局域网 IP、GCP 项目 → 逐条修复后归零（上游 MIT 代码中的通用示例除外）。
4. **压缩包内容**：23 个 `.tgz` 全部展开检查；发现并移除了含私人种子的 self-mem 包，重建包的 SHA-256 已写入 `vendor/self-mem-lock.json`。
5. **全文阅读**：第一方代码按区域分片读完注释、中文字符串、文档与配置；上游 32 万行 MIT 代码做模式扫描与抽样复核，不逐行改写。
6. **Provider 结构核对**：确认 `config.json` 的 `secret` 字段只保存**环境变量名**，真实值只在 `.env`，且 `.env` 未进入仓库。

## 4. 已知残留

以下内容是**项目语义**而非个人信息，公开版保留：

- `worlds/canbot` 的机器人协议、动作名与证据边界文字；
- `worlds/*/README.md` 中的 B 站/GitHub 上游链接；
- 上游测试里的通用私有网段示例地址；
- `upstream/` 与 `vendor/` 中的第三方作者邮箱与版权声明。

如果你在自己的 fork 里继续使用，请在提交前重新运行一次密钥扫描；历史 Git 记录不会因为删除文件而消失。
