# Windows 预览版

> **状态：Preview / 未完成端到端验收。** 这套脚本和文档让底座能在 Windows 10/11 上按步骤搭起来，但还没有在 Windows 上完成长期运行、原生组件构建和真实 Provider 往返的完整验收。生产使用请优先参考 Linux 部署，或先在隔离目录试跑。

当前仓库的代码是跨平台的；差异主要在部署层：Linux 用 systemd、`linux-tools` 和 Linux 路径，Windows 用 PowerShell、计划任务和 `C:\` 路径。

## 1. 要求

| 项目 | 要求 |
| --- | --- |
| OS | Windows 10/11 x64 |
| Node.js | 24.12+，且必须是 24.x |
| pnpm | 11.28.6（至少 11.x） |
| 其他 | Git for Windows、Windows 10+ 自带 `tar` |
| 可选 | Visual Studio Build Tools + Python 3（原生组件编译失败时） |
| 磁盘 | 至少 8 GB 空闲（依赖、运行时、状态） |

检查工具链：

```powershell
node -v
pnpm -v
git --version
tar --version
```

## 2. 先准备 DSH 运行时闭包

这是 Windows 版最容易卡住的一步。

公开仓库**没有**包含 `runtime/dsh-0.1.5-rc.2`（约 355 MB）。这个目录是 DSH 的完整运行时闭包，融合宿主和原生 Agent 循环都依赖它。没有它，`run.ps1` 会直接拒绝启动。

两种取得方式：

1. **从发布包获取**：把发行包里的 `runtime/dsh-0.1.5-rc.2` 整个目录放到仓库根目录的 `runtime\` 下。
2. **从 DSH 源码构建**：准备 `deepseek-harness` 源码，然后：

```powershell
node scripts\stage-dsh-runtime.mjs "C:\path\to\deepseek-harness" "C:\path\to\tina-foundation\runtime\dsh-0.1.5-rc.2"
```

如果闭包是从别处移动过来的，先修复内部链接：

```powershell
node scripts\stage-dsh-runtime.mjs --relocate "C:\path\to\tina-foundation\runtime\dsh-0.1.5-rc.2"
```

目录正确时应该能看到 `runtime\dsh-0.1.5-rc.2\package.json`。

## 3. 安装

```powershell
git clone -b windows https://github.com/rtmhjx/tina-foundation.git
cd tina-foundation

# 只检查工具链与运行时，不安装任何东西
.\scripts\windows\bootstrap.ps1 -CheckOnly

