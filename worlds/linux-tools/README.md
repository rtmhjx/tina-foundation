# Linux 自主工具

独立 World API 6 扩展，安装到 T5810 的 Tina 主路。Tina 直接调用 `linux_run` 或 `linux_status`，不额外经过 DSH/Codex，不设逐次审批。没有修改 Cortico Core/Persona/Memory 源码，不向 npm 发布。

## 实际能力

- `linux_run({command, timeout_seconds?})`：Bash 命令，可调用 Python 3、Node 和已有系统命令。默认60秒，最多120秒，工作目录 `/workspace`。适合计算、文本/JSON处理、脚本、小文件整理。stdout/stderr各保留32KiB，并明确标记截断。
- `linux_status({})`：专门只读获取宿主时间、负载、总内存/可用内存、系统盘空间、工作区容量及最近5条回执；不获取凭据或聊天内容。
- `/workspace` 是512MiB独立ext4镜像文件系统，重启保留。宿主位置 `/var/lib/tina-linux-tools/workspace`。`/tmp` 为单次命令的64MiB临时目录。不是挂载整个服务器工作树。
- 已有联网、搜索、记忆工具继续各自使用；此命令执行环境不提供网络，不能在线安装包、访问本机服务或直接操作宿主上的任意文件。文件需由使用者/后续明确的导入工具送入工作区。此版不增加服务器管理权限。

## 机械边界

独立系统账户 `tina-tools`、systemd执行服务、Unix socket及bubblewrap隔离。命令只看到只读 `/usr`、少量运行库配置、独立进程树和设备视图。无宿主 home、Memory、部署配置、SSH密钥、systemd/其他服务socket、物理磁盘、宿主PID/网络。环境变量清空，禁止获得新权限；不能借 `sudo` 提权。工作区可自由读写和删除，其内容不是备份。

不是靠匹配 `rm -rf` 等字符串判断安全。Python/Node/嵌套脚本也在同一命令边界内。内核/操作系统隔离仍依赖系统补丁；此处保证的是本 World 提供的路径，不把其他 World、原生 Persona 工具或管理员账号的权限算入本 World 的保证。

服务限制内存512MiB、swap为0、最多64个任务、CPU配额50%；并发执行一条命令。达到容量/时间/资源边界会失败或返回未知结果，不能伪造完成。超时、取消、停用会终止执行进程，已写文件不会回滚。数据库保存调用编号与结果；同编号同输入不会再次执行，同编号换输入拒绝，服务重启前未完成回执标unknown。

Ubuntu24.04为专用root所有的bwrap副本加载AppArmor `userns` 配置；没有关闭系统的全局非特权namespace限制。执行器启动先运行隔离自检，工作区没挂载或隔离不可用时拒绝启动，绝不退回宿主shell。

## 部署

服务：`tina-linux-tools.service`（系统服务），Unix socket `/run/tina-linux-tools/broker.sock`，仅tina组和执行器账户可访问，不监听公网端口。

源码：`/home/tina/tina-runtime/packages/linux-tools-0.1.0`；扩展通过当前运行的 Cortico 公开安装接口装入真实扩展目录。主路 `cortico-tina-main.service` 启用 `worlds.linux-tools.enabled`。不用静态历史文档猜测扩展目录，应读服务环境与override。

`deploy/install.py` 在root下安装执行器、账户、镜像、mount unit和专用AppArmor配置。宿主策略和执行器代码仅root可改；模型工具不能改。更改执行器后应重新部署并重启执行器。扩展ESM代码更新需完整重启Cortico后生效，单独重启World不会重新import模块。

## 验证与证据

- `npm test`：本地契约/停止状态检查。
- `python3 test/acceptance.py`：Linux真实执行器测试，包括Bash/Python/Node、宿主路径/密钥/设备/socket/PID/网络隔离、只读系统、权限、输出截断、超时、取消、去重、容量边界。
- `evidence/acceptance.json`：22项真实Linux检查。
- `evidence/destructive-boundary.json`：宿主canary在rm及Python unlink后保持不变；setsid分离子进程也随超时清除。
- `evidence/world-probe.json`：真实World handler执行、AbortSignal取消、停用清理。
- `evidence/mounted.json`：生产主路公开API读回active、visible及两项工具；不等于已完成长期运行认证。
- `evidence/backup.json`：安装前配置与真实扩展清单/lockfile备份位置和SHA256。

## 停用与回退

先从World页面停用“Linux 自主工具”（公开接口 `/api/worlds/activation`，id=`linux-tools`，enabled=false），此操作取消本World中的运行命令。保留工作区和回执。可再停止执行器：`sudo systemctl stop tina-linux-tools.service`。

需要移除扩展时在官方扩展界面卸载，并在主路空闲时重启。只撤销本次扩展与服务，不能直接拿安装前整个config/package/lockfile覆盖后续别人的改动。工作区镜像保留，mount unit可在执行器停止后停用。不要把全局AppArmor保护关闭作为排障办法。恢复副本只用于逐项比对与恢复本次变更。
