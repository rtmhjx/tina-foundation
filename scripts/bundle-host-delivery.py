import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
artifacts = root / 'artifacts'
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
if version != '0.1.0-alpha.1':
    raise SystemExit('This is the archived alpha acceptance bundler; use current verified receipts and a new delivery report. Historical fixed counts must not describe a new build.')
package = artifacts / f'tina-dsh-plugin-cortico-{version}.tgz'
receipt = json.loads((artifacts / 'validation/HOST_ACCEPTANCE.json').read_text(encoding='utf-8-sig'))
digest = lambda data: hashlib.sha256(data).hexdigest()
assert digest(package.read_bytes()) == receipt['packageSha256']
assert receipt['passed'] == 6 and not receipt['failed'] and not receipt['skipped']
rollback = json.loads((artifacts / 'validation/rollback-native-continuation.json').read_text('utf-8'))
assert all(rollback[key] for key in ['allFourNativeApisRestored', 'priorPluginHistoryReadable', 'priorRecordsIdentical', 'sameSessionContinues'])
stage = artifacts / f'host-plugin-delivery-{version}'
stage.mkdir(exist_ok=False)
shutil.copyfile(package, stage / package.name)
shutil.copytree(artifacts / 'validation', stage / 'validation')
shutil.copytree(root / 'docs/host-plugin', stage / 'docs')
shutil.copyfile(root / 'docs/HOST_PLUGIN.md', stage / 'docs/HOST_PLUGIN.md')
(stage / 'extra-validation').mkdir()
for path in ['integration/host-plugin-rollback-smoke.mjs', 'scripts/prepare-stock-host-test.py', 'scripts/verify-host-artifact.py']:
    shutil.copyfile(root / path, stage / 'extra-validation' / Path(path).name)