# 完整安装（需要 runtime 已就位）
.\scripts\windows\bootstrap.ps1 -RuntimeDir C:\Tina\runtime\dsh-0.1.5-rc.2
```

`bootstrap.ps1` 依次执行：

1. `npm ci --ignore-scripts`（根依赖全部来自 `vendor\`）
2. `pnpm install --frozen-lockfile` + `pnpm run build:web`（上游 Cortico）
3. `node scripts\build-fusion-native.mjs`（原生覆盖层）
4. `npm run setup:memory`（安装 `@tina/self-mem` 并初始化状态目录）
5. 复制 `config\config.windows.example.json` 与 `config\env.example`
6. 用 `icacls` 把状态目录限制为当前用户

如果只想先搭宿主和 Web 控制台、暂时不构建原生覆盖层：

```powershell
.\scripts\windows\bootstrap.ps1 -SkipNative -RuntimeDir C:\Tina\runtime\dsh-0.1.5-rc.2
```

离线安装（依赖缓存已存在时）：

```powershell
.\scripts\windows\bootstrap.ps1 -Offline -RuntimeDir C:\Tina\runtime\dsh-0.1.5-rc.2
```

## 4. 配置

安装后编辑：

```powershell
notepad .\state\deployment\.env
notepad .\state\deployment\config.json
```

Windows 模板与 Linux 的主要差异：

- `selfMem.dataDir`、`authorityDir`、`seedFile` 使用 `C:/Tina/state/...`；
- `worlds.linux-tools.enabled` 为 `false`（这个 World 依赖 Linux 的 bubblewrap，Windows 上不可用）；
- `worlds.canbot` 的 token 路径是 Linux 形式，默认关闭；
- `worlds.codex-bridge.user` 是 `YOUR_WINDOWS_USER`，需要改成实际 Windows 用户名；
- `worlds.mobile`、`stt`、`tts` 保持 `127.0.0.1`，默认关闭。

Provider 密钥只放在 `<state>\deployment\.env` 或 `<state>\providers\<name>\.env`。配置里的 `secret` 写变量名，不写值。

## 5. 启动

```powershell
.\scripts\windows\run.ps1
```

打开 <http://127.0.0.1:7789>。

指定端口：

```powershell
.\scripts\windows\run.ps1 -Port 7789 -OpenBrowser
```

只检查配置和运行时：

```powershell
.\scripts\windows\run.ps1 -CheckOnly
```

## 6. 开机启动（计划任务）

Windows 版不注册系统服务，而是注册**当前用户登录时启动**的计划任务：

```powershell
.\scripts\windows\install-service.ps1 -StateDir C:\Tina\state
```

查看、立即运行、删除：

```powershell
.\scripts\windows\install-service.ps1 -TaskName TinaFusion -Status
schtasks /Run /TN TinaFusion
.\scripts\windows\install-service.ps1 -TaskName TinaFusion -Remove
```

这是“登录后启动”，不是“开机即启动”。如果需要无人登录也运行，请使用 NSSM、WinSW 或 Windows Service 包装器，并自行处理会话隔离与日志。

## 7. 网络与安全

- 默认只监听 `127.0.0.1`，Windows 防火墙不需要放行 7789。
- 要对外访问，放在 Caddy/nginx/IIS 反向代理之后，启用 TLS，并保留 Web 密码。
- 不要把 7789、8895、7799 直接暴露到公网。
- 不要把 `.env`、`state\self-mem\` 或 `providers\` 提交到 Git。
- `bootstrap.ps1` 会用 `icacls` 收紧状态目录；如果手动迁移，记得重新设置 ACL。

## 8. Windows 上的已知限制

| 限制 | 说明 |
| --- | --- |
| DSH 运行时未随仓库发布 | 必须先准备 `runtime\dsh-0.1.5-rc.2`，否则无法启动 |
| 未完成端到端验收 | 原生构建、真实 Provider、长期运行都还没有 Windows 验收记录 |
| `linux-tools` 不可用 | 它依赖 Linux 账户、bubblewrap 和 systemd socket |
| `canbot` 默认关闭 | 其 token 文件路径与媒体 helper 原本按 Linux 部署 |
| 没有 systemd | 用计划任务启动，日志走控制台/文件，不是 journal |
| 原生编译依赖 | 如果预编译包缺失，需要 VS Build Tools + Python 3 |
| 长路径 | 仓库层级较深，建议放在 `C:\Tina\` 这类短路径下 |
| 杀毒/索引 | 实时扫描可能拖慢 `node_modules` 与 SQLite，必要时加排除项 |

## 9. 备份与卸载

停机后备份：

```powershell
Compress-Archive -Path .\state -DestinationPath .\backup\tina-state-$(Get-Date -Format yyyyMMdd).zip
```

记忆库是 SQLite + Git 目录，最稳妥的方式是停止进程后整体复制 `state\self-mem\`，或使用 SQLite 在线备份工具。不要只复制 `sources.sqlite` 主文件而漏掉 WAL。

卸载：

```powershell
.\scripts\windows\install-service.ps1 -Remove
# 然后删除仓库目录与 state 目录（确认已备份）
```

## 10. 出问题先看这里

| 现象 | 检查 |
| --- | --- |
| `Missing DSH runtime` | `runtime\dsh-0.1.5-rc.2\package.json` 是否存在 |
| `pnpm` 找不到 | `npm install -g pnpm@11.28.6` |
| `npm ci` 失败 | 删除 `node_modules` 后重试；确认 `vendor\*.tgz` 完整 |
| 上游构建失败 | Node 是否为 24.12+；`pnpm -v` 是否为 11.x |
| 原生构建失败 | 安装 VS Build Tools + Python 3，或先用 `-SkipNative` |
| 启动后页面打不开 | 确认只监听 `127.0.0.1`；用 `run.ps1 -CheckOnly` |
| 模型不回复 | 检查 `.env` 的密钥变量名、`activeProvider` 与模型选择 |
| 记忆不增长 | 检查 `state\self-mem\` 权限与 `setup:memory` 回执 |

---

这套 Windows 路径是**预览**。它适合先在个人机器上把底座跑起来、验证通道与记忆，不适合直接承担生产流量。发现问题时保留 `state` 与日志，不要清空未知状态。
