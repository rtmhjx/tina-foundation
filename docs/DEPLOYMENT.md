# 部署

这份文档描述的是一套**单机常驻部署**。Tina 不是无状态服务：代码、状态目录、记忆库必须分开存放，升级时保留旧版本。

## 1. 环境

参考环境：

| 项目 | 版本 |
| --- | --- |
| OS | Ubuntu 24.04 LTS，x86_64 |
| Node.js | 24.12+（24.x；`engines` 会拒绝 25） |
| pnpm | 11.28.6 |
| 其他 | Git、ripgrep、Python 3、原生编译工具链、`libzstd1` |

```bash
sudo apt-get update
sudo apt-get install -y build-essential git ripgrep python3 libzstd1
node -v   # v24.x
pnpm -v   # 11.28.6
```

不要用系统包管理器安装旧版 Node。Node 24 是硬要求：原生 DSH 与 `node:sqlite` 都依赖它。

## 2. 获取与构建

```bash
git clone https://github.com/<you>/tina-foundation.git
cd tina-foundation

# 宿主依赖：全部是 vendor/ 里的 tarball，可离线
npm ci --ignore-scripts

# 上游 Cortico：安装依赖并构建 Web 控制台
cd upstream/cortico
pnpm install --frozen-lockfile
pnpm run build:web
cd ../..

# 原生 DSH 覆盖层（要求 runtime/dsh-0.1.5-rc.2 已存在）
node scripts/build-fusion-native.mjs
```

构建完成后检查：

```bash
test -d runtime/dsh-0.1.5-rc.2
test -f upstream/cortico/dist/web/index.html
```

### 2.1 DSH 运行时闭包（必需）

公开仓库**不包含** `runtime/dsh-0.1.5-rc.2`。它是 DSH 的完整运行时闭包（约 355 MB），`build-fusion-native.mjs` 只在这个闭包上叠加融合层的原生覆盖，不会从零生成它。

没有这个目录时，`build-fusion-native.mjs` 会在 `realpath(runtime)` 处失败，`npm start` 也无法启动。两种取得方式：

1. 从发布包/备份中取回完整的 `runtime/dsh-0.1.5-rc.2`，放到仓库根目录；
2. 从 DSH 源码构建：

```bash
node scripts/stage-dsh-runtime.mjs /path/to/deepseek-harness ./runtime/dsh-0.1.5-rc.2
```

如果闭包是从别处移动来的，先修复内部链接：

```bash
node scripts/stage-dsh-runtime.mjs --relocate ./runtime/dsh-0.1.5-rc.2
```

如果 `build:web` 失败，先确认 `pnpm` 版本与 Node 版本；上游锁文件对二者都敏感。

## 3. 初始化状态目录

状态目录与代码分离。默认是 `.tina-fusion-dev/app`，生产建议显式指定：

```bash
export CORTICO_FUSION_STATE=/srv/tina/state
npm run setup:memory
```

`setup:memory` 会：

1. 校验 `vendor/tina-self-mem-*.tgz` 的 SHA-256 与 Bot 契约；
2. 在目标旁边创建临时目录，用离线 npm 安装 `@tina/self-mem`；
3. 通过 Cortico 官方 Bot 加载器选中它；
4. 只有全部成功后才把临时目录改名为正式状态目录。

已有非空状态目录会被**原样保留**，不会覆盖。失败时保留 `.state.self-mem-*` 证据目录。

初始化后的结构：

```
/srv/tina/state/
├── deployment/
│   ├── config.json
│   ├── .env
│   └── data/
├── providers/
├── extensions/
├── self-mem/
│   ├── authority/
│   └── replica/
└── .fusion-memory-setup.json
```

## 4. 配置

复制模板：

```bash
cp config/config.example.json "$CORTICO_FUSION_STATE/deployment/config.json"
cp config/env.example "$CORTICO_FUSION_STATE/deployment/.env"
chmod 600 "$CORTICO_FUSION_STATE/deployment/.env"
```

### 必须改的字段

| 字段 | 说明 |
| --- | --- |
| `web.host` | 默认 `127.0.0.1`；只有放在反向代理后面才考虑 `0.0.0.0` |
| `selfMem.dataDir` | 记忆库根目录，建议绝对路径 |
| `selfMem.seedFile` | 你的种子文件；公开仓库只有模板 |
| `worlds.*.tokenSecret` | 填**环境变量名**，不是令牌本身 |
| `activeProvider` | 与 `providers/` 下的目录名一致 |

### 密钥