acceptance = f'''# 宿主插件 {version} 的实际验收

产品包：`@tina/dsh-plugin-cortico`，SHA-256：`{receipt['packageSha256']}`。

## 最终安装包：6 项通过，0 失败，0 跳过

先恢复五组原生源码构建模块：Session、SessionController、AgentLoop、Tools、FileUpload，确认四类新增 API 都不存在。该基线为固定 DSH 0.1.5-rc.2 的本地源码构建，原 checkout 自带的原生取消改动在来源清单中保留说明，不将它冒充未经任何改动的 npm 发布包。

1. 未扩展宿主先完成原生对话。最终包拒绝缺少接口的宿主，不写插件状态、不改历史，原生聊天继续。`validation/stock-negative.tap`：1/1。
2. 从最终包中运行四组件兼容安装器，先检查全部版本/哈希，再安装到同一隔离宿主。另开全新进程执行后续测试。
3. 正式 SelfMem 真实写入、读取、重新挂载与完整关机；缺少服务的前置拒绝；原生客户端 assembler、实时/重新加载、原生 Markdown 强调与代码；完整会话、工具、World、卸载、恢复与重启续行。`validation/installed-acceptance.tap`：4/4。
4. 全新普通 Node 进程，不用全局 tsx/NODE_OPTIONS，通过真正 Cordis Loader 挂载最终 npm 包；验证客户端模块图、原 Agent、World 工具、编译器范围及卸载释放、原生聊天继续。`validation/installed-package.tap`：1/1。

测试启动器附带的 `tinaDshSession` 先被撤销，插件自行取得并释放所需服务。当前自主回合的平滑卸载等到最后一次 World 发言完成；外来活动回合不被取消或等待，外来队列保留，插件遗留唤醒撤回；待处理事件重挂载后处理一次。

## 附加真实回退验收

四组件安装后，先完成上述正向验收并关闭所有测试进程。随后从最终安装包运行反向回退，四个入口哈希均恢复原始基线，FileUpload 仍为原版。恢复刚刚使用过插件的同一个测试会话：旧 World 记录可读、已有记录逐条保持，再通过未经融合扩展的原生 AgentLoop 完成新一轮对话。见 `validation/rollback-native-continuation.json`、`stock-after-rollback.json`。

## 其他回归与完整性

| 范围 | 结果 |
| --- | --- |
| 共享融合模块与宿主源码回归 | 76/76；这组使用开发兼容宿主，不单独证明干净宿主安装 |
| 四组件安装/回退、错误基线、后续失败补偿、中途 I/O 失败恢复 | 15/15 |
| Cortico Bot、关机、扩展及子进程解析器 | 83/83 |
| tgz 内所有文件与构建清单 | 2,493 文件；2,492 个内容哈希加构建清单本身，全部匹配 |
| 离线安装后的文件回读 | 2,492 个内容哈希全部匹配；安装时未运行 lifecycle scripts |

这些回归组的覆盖存在重叠，不把它们相加为互不重叠的功能数量。原始 TAP、机器回执、基线哈希和源码审核记录都在 `validation/`。

## 明确未验收的部分

- 模型端点为本地脚本化 HTTP/SSE；没有调用付费 DeepSeek 或其他真实模型。因此未测真实 RP 质量、实际 token 效率、缓存命中及首 token 延迟。
- 没有挂载现有私人 RP、替换生产 Tina、操作服务器或修改用户日常 DSH。
- 客户端已经验证原生模块发现、真实 reducer 与 Markdown 渲染；没有做用户浏览器的视觉/交互验收。
- 仅验收 Windows x64、匹配哈希的 DSH 0.1.5-rc.2、Cordis 4.0.2、Node 24。旧 0.1.0 和其他版本不会自动被视为兼容。
- 首版每个宿主同时附着一个 Session。没有宣称多角色并发挂载或长期稳定性。
- 事件跨存储结算的崩溃窗口采用 `HOST_INPUT_UNSETTLED` 拒绝盲目重发；没有宣称分布式事务式绝对恰好一次。

原生权威日志始终保留；内部文本的对话隐藏是插件生效期间的可撤销投影，不是对操作者的保密边界。插件移除后由原生宿主决定如何显示权威日志。
'''
(stage / 'ACCEPTANCE.md').write_text(acceptance, encoding='utf-8')
(artifacts / 'ACCEPTANCE.md').write_text(acceptance, encoding='utf-8')
guide = f'''# Cortico DSH 宿主插件 {version}

这是独立产品的第一版宿主插件。复用现有 DSH 的 Cordis、AgentLoop、Session、工具、模型与审批，加入 Cortico 的 Persona/Memory/World/system 装配。默认延续原 RP 角色，不改名，不导入私人 Tina 记忆。

## 文件

- `{package.name}`：标准 npm 插件包，包含源码、预编译的四组件兼容层、安装/回退脚本、原生浏览器模块和必要第三方依赖。没有第二套 DSH/Cordis 或私人数据。
- `docs/README.md`：安装顺序与 Loader 配置示例。
- `docs/HOST_PLUGIN.md`：会话路由、工具、system 与生命周期接口。
- `docs/SOURCE_CHANGES.md`：共用源码装配及 Cortico 两处补丁。
- `ACCEPTANCE.md`、`validation/`：本次实际验证范围、原始日志与机器回执。
- `extra-validation/`：附加的回退续行、基线准备及包完整性检查脚本，供开发环境复核。源码目录结构要求见其相对导入；不要对生产状态执行测试。

## 开始使用

先在独立、匹配版本的 DSH 副本中测试；保存原 profile 和会话。此包没有自动连接或修改现有 DSH。在 PowerShell 中将 tgz 解开后，会生成 `package/`：

```powershell
tar -xzf ./{package.name}
Set-Location ./package
node scripts/install-host-compat.mjs --runtime=F:\\独立副本\\dsh --plan
```

完整步骤在 `docs/README.md`。四组件安装必须对已停止的目标宿主执行，首次需要正常重启；之后恢复指定旧会话并在空闲时启用 Loader 插件。兼容安装器接受精确的版本及哈希，遇到未知版本就拒绝。标准 npm 包可使用 `npm install --offline --ignore-scripts --legacy-peer-deps <tgz绝对路径>` 安装到该副本使用的 npm 插件环境。

包内预编译文件可直接安装。重建原生兼容层需要匹配的 TypeScript 工具链、Node 类型声明和明确的原生依赖锚点，详见 tgz 内 `upstream/dsh-agent-loop/HOST_COMPAT.md`、`upstream/dsh-tools/HOST_COMPAT.md`。

当前最终包已通过六项安装验收及一次四组件回退后的旧会话续行检查。真实模型、实际浏览器和生产替换仍未执行，详见 `ACCEPTANCE.md`。
'''
(stage / 'README.md').write_text(guide, encoding='utf-8')
files = sorted(p for p in stage.rglob('*') if p.is_file())
for file in files:
    if file.suffix in ['.md', '.json', '.log', '.tap', '.mjs', '.py']:
        data = file.read_bytes()
        assert not re.search(rb'\bsk-[A-Za-z0-9]{25,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', data), file.name
checksums = '\n'.join(digest(p.read_bytes()) + '  ' + p.relative_to(stage).as_posix() for p in files) + '\n'
(stage / 'SHA256SUMS.txt').write_text(checksums, encoding='utf-8')
archive = artifacts / f'cortico-dsh-host-plugin-{version}-windows-x64.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for path in sorted(stage.rglob('*')):
        if path.is_file():
            z.write(path, path.relative_to(stage).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for line in checksums.splitlines():
        checksum, path = line.split('  ', 1)
        assert digest(z.read(path)) == checksum
result = {'path': str(archive), 'bytes': archive.stat().st_size, 'sha256': digest(archive.read_bytes()),
          'packageSha256': receipt['packageSha256'], 'files': len(files) + 1, 'stage': str(stage)}
(artifacts / 'DELIVERY.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
