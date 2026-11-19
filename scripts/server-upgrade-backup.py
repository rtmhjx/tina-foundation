#!/usr/bin/env python3
"""Private, verified cold backup for this upgrade; default is read-only.

The live release/state are explicit inputs. No credentials or record contents
are printed. A successful backup leaves the known writers stopped for cutover;
a failed backup restores only units that were active before this invocation.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile

if sys.flags.optimize:
    raise RuntimeError('Deployment checks require Python assertions; do not use -O')

BASE = Path('/home/tina/tina-runtime')
MAIN = 'cortico-tina-main.service'
STOP_ORDER = ['tina-agent-memory-intake.timer', 'tina-agent-memory-intake.service',
              'tina-memory-gateway.service', MAIN, 'tina-session-archive.service']
START_ORDER = [MAIN, 'tina-memory-gateway.service', 'tina-session-archive.service',
               'tina-agent-memory-intake.service',
               'tina-agent-memory-intake.timer']


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def save(path, value):
    path = Path(path).absolute()
    assert path.parent.resolve(strict=True) == path.parent, 'Receipt parent may not redirect'
    descriptor, name = tempfile.mkstemp(prefix='.' + path.name + '-', suffix='.tmp', dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as file:
            json.dump(value, file, ensure_ascii=False, indent=2)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        temp.replace(path)
        fsync_path(path.parent)
    finally:
        if temp.exists():
            temp.unlink()


def fsync_path(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def unit_state(name):
    props = 'Id,ActiveState,SubState,MainPID,FragmentPath,DropInPaths,WorkingDirectory,EnvironmentFiles'
    lines = run(['systemctl', '--user', 'show', name, '--property=' + props]).stdout
    return dict(line.split('=', 1) for line in lines.splitlines() if '=' in line)


def roots_for(state, release, units):
    roots = [state, release, BASE / 'state/tina-memory-gateway',
             BASE / 'assembly/session-archive', BASE / 'cortico-self', BASE / 'agent-intake']
    config = json.loads((state / 'deployment/config.json').read_text())
    for key in ['dataDir', 'authorityDir', 'deviceDir', 'seedFile']:
        configured = config.get('selfMem', {}).get(key)
        if configured:
            path = Path(configured)
            if not path.is_absolute():
                raise RuntimeError('Resolve relative SelfMem paths explicitly before backup')
            roots.append(path.resolve(strict=True))
    roots.extend((state / relative).resolve(strict=True) for relative in
                 ['native/dsh-embedded/home', 'native/dsh-embedded/workspace', 'deployment/workspace'])
    modules = state / 'extensions/node_modules'
    for item in modules.iterdir():
        if item.is_symlink():
            roots.append(item.resolve(strict=True))
        children = list(item.iterdir()) if item.name.startswith('@') and item.is_dir() else [item]
        for child in children:
            if child.is_symlink():
                if not child.exists():
                    raise RuntimeError('Broken extension link: ' + str(child))
                roots.append(child.resolve())
    for info in units.values():
        roots.append(Path(info['FragmentPath']))
        roots.extend(Path(value) for value in info.get('DropInPaths', '').split())
        env = info.get('EnvironmentFiles', '')
        expression = r'(/[^\s]+) \(ignore_errors=(?:yes|no)\)'
        if re.sub(expression, '', env).strip():
            raise RuntimeError('Unknown EnvironmentFiles encoding')
        roots.extend(Path(value) for value in re.findall(expression, env))
    selected = []
    for path in sorted(set(roots), key=lambda value: (len(value.parts), str(value))):
        if not path.is_relative_to('/home/tina'):
            raise RuntimeError('Backup root is outside the inventoried account')
        if (path.exists() or path.is_symlink()) and not any(path == p or p in path.parents for p in selected):
            selected.append(path)
    return selected


def verify_acceptance(acceptance):
    assert acceptance.get('kind') == 'tina-gpt-max-full-acceptance-v1' and acceptance.get('version') == 1
    assert acceptance.get('passed') is True
    assert acceptance.get('plan', {}).get('model') == 'gpt-6-astra'
    assert acceptance.get('plan', {}).get('effort') == 'max'
    required = ['chat', 'rp', 'read', 'compaction', 'restart']
    assert acceptance['plan'].get('requiredPhases') == required
    checks = ['allRequiredPhases', 'exactWireModelEffort', 'actualReturnedModelEffort', 'noFallbackOrUltraClaim',
              'automaticPressureCommitted', 'ownedHardRestart', 'twoDistinctProcessExecutions', 'codeStable',
              'finalShutdownComplete', 'noUnresolvedFailure']
    assert all(acceptance.get('checks', {}).get(key) is True for key in checks)
    phases = acceptance.get('phases', [])
    assert [phase.get('name') for phase in phases] == required
    for phase in phases:
        assert phase.get('passed') is True and phase.get('checks')
        assert all(value is True for value in phase['checks'].values())
    for field in ['sha256', 'sourceSha256', 'runtimeSha256', 'marketSha256']:
        assert re.fullmatch('[a-f0-9]{64}', acceptance.get('source', {}).get(field, ''))
    requests = acceptance['requests']
    assert requests['count'] > 0 and requests['completed'] > 0
    assert requests['requestedModels'] == requests['actualModels'] == ['gpt-6-astra']
    assert requests['requestedEfforts'] == requests['actualEfforts'] == ['max']
    restart = acceptance['hardRestart']
    assert restart['killedBySupervisor'] is True and restart['orderlyAppClose'] is False
    assert restart['exit']['signal'] == 'SIGKILL' and restart['ready']['pid'] == restart['childPid']
    assert restart['ready']['nativeSessionId'] == acceptance['nativeSessionId']
    compaction = acceptance['automaticCompaction']
    assert compaction['maintenance']['reason'] == 'pressure' and compaction['maintenance']['phase'] == 'complete'
    assert compaction['maintenance']['nativeReceipt']['durable'] is True
    assert compaction['checks'] and all(value is True for value in compaction['checks'].values())
    assert acceptance['shutdown']['finalComplete'] is True and not acceptance['shutdown'].get('error')


def walk(root):
    yield root
    if root.is_dir() and not root.is_symlink():
        for directory, dirs, files in os.walk(root, followlinks=False):
            for name in dirs + files:
                yield Path(directory) / name


def assert_live_state(state, units):
    pid = int(units[MAIN]['MainPID'])
    assert pid > 0, 'The current main process must be identified before stopping it'
    values = dict(item.split(b'=', 1) for item in (Path('/proc') / str(pid) / 'environ').read_bytes().split(b'\0') if b'=' in item)
    effective = values.get(b'CORTICO_FUSION_STATE')
    assert effective and Path(os.fsdecode(effective)).resolve(strict=True) == state, 'Requested state differs from the running main process'


def assert_stopped(roots):
    for name in STOP_ORDER:
        if unit_state(name)['ActiveState'] not in ('inactive', 'failed'):
            raise RuntimeError('Writer is still active: ' + name)
    holders = set()
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            for fd in (proc / 'fd').iterdir():
                try:
                    target = os.readlink(fd)
                    info = (proc / 'fdinfo' / fd.name).read_text()
                    flags = int(re.search(r'^flags:\s+(\d+)', info, re.M)[1], 8)
                    target_path = Path(target.removesuffix(' (deleted)'))
                    if any(target_path == root or root in target_path.parents for root in roots) and (flags & os.O_ACCMODE) in (os.O_WRONLY, os.O_RDWR):
                        holders.add(int(proc.name))
                except (OSError, TypeError):
                    continue
        except (OSError, PermissionError):
            continue
    if holders:
        raise RuntimeError('Unowned state writers remain: ' + ','.join(map(str, sorted(holders))))


def inventory(roots):
    rows = {}
    for root in roots:
        for path in walk(root):
            info = path.lstat()
            row = {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
            if path.is_symlink():
                row.update(kind='link', target=os.readlink(path))
            elif path.is_file():
                row.update(kind='file', bytes=info.st_size, sha256=digest(path))
                with path.open('rb') as file:
                    if file.read(16) == b'SQLite format 3\x00':
                        row['database'] = 'sqlite'
            elif path.is_dir():
                row.update(kind='directory')
            else:
                raise RuntimeError('Special filesystem entry requires separate backup handling')
            rows[str(path.relative_to('/'))] = row
    return rows


def verify_databases_and_git(rows, temporary_parent):
    databases, repositories = [], []
    for name, row in rows.items():
        path = Path('/') / name
        if row.get('database') == 'sqlite':
            # A private physical copy includes every cold companion. Opening the
            # copy may recover WAL/journal state without mutating the original.
            with tempfile.TemporaryDirectory(prefix='sqlite-check-', dir=temporary_parent) as temporary:
                copy = Path(temporary) / path.name
                for suffix in ['', '-wal', '-shm', '-journal']:
                    source = Path(str(path) + suffix)
                    if source.exists():
                        shutil.copy2(source, Path(str(copy) + suffix))
                connection = sqlite3.connect(str(copy))
                try:
                    checks = connection.execute('PRAGMA quick_check').fetchall()
                    assert checks == [('ok',)], 'Cold SQLite integrity check failed: ' + str(path)
                    databases.append({'path': str(path), 'quickCheck': 'ok',
                                      'userVersion': connection.execute('PRAGMA user_version').fetchone()[0]})
                finally:
                    connection.close()
        if row['kind'] == 'directory' and ((path.name == '.git' and (path / 'objects').is_dir())
                or ((path / 'HEAD').is_file() and (path / 'objects').is_dir() and (path / 'refs').is_dir())):
            environment = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}
            result = subprocess.run(['git', '--git-dir=' + str(path), 'fsck', '--full', '--no-reflogs'],
                                    capture_output=True, text=True, env=environment)
            assert result.returncode == 0, 'Cold Git integrity check failed: ' + str(path)
            repositories.append({'gitDir': str(path), 'fsck': 'passed'})
    return {'sqlite': databases, 'git': repositories}


def verify_archive(archive, rows):
    remaining = dict(rows)
    process = subprocess.Popen(['zstd', '-dc', '--', str(archive)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as stream:
            for member in stream:
                name = member.name.rstrip('/')
                expected = remaining.pop(name, None)
                if expected is None:
                    raise RuntimeError('Unexpected or duplicate archive member')
                assert member.mode == expected['mode'] and member.uid == expected['uid'] and member.gid == expected['gid'], 'Archive metadata differs'
                if member.issym():
                    assert expected['kind'] == 'link' and member.linkname == expected['target']
                elif member.isdir():
                    assert expected['kind'] == 'directory'
                elif member.isfile():
                    assert expected['kind'] == 'file' and member.size == expected['bytes']
                    h = hashlib.sha256()
                    file = stream.extractfile(member)
                    for chunk in iter(lambda: file.read(8 * 1024 * 1024), b''):
                        h.update(chunk)
                    assert h.hexdigest() == expected['sha256'], 'Archived content hash differs'
                else:
                    raise RuntimeError('Special archive member is not supported')
        assert process.wait() == 0, 'zstd decompression failed'
        assert not remaining, 'Archive is missing manifest entries'
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--acceptance', type=Path)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    assert socket.gethostname() == 'tina' and os.getuid() == pwd.getpwnam('tina').pw_uid, 'Run as the actual Tina user on tina'
    state, release = args.state.resolve(strict=True), args.release.resolve(strict=True)
    assert state.parent == BASE / 'deployments' and release.parent == BASE / 'releases'
    units = {name: unit_state(name) for name in STOP_ORDER}
    assert units[MAIN]['WorkingDirectory'] == str(release), 'The live release changed'
    assert_live_state(state, units)
    roots = roots_for(state, release, units)
    plan = {'state': str(state), 'release': str(release), 'sourceRoots': list(map(str, roots)),
            'units': units, 'stopOrder': STOP_ORDER, 'crossDatabaseAtomicSnapshot': False}
    if not args.execute:
        print(json.dumps({'execute': False, 'plan': plan}, ensure_ascii=False))
        return
    assert args.acceptance, 'A reviewed real-model acceptance receipt is required'
    acceptance = json.loads(args.acceptance.read_text())
    verify_acceptance(acceptance)
    os.umask(0o077)
    target = BASE / 'backups' / ('fusion9-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    target.mkdir(mode=0o700)
    plan.update(status='stopping-writers', backup=str(target), acceptanceSha256=digest(args.acceptance))
    save(target / 'BACKUP.json', plan)
    try:
        for name in STOP_ORDER:
            run(['systemctl', '--user', 'stop', name])
        assert_stopped(roots)
        rows = inventory(roots)
        save(target / 'MANIFEST.json', rows)
        plan.update(status='archiving-cold-state', files=len(rows), bytes=sum(row.get('bytes', 0) for row in rows.values()))
        save(target / 'BACKUP.json', plan)
        archive = target / 'snapshot.tar.zst'
        # Dereference hard links, but preserve symlinks and full private metadata.
        run(['tar', '--hard-dereference', '-I', 'zstd -T2 -3', '-cpf', str(archive), '-C', '/', '--',
             *[str(path.relative_to('/')) for path in roots]])
        fsync_path(archive)
        fsync_path(target)
        run(['zstd', '-t', '--', str(archive)])
        verify_archive(archive, rows)
        integrity = verify_databases_and_git(rows, target)
        save(target / 'INTEGRITY.json', integrity)
        assert_stopped(roots)
        assert inventory(roots) == rows, 'Cold source inventory changed during backup'
        plan.update(status='verified-cold-backup', archiveSha256=digest(archive),
                    manifestSha256=digest(target / 'MANIFEST.json'), archiveBytes=archive.stat().st_size,
                    integritySha256=digest(target / 'INTEGRITY.json'),
                    sourceBytesVerified=True, servicesRemainStopped=True)
        save(target / 'BACKUP.json', plan)
        print(json.dumps({key: plan[key] for key in ['status', 'backup', 'files', 'bytes', 'archiveBytes', 'archiveSha256']}))
    except BaseException:
        failures = []
        for name in START_ORDER:
            if units[name]['ActiveState'] == 'active':
                try:
                    run(['systemctl', '--user', 'start', name])
                except Exception:
                    failures.append(name)
        plan.update(status='backup-failed', restoreFailures=failures)
        save(target / 'BACKUP.json', plan)
        raise


if __name__ == '__main__':
    main()
