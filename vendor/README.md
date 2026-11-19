# vendor/

离线依赖与来源锁。所有 tarball 都放在这里，安装脚本不需要访问 npm registry。

| 文件 | 用途 |
| --- | --- |
| `tina-self-mem-0.4.6-fusion.next.1.tgz` | `@tina/self-mem` Bot 包，由 `self-mem/` 白名单文件构建 |
| `self-mem-lock.json` | 上述包的版本、SHA-256 与 Bot 契约 |
| `cortico-source-*.tgz` / `*-source-lock.json` | 上游 Cortico 与 DSH 组件的源码快照及来源锁 |
| 其余 `*.tgz` | 固定版本的第三方 MIT 依赖（Ajv、js-yaml、Cordis 等） |

## 重新构建 self-mem 包

```bash
cd self-mem
npm pack --pack-destination ../vendor
```

然后把新文件名与 `sha256sum` 写回 `self-mem-lock.json`。`package.json` 的 `files` 白名单决定哪些文件会进入包；不要把记忆数据目录、`.env` 或运行状态加进去。
