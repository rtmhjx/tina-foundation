#!/usr/bin/env python3
"""Prepare a separate cold deployment copy. No service or Provider activation."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess


def load_backup_module():
    spec = importlib.util.spec_from_file_location('upgrade_backup', Path(__file__).with_name('server-upgrade-backup.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def relocate_path(value, old, new):
    if not isinstance(value, str) or not value.startswith('/'):
        return value
    path = Path(value)
    if path == old or old in path.parents:
        return str(new / path.relative_to(old))
    return value


def require_owned_path(path, target):
    path = Path(path)
    real_target = target.resolve(strict=True)
    real = path.resolve(strict=True)
    if real == real_target or real_target not in real.parents:
        raise RuntimeError('Mutable path escapes the independent deployment')
    current = real_target
    for part in path.relative_to(real_target).parts:
        current = current / part
        if current.is_symlink():
            raise RuntimeError('Mutable path uses a symbolic link')
    return real


def source_tables_digest(connection):
    # Protect every immutable source column and row, without printing payloads.
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert 'sources' in tables, 'Unsupported SelfMem source database'
    digest = hashlib.sha256()
    count = 0
    for row in connection.execute('SELECT rowid,* FROM sources ORDER BY rowid'):
        encoded = json.dumps(row, ensure_ascii=False, separators=(',', ':'), default=lambda blob: {'bytes': bytes(blob).hex()}).encode()
        digest.update(len(encoded).to_bytes(8, 'big'))
        digest.update(encoded)
        count += 1
    return {'rows': count, 'sha256': digest.hexdigest()}


def rebind_memory_cursor(database, old_authority, new_authority):
    connection = sqlite3.connect(str(database))
    try:
        before = source_tables_digest(connection)
        rows = connection.execute('SELECT authority,localCursor,remoteCursor FROM sync_state ORDER BY authority').fetchall()
        assert not any(row[0] == new_authority for row in rows), 'Target authority cursor already exists'
        expected = [tuple([new_authority if row[0] == old_authority else row[0], *row[1:]]) for row in rows]
        assert any(row[0] == old_authority for row in rows), 'Original authority cursor missing'
        with connection:
            connection.execute('UPDATE sync_state SET authority=? WHERE authority=?', (new_authority, old_authority))
            after = connection.execute('SELECT authority,localCursor,remoteCursor FROM sync_state ORDER BY authority').fetchall()
            assert sorted(after) == sorted(expected), 'Sync cursor changed beyond authority identity'
            assert source_tables_digest(connection) == before, 'Immutable sources changed'
        assert connection.execute('PRAGMA quick_check').fetchall() == [('ok',)]
        return {'sourceIntegrity': before, 'cursorsPreserved': True, 'authorityRebound': True}
    finally:
        connection.close()


def rebind_intake(database, old, new):
    connection = sqlite3.connect(str(database))
    changes = []
    try:
        rows = connection.execute('SELECT id,body FROM intake_cursor ORDER BY id').fetchall()
        with connection:
            for identity, body in rows:
                original = json.loads(body)
                next_value = copy.deepcopy(original)
                path = original.get('path')
                mapped = relocate_path(path, old, new)
                if mapped == path:
                    continue
                previous_file, target_file = Path(path), Path(mapped)
                assert previous_file.is_file() and target_file.is_file()
                assert not previous_file.is_symlink() and not target_file.is_symlink()
                with previous_file.open('rb') as source, target_file.open('rb') as destination:
                    assert hashlib.file_digest(source, 'sha256').digest() == hashlib.file_digest(destination, 'sha256').digest()
                info = target_file.stat()
                assert 0 <= original['offset'] <= info.st_size
                for key in ['prefix', 'checkpoint']:
                    marker = original.get(key)
                    if marker is None:
                        continue
                    assert marker['start'] >= 0 and marker['size'] >= 0 and marker['start'] + marker['size'] <= info.st_size
                    with target_file.open('rb') as file:
                        file.seek(marker['start'])
                        assert hashlib.sha256(file.read(marker['size'])).hexdigest() == marker['hash'], 'Collector marker does not match copied cache'
                next_value.update(path=mapped, identity=f'{info.st_dev}:{info.st_ino}' if original.get('identity') is not None else None)
                assert {k: v for k, v in next_value.items() if k not in ('path', 'identity')} == {k: v for k, v in original.items() if k not in ('path', 'identity')}
                connection.execute('UPDATE intake_cursor SET body=? WHERE id=?', (json.dumps(next_value, ensure_ascii=False, separators=(',', ':')), identity))
                changes.append({'id': identity, 'offset': original['offset'], 'generation': original['generation']})
        assert connection.execute('PRAGMA quick_check').fetchall() == [('ok',)]
        return {'rows': len(rows), 'rebound': changes, 'positionsPreserved': True}
    finally:
        connection.close()


def rebind_git(new_state, old_state):
    changes = []
    for directory, dirs, _files in os.walk(new_state, followlinks=False):
        if '.git' not in dirs:
            continue
        dirs.remove('.git')
        repository = Path(directory)
        if (repository / '.git').is_symlink():
            raise RuntimeError('Linked Git metadata requires separate review')
        def git(*args):
            return subprocess.run(['git', '-C', str(repository), *args], check=True, capture_output=True, text=True,
                                  env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}).stdout.strip()
        before = git('rev-parse', 'HEAD')
        for remote in git('remote').splitlines():
            urls = git('config', '--get-all', f'remote.{remote}.url').splitlines()
            pushed = subprocess.run(['git', '-C', str(repository), 'config', '--get-all', f'remote.{remote}.pushurl'], capture_output=True, text=True)
            assert pushed.returncode in (0, 1)
            if len(urls) != 1 or pushed.stdout.strip():
                raise RuntimeError('Multiple fetch URLs or explicit push URLs require reviewed relocation')
            original = urls[0]
            target = relocate_path(original, old_state, new_state)
            if str(old_state) in original and target == original:
                raise RuntimeError('Unsupported Git URL still references original deployment')
            if target != original:
                git('remote', 'set-url', remote, target)
                assert git('remote', 'get-url', remote) == target
                changes.append({'repository': str(repository.relative_to(new_state)), 'remote': remote})
        assert git('rev-parse', 'HEAD') == before
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup', required=True, type=Path)
    parser.add_argument('--target', required=True, type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    backup = load_backup_module()
    receipt = json.loads((args.backup / 'BACKUP.json').read_text())
    assert receipt['status'] == 'verified-cold-backup'
    assert backup.digest(args.backup / 'MANIFEST.json') == receipt['manifestSha256']
    assert backup.digest(args.backup / 'INTEGRITY.json') == receipt['integritySha256']
    old = Path(receipt['state']).resolve(strict=True)
    target = args.target.absolute()
    assert old.parent == target.parent == backup.BASE / 'deployments' and target != old
    assert target.parent.resolve(strict=True) == target.parent, 'Target parent may not redirect'
    assert not target.exists() and not target.is_symlink(), 'Target deployment must be new'
    manifest = json.loads((args.backup / 'MANIFEST.json').read_text())
    prefix = str(old.relative_to('/'))
    selected = {name: row for name, row in manifest.items() if name == prefix or name.startswith(prefix + '/')}
    required = sum(row.get('bytes', 0) for row in selected.values())
    print(json.dumps({'apply': args.apply, 'source': str(old), 'target': str(target), 'files': len(selected), 'bytes': required}))
    if not args.apply:
        return
    os.umask(0o077)
    roots = [Path(value) for value in receipt['sourceRoots']]
    backup.assert_stopped(roots)
    assert backup.digest(args.backup / 'snapshot.tar.zst') == receipt['archiveSha256']
    assert backup.inventory([old]) == selected, 'Cold source changed after backup'
    assert shutil.disk_usage(target.parent).free > required + 2 * 1024**3, 'Not enough space for a separate physical deployment'
    subprocess.run(['cp', '-a', '--reflink=auto', '--', str(old), str(target)], check=True)
    copied = backup.inventory([target])
    expected = {str(target.relative_to('/')) + name[len(prefix):]: row for name, row in selected.items()}
    assert copied == expected, 'Physical deployment copy differs from cold source'
    migration = {'status': 'copied', 'source': str(old), 'target': str(target), 'backup': str(args.backup),
                 'sourceManifestSha256': receipt['manifestSha256'], 'initialCopyVerified': True, 'symlinks': []}
    backup.save(target / 'UPGRADE-STATE.json', migration)
    for directory, dirs, files in os.walk(target, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if not path.is_symlink():
                continue
            value = os.readlink(path)
            mapped = relocate_path(value, old, target)
            if mapped != value:
                path.unlink()
                path.symlink_to(mapped)
                migration['symlinks'].append(str(path.relative_to(target)))
    config_path = target / 'deployment/config.json'
    require_owned_path(config_path, target)
    config = json.loads(config_path.read_text())
    for key in ['dataDir', 'authorityDir', 'deviceDir', 'seedFile']:
        config['selfMem'][key] = relocate_path(config['selfMem'][key], old, target)
    memory = config['selfMem']
    for key in ['dataDir', 'authorityDir', 'deviceDir', 'seedFile']:
        require_owned_path(memory[key], target)
    source_database = require_owned_path(Path(memory['deviceDir']) / 'sources.sqlite', target)
    collector_database = require_owned_path(target / 'intake/collector-state.sqlite', target)
    backup.save(config_path, config)
    new_authority = memory['authorityDir']
    old_authority = relocate_path(new_authority, target, old)
    migration['memory'] = rebind_memory_cursor(source_database, old_authority, new_authority)
    migration['intake'] = rebind_intake(collector_database, old, target)
    migration['gitRemotes'] = rebind_git(target, old)
    # The native header is immutable; its official persistence relocation is a
    # separate mandatory step, with its own original-byte and semantic receipt.
    migration.update(status='prepared-awaiting-native-relocation', nativeRelocationRequired=True,
                     providerActivated=False, servicesStarted=False)
    backup.save(target / 'UPGRADE-STATE.json', migration)
    backup.assert_stopped(roots)
    assert backup.inventory([old]) == selected, 'Original deployment changed during preparation'
    print(json.dumps({'status': migration['status'], 'target': str(target), 'receipt': str(target / 'UPGRADE-STATE.json')}))


if __name__ == '__main__':
    main()
