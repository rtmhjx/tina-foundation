import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
package = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(json.loads((root / 'artifacts/PACKAGE.json').read_text(encoding='utf-8'))['packagePath'])
actual = {}
manifest = None
links = []
suspect_paths = []
secret_hits = []
patterns = [re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'), re.compile(rb'\bsk-[A-Za-z0-9]{25,}\b')]
with tarfile.open(package, 'r|gz') as archive:
    for member in archive:
        path = member.name.removeprefix('package/')
        assert member.name.startswith('package/') and '..' not in Path(path).parts
        if not member.isfile():
            if member.issym() or member.islnk():
                links.append(path)
            continue
        data = archive.extractfile(member).read()
        actual[path] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        if path == 'BUILD-MANIFEST.json':
            manifest = json.loads(data)
        if re.search(r'(^|/)(?:\.env|\.credentials[^/]*|sources\.sqlite|credentials\.json)(?:/|$)', path) or path.startswith(('sessions/', 'runtime/', '.test-runtime/')):
            suspect_paths.append(path)
        if re.search(r'(^|/)node_modules/@deepseek-ai/', path):
            suspect_paths.append(path)
        if not path.startswith('node_modules/') and path.endswith(('.mjs', '.js', '.ts', '.json', '.md', '.yaml')):
            if any(p.search(data) for p in patterns):
                secret_hits.append(path)
assert manifest is not None
expected = {row['path']: {'sha256': row['sha256'], 'bytes': row['bytes']} for row in manifest['files']}
missing = sorted(expected.keys() - actual.keys())
extra = sorted(actual.keys() - expected.keys() - {'BUILD-MANIFEST.json'})
mismatch = sorted(path for path in expected.keys() & actual.keys() if expected[path] != actual[path])
result = {'package': str(package), 'sha256': hashlib.sha256(package.read_bytes()).hexdigest(),
          'archiveFiles': len(actual), 'manifestFiles': len(expected), 'missing': missing,
          'extra': extra, 'mismatch': mismatch, 'links': links, 'suspectPaths': suspect_paths,
          'possibleSecretFiles': secret_hits, 'bundledHostIdentityPackages': False}
print(json.dumps(result, ensure_ascii=False, indent=2))
if missing or extra or mismatch or links or suspect_paths or secret_hits:
    raise SystemExit(1)