密钥只放在 `<state>/deployment/.env` 或 `<state>/providers/<name>/.env`，权限 `0600`。配置里写变量名，例如：

```json
"worlds": {
  "mobile": { "enabled": true, "tokenSecret": "TINA_MOBILE_TOKEN" }
}
```

不要把真实值写进 `config.json`、提示词、日志或 Git。

### Provider

每个 Provider 一个目录：

```
<state>/providers/<name>/
├── config.json     # kind / baseUrl / model / 参数；secret 字段写环境变量名
└── .env            # 真实密钥
```

`config.json` 的 `secret` 是**变量名**，不是值。配置好之后在 Web 控制台「模型与工具」页选择模型与推理档位。

## 5. 启动

```bash
export CORTICO_FUSION_STATE=/srv/tina/state
npm start
```

默认监听：

- Web 控制台：`127.0.0.1:7789`
- Self-Mem HTTP：`127.0.0.1:8895`

首次启动前建议：

```bash
# 只做配置与装配检查，不请求模型
node scripts/check-fusion.mjs
```

## 6. systemd

`/etc/systemd/system/tina-fusion.service`：

```ini
[Unit]
Description=Tina Fusion runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tina
Group=tina
WorkingDirectory=/srv/tina/tina-foundation
Environment=CORTICO_FUSION_STATE=/srv/tina/state
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /srv/tina/tina-foundation/src/fusion-launcher.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/srv/tina/state

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tina-fusion
sudo journalctl -u tina-fusion -f
```

如果使用用户级 unit，把 `ExecStart` 指向同一个 launcher，并确保 `CORTICO_FUSION_STATE` 在 unit 里显式设置。

## 7. 反向代理与 TLS

对外只暴露反向代理，不直接暴露 7789：

```nginx
server {
  listen 443 ssl http2;
  server_name tina.example.com;

  ssl_certificate     /etc/letsencrypt/live/tina.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/tina.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:7789;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
  }
}
```

Web 控制台本身有密码（`CORTICO_WEB_PASSWORD`）。即使有反向代理，也不要关闭它。

## 8. 备份

需要备份的三类东西：

1. **记忆库**：`<state>/self-mem/`。SQLite 必须用在线备份或停机复制，不能只拷主文件。
2. **部署配置**：`<state>/deployment/config.json`、`.env`、`providers/`、`extensions/`。
3. **代码版本**：当前 `releases/<version>/` 或 Git commit。

示例（停机窗口内）：

```bash
sudo systemctl stop tina-fusion
sqlite3 "$STATE/self-mem/authority/sources.sqlite" ".backup '/backup/sources.sqlite'"
tar -C "$STATE" -czf "/backup/tina-state-$(date +%F).tgz" \
  deployment/config.json deployment/.env providers extensions self-mem
sudo systemctl start tina-fusion
```

在线备份时使用 SQLite `.backup`，并核对 `PRAGMA integrity_check`。备份完成后至少做一次恢复演练。

## 9. 升级与回滚

不要在旧目录里 `git pull` 后直接重启。推荐：

```bash
git clone <repo> /srv/tina/releases/2026-11-20
cd /srv/tina/releases/2026-11-20
npm ci --ignore-scripts
# 构建上游与原生运行时
# 用同一个 CORTICO_FUSION_STATE 启动候选实例，先验证
```

验证通过后，把 systemd `ExecStart` 指向新目录并重启；旧目录保留至少一个版本。回滚就是把 `ExecStart` 指回去。

记忆库不需要随代码升级移动；`CORTICO_FUSION_STATE` 不变，Bot 会继续使用同一份权威仓。

## 10. 常见故障

| 现象 | 检查 |
| --- | --- |
| 启动报 `Invalid self-mem source lock` | `vendor/self-mem-lock.json` 与 tarball 不匹配；重新 `npm pack` 并更新哈希 |
| `node_modules` 缺失 | 先 `npm ci`，再 `cd upstream/cortico && pnpm install` |
| `tsx` 找不到 | 上游 Cortico 依赖未安装；`pnpm install --frozen-lockfile` |
| Web 打不开 | 确认只监听 `127.0.0.1` 时通过 SSH 隧道或反代访问 |
| 模型不回复 | 检查 Provider 配置、密钥变量名、模型选择与执行档位 |
| 记忆不增长 | 检查 `selfMem.dataDir` 权限、`authority` Git 仓、Bot 是否被选中 |

日志默认在 `<state>/deployment/data/` 与 systemd journal。排查时先看结构化错误码，不要只看最后一行。
