"""Reconstruct an isolated API baseline. Never writes the source installation."""
import hashlib
import json
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

project = Path(__file__).resolve().parents[1]
source = project / '.test-runtime/dsh'
target = project / '.test-runtime/stock-dsh'
official = Path(sys.argv[1])
if not official.is_absolute() or not (official / 'packages/core/agent-loop/lib/index.js').is_file():
    raise SystemExit('Pass the explicit read-only pinned DSH source-build root.')
target.mkdir(parents=True, exist_ok=True)
manifest = json.loads((source / 'runtime-manifest.json').read_text(encoding='utf-8'))
count = 0
jobs = []
for package in manifest['packages']:
    for row in package['files']:
        relative = Path(package['output']) / row['path']
        assert not relative.is_absolute() and '..' not in relative.parts
        dest = target / relative
        jobs.append((source / relative, dest))
        count += 1
def copy_one(pair):
    original, dest = pair
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.read_bytes() == original.read_bytes():
        return
    shutil.copyfile(original, dest)
with ThreadPoolExecutor(max_workers=12) as executor:
    for completed, _ in enumerate(executor.map(copy_one, jobs), 1):
        if completed % 6000 == 0:
            print(f'Copied and checked {completed}/{count} public runtime files.', flush=True)
for name in ['runtime-manifest.json', 'runtime-links.json']:
    shutil.copyfile(source / name, target / name)
components = {
    '@deepseek-ai/dsh-agent-loop': 'packages/core/agent-loop',
    '@deepseek-ai/dsh-tools': 'packages/core/tools',
    '@deepseek-ai/dsh-client-file-upload': 'packages/client/file-upload',
    '@deepseek-ai/dsh-session': 'packages/core/session',
    '@deepseek-ai/dsh-api-session-controller': 'packages/api/session-controller',
}
restored = []
for name, folder in components.items():
    package = next(p for p in manifest['packages'] if p['name'] == name)
    destination = target / package['output']
    baseline = official / folder
    shutil.copytree(baseline / 'lib', destination / 'lib', dirs_exist_ok=True)
    shutil.copyfile(baseline / 'package.json', destination / 'package.json')
    restored.append({'name': name, 'version': json.loads((baseline / 'package.json').read_text())['version'],
                     'indexSha256': hashlib.sha256((destination / 'lib/index.js').read_bytes()).hexdigest()})
receipt = {'target': str(target), 'sourceUntouched': str(source), 'baselineSource': str(official),
           'filesCopied': count, 'restoredNativeComponents': restored,
           'label': 'Pinned source-built DSH without inherited fusion API extensions; dependencies copied only.'}
(project / 'STOCK_READY.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(receipt, ensure_ascii=False, indent=2))
