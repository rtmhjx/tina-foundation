#!/usr/bin/env python3
"""Route the verified upgrade through explicit new systemd drop-ins; default plan."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import sys
import tempfile
import urllib.request

if sys.flags.optimize:
    raise RuntimeError('Do not disable deployment assertions with -O')


def backup_module():
    spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('server-upgrade-backup.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def invocation(backup, name):
    return backup.run(['systemctl', '--user', 'show', name, '--property=InvocationID', '--value']).stdout.strip()


def durable_routing_receipt(backup, path, receipt, *, create=False):
    """Persist an owned receipt without following or truncating a pre-existing tmp."""
    assert path.parent.resolve(strict=True) == path.parent
    data = (json.dumps(receipt, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    fd, name = tempfile.mkstemp(prefix='.routing-receipt-', dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        if create:
            os.link(temp, path, follow_symlinks=False)
        else:
            assert path.is_file() and not path.is_symlink(), 'Routing receipt changed'
            os.replace(temp, path)
        backup.fsync_path(path.parent)
    finally:
        if os.path.lexists(temp):
            temp.unlink()


def publish_dropin(backup, path, content, expected, before_publish, on_published):
    """Publish an anonymous inode exclusively; never leave a named temporary."""
    import ctypes
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    assert path.parent.resolve(strict=True) == path.parent, 'Drop-in parent may not redirect'
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fd = None
    try:
        # No named fallback: unsupported filesystems or inaccessible /proc
        # must fail before publication, leaving the prior route untouched.
        fd = os.open('.', os.O_TMPFILE | os.O_RDWR | os.O_CLOEXEC, 0o600, dir_fd=directory)
        data = content.encode('utf-8')
        offset = 0
        while offset < len(data):
            count = os.write(fd, data[offset:])
            if count <= 0:
                raise OSError('Unable to write anonymous drop-in')
            offset += count
        os.fsync(fd)
        os.lseek(fd, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        while chunk := os.read(fd, 65536):
            digest.update(chunk)
        assert digest.hexdigest() == expected
        info = os.fstat(fd)
        # Persist the actual inode before publication. A same-content file
        # created by somebody else is not an owned drop-in.
        before_publish({'device': info.st_dev, 'inode': info.st_ino})
        assert os.path.samestat(os.fstat(directory), path.parent.stat()), 'Drop-in directory changed'
        linkat = ctypes.CDLL(None, use_errno=True).linkat
        linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        linkat.restype = ctypes.c_int
        source = os.fsencode('/proc/self/fd/' + str(fd))
        result = linkat(-100, source, directory, os.fsencode(path.name), 0x400)  # AT_SYMLINK_FOLLOW
        if result != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), str(path))
        on_published()
        os.fsync(directory)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)


def recover_unstarted_routing(backup, receipt_path, receipt, paths, contents, cold, state, release):
    """Reconcile an interrupted pre-start write using the durable intent and hashes."""
    assert receipt.get('state') == str(state) and receipt.get('release') == str(release)
    status = receipt.get('status')
    assert status in ('routing-writing', 'routing-written', 'recovered-before-start'), 'Not a recoverable pre-start transaction'
    assert not receipt.get('startedUnits'), 'Started unit identities require normal rollback'
    if status == 'recovered-before-start':
        assert all(not os.path.lexists(path) for path in paths.values()), 'Drop-in exists after recovery; inspect'
        assert backup.unit_state(backup.MAIN)['WorkingDirectory'] == cold['release'], 'Prior routing changed after recovery'
        return
    roots = [state, *[Path(value) for value in cold['sourceRoots']]]
    backup.assert_stopped(roots)
    # Preflight every path before removing any; missing paths are idempotent.
    for name, path in paths.items():
        expected = hashlib.sha256(contents[name].encode('utf-8')).hexdigest()
        entry = receipt.get('dropIns', {}).get(name, {})
        assert entry.get('path') == str(path) and entry.get('sha256') == expected, 'Routing intent differs from this candidate'
        if os.path.lexists(path):
            assert path.parent.resolve(strict=True) == path.parent and not path.is_symlink()
            info = path.stat()
            assert entry.get('fileId') == {'device': info.st_dev, 'inode': info.st_ino}, 'Unowned drop-in; inspect before recovery'
            assert path.is_file() and backup.digest(path) == expected, 'Owned drop-in changed; inspect before recovery'
    for path in paths.values():
        if os.path.lexists(path):
            path.unlink()
            backup.fsync_path(path.parent)
    backup.run(['systemctl', '--user', 'daemon-reload'])
    assert backup.unit_state(backup.MAIN)['WorkingDirectory'] == cold['release'], 'Prior routing did not restore'
    receipt.update(status='recovered-before-start', newMemoryAndSessionsPreserved=True)
    durable_routing_receipt(backup, receipt_path, receipt)


def undo_owned_routing(backup, receipt, paths, written, cold, state):
    """Never stop a unit merely because it appears in an old backup list."""
    owned = receipt.get('startedUnits', {})
    errors = []
    for name in backup.STOP_ORDER:
        current = backup.unit_state(name)
        if current['ActiveState'] in ('inactive', 'failed'):
            continue
        identity = owned.get(name)
        if not identity or invocation(backup, name) != identity:
            errors.append('Unowned running unit: ' + name)
            continue
        try:
            backup.run(['systemctl', '--user', 'stop', name])
        except Exception:
            errors.append('Could not stop owned unit: ' + name)
    if errors:
        return errors
    try:
        backup.assert_stopped([state, *[Path(value) for value in cold['sourceRoots']]])
    except Exception:
        return ['Writer barrier failed; routing retained for inspection']
    for path in written:
        try:
            if os.path.lexists(path):
                name = next(name for name, target in paths.items() if target == path)
                assert path.parent.resolve(strict=True) == path.parent and not path.is_symlink()
                file_id = receipt['dropIns'][name].get('fileId')
                if file_id is not None:
                    info = path.stat()
                    assert file_id == {'device': info.st_dev, 'inode': info.st_ino}, 'Unowned drop-in'
                assert backup.digest(path) == receipt['dropIns'][name]['sha256']
                path.unlink()
                backup.fsync_path(path.parent)
        except Exception:
            errors.append('Could not remove unchanged owned drop-in: ' + str(path))
    if errors:
        return errors
    try:
        backup.run(['systemctl', '--user', 'daemon-reload'])
        assert backup.unit_state(backup.MAIN)['WorkingDirectory'] == cold['release']
    except Exception:
        return ['Previous routing did not restore; services remain stopped']
    for name in backup.START_ORDER:
        if cold['units'][name]['ActiveState'] == 'active':
            try:
                backup.run(['systemctl', '--user', 'start', name])
            except Exception:
                errors.append('Previous unit could not start: ' + name)
    return errors


def process_identity(backup, service, release, state):
    """Read the currently running service identity without exposing its environment."""
    current = backup.unit_state(service)
    assert current['ActiveState'] == 'active' and current['WorkingDirectory'] == str(release)
    pid = int(current['MainPID'])
    assert pid > 0
    proc = Path('/proc') / str(pid)
    assert (proc / 'cwd').resolve(strict=True) == release, 'Running process has another release'
    env = dict(item.split(b'=', 1) for item in (proc / 'environ').read_bytes().split(b'\0') if b'=' in item)
    assert Path(os.fsdecode(env[b'CORTICO_FUSION_STATE'])).resolve(strict=True) == state
    assert Path(os.fsdecode(env[b'CORTICO_FUSION_DSH_ROOT'])).resolve(strict=True) == release / 'runtime/dsh-0.1.5-rc.2'
    status = (proc / 'stat').read_text()
    start_ticks = status[status.rfind(')') + 2:].strip().split()[19]
    assert start_ticks.isdigit()
    result = {'service': service, 'pid': pid, 'invocationId': invocation(backup, service),
              'startTicks': start_ticks, 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    assert result['invocationId'] and backup.unit_state(service)['MainPID'] == str(pid)
    return result


def loop_state(resume=False):
    url = 'http://127.0.0.1:7789/api/run/resume' if resume else 'http://127.0.0.1:7789/api/status'
    request = urllib.request.Request(url, data=b'{}' if resume else None,
                                     headers={'Origin': 'http://127.0.0.1:7789', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        result = json.load(response)
    value = result.get('paused') if resume else result.get('loop', {}).get('paused')
    assert isinstance(value, bool), 'The current loop state is not available'
    return value


def world_states():
    request = urllib.request.Request('http://127.0.0.1:7789/api/worlds', headers={'Origin': 'http://127.0.0.1:7789'})
    with urllib.request.urlopen(request, timeout=10) as response:
        data = json.load(response)
    return {item['id']: {'status': item['status'], 'visible': item.get('visible')} for item in data['worlds']}


def adopt_restart(backup, receipt_path, report_dir, release, state, session_id, *, read_identity=None, read_paused=None, apply=True):
    """Bind the validated post-restart process before any activation side effect."""
    read_identity = read_identity or (lambda: process_identity(backup, backup.MAIN, release, state))
    read_paused = read_paused or loop_state
    assert receipt_path.parent.resolve(strict=True) == receipt_path.parent and not receipt_path.is_symlink()
    receipt = json.loads(receipt_path.read_text())
    assert receipt['state'] == str(state) and receipt['release'] == str(release)
    assert receipt['nativeSessionId'] == session_id
    assert receipt['status'] in ('started-paused-awaiting-real-server-validation', 'adopted-paused')
    report_dir = Path(report_dir)
    assert report_dir.resolve(strict=True) == report_dir and report_dir.is_relative_to(state)
    documents = {}
    for name in ('before.json', 'after-restart.json', 'checkpoint.json'):
        path = report_dir / name
        assert path.is_file() and not path.is_symlink()
        documents[name] = (json.loads(path.read_text()), backup.digest(path))
    before, after, checkpoint = (documents[name][0] for name in ('before.json', 'after-restart.json', 'checkpoint.json'))
    assert before['phase'] == 'before' and before['passed'] is True and not before.get('pauseFailed')
    assert after['phase'] == 'after-restart' and after['passed'] is True and after.get('restartVerified') is True and not after.get('pauseFailed')
    assert checkpoint['beforePassed'] is True and checkpoint['afterPassed'] is True
    assert checkpoint['state'] == str(state) and checkpoint['workspace'] == str(state / 'native/dsh-embedded/workspace')
    assert all(item['sessionId'] == session_id for item in (before, after, checkpoint))
    assert before['process'] == checkpoint['beforeProcess'] and before['after'] == checkpoint['beforeRestartPrefix']
    assert [item['name'] for item in before['phases']] == ['chat', 'rp', 'read']
    assert [item['name'] for item in after['phases']] == ['restart']
    assert all(item['passed'] is True and item['checks'] and all(v is True for v in item['checks'].values())
               for item in before['phases'] + after['phases'])
    first, last = before['process'], after['process']
    assert first['service'] == last['service'] == backup.MAIN
    # The acceptance format has no machine id. Require the same boot rather
    # than claiming cross-boot identity has been proved.
    assert first['bootId'] == last['bootId'] and first['invocationId'] != last['invocationId']
    assert first['pid'] != last['pid'] or first['startTicks'] != last['startTicks']
    previous = receipt.get('adoption', {}).get('before', first)
    assert previous == first
    expected_old = receipt.get('adoption', {}).get('before', {}).get('invocationId', receipt['startedUnits'].get(backup.MAIN))
    assert first['invocationId'] == expected_old
    assert read_identity() == last and read_paused() is True
    for name, entry in receipt['dropIns'].items():
        path = Path(entry['path'])
        assert path.parent.resolve(strict=True) == path.parent and not path.is_symlink()
        info = path.stat()
        assert entry['fileId'] == {'device': info.st_dev, 'inode': info.st_ino} and backup.digest(path) == entry['sha256']
    assert read_identity() == last, 'Service changed during identity adoption'
    receipt['adoption'] = {'before': first, 'after': last,
                           'reports': {name: documents[name][1] for name in documents}}
    receipt['startedUnits'][backup.MAIN] = last['invocationId']
    receipt['status'] = 'adopted-paused'
    if apply:
        durable_routing_receipt(backup, receipt_path, receipt)
    return receipt


def activate_adopted(backup, receipt_path, receipt, paths, contents, cold, state, release, *, read_identity=None, read_paused=None, read_worlds=None, resume=None):
    """Activate only the verified adopted process; ambiguous partial steps stop for inspection."""
    read_identity = read_identity or (lambda: process_identity(backup, backup.MAIN, release, state))
    read_paused = read_paused or loop_state
    read_worlds = read_worlds or world_states
    resume = resume or (lambda: loop_state(resume=True))
    assert receipt['status'] == 'adopted-paused' and read_identity() == receipt['adoption']['after'] and read_paused() is True
    world_receipt_path = state / 'WORLD-ACCEPTANCE-HOLD.json'
    assert world_receipt_path.is_file() and not world_receipt_path.is_symlink(), 'Restored World receipt is required before activation'
    world_receipt = json.loads(world_receipt_path.read_text())
    assert world_receipt.get('version') == 1 and world_receipt.get('status') == 'restored', 'Worlds must be restored before activation'
    assert world_receipt.get('state') == str(state) and world_receipt.get('release') == str(release)
    assert world_receipt.get('nativeSessionId') == receipt['nativeSessionId'] and world_receipt.get('process') == receipt['adoption']['after']
    assert world_receipt.get('stillPaused') is True and world_receipt.get('worldSettingsRestored') is True
    assert world_receipt.get('beforeReportSha256') == receipt['adoption']['reports']['before.json']
    assert world_receipt.get('afterReportSha256') == receipt['adoption']['reports']['after-restart.json']
    config_path = state / 'deployment/config.json'
    assert config_path.resolve(strict=True) == config_path
    worlds = json.loads(config_path.read_text())['worlds']
    config_hash = hashlib.sha256(json.dumps(worlds, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    assert config_hash == world_receipt.get('originalWorldsSha256') == world_receipt.get('restoredWorldsSha256')
    observed = read_worlds()
    recorded = world_receipt['worldStates']
    for name, prior in recorded.items():
        assert observed.get(name) == prior, 'World runtime state changed after restoration'
    for name, section in worlds.items():
        if section.get('enabled') is True:
            assert observed.get(name, {}).get('status') == 'active', 'An enabled World is not active'
        if section.get('enabled') is False and name in observed:
            assert observed[name].get('status') != 'active', 'An inactive World is unexpectedly active'
    for name, prior in world_receipt['restoredWorlds'].items():
        assert observed.get(name) == prior and prior['status'] == 'active'
    for name in (backup.MAIN, 'tina-memory-gateway.service', 'tina-session-archive.service'):
        active = backup.unit_state(name)
        if active['ActiveState'] not in ('inactive', 'failed'):
            assert receipt['startedUnits'].get(name) == invocation(backup, name), 'Another process owns a running unit'
    timer, intake = 'tina-agent-memory-intake.timer', 'tina-agent-memory-intake.service'
    assert backup.unit_state(timer)['ActiveState'] in ('inactive', 'failed')
    assert backup.unit_state(intake)['ActiveState'] in ('inactive', 'failed')
    path = paths[backup.MAIN]
    old = receipt['dropIns'][backup.MAIN]
    assert backup.digest(path) == old['sha256'] and not path.is_symlink()
    info = path.stat()
    assert old['fileId'] == {'device': info.st_dev, 'inode': info.st_ino}
    new_text = contents[backup.MAIN].replace('Environment="CORTICO_START_PAUSED=1"', 'Environment="CORTICO_START_PAUSED=0"')
    assert new_text != contents[backup.MAIN]
    receipt['activation'] = {'phase': 'dropin-intent', 'previous': dict(old),
                             'targetSha256': hashlib.sha256(new_text.encode()).hexdigest()}
    receipt['status'] = 'activation-in-progress'
    durable_routing_receipt(backup, receipt_path, receipt)
    fd, temporary = tempfile.mkstemp(prefix='.fusion-activate-', dir=path.parent)
    temp = Path(temporary)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as file:
            file.write(new_text); file.flush(); os.fsync(file.fileno())
        info = temp.stat()
        receipt['activation']['targetFileId'] = {'device': info.st_dev, 'inode': info.st_ino}
        durable_routing_receipt(backup, receipt_path, receipt)
        assert read_identity() == receipt['adoption']['after'] and backup.digest(path) == old['sha256']
        os.replace(temp, path); backup.fsync_path(path.parent)
        old.update(sha256=receipt['activation']['targetSha256'], fileId=receipt['activation']['targetFileId'])
        receipt['activation']['phase'] = 'dropin-updated'
        durable_routing_receipt(backup, receipt_path, receipt)
    finally:
        if os.path.lexists(temp): temp.unlink()
    backup.run(['systemctl', '--user', 'daemon-reload'])
    assert read_identity() == receipt['adoption']['after'] and read_paused() is True
    receipt['activation']['phase'] = 'intake-starting'
    durable_routing_receipt(backup, receipt_path, receipt)
    backup.run(['systemctl', '--user', 'start', intake])
    result = backup.run(['systemctl', '--user', 'show', intake, '--property=Result,ExecMainCode,ExecMainStatus']).stdout
    fields = dict(line.split('=', 1) for line in result.splitlines() if '=' in line)
    assert fields.get('Result') == 'success' and fields.get('ExecMainStatus') == '0', 'Intake did not complete successfully'
    receipt['activation']['phase'] = 'intake-complete'
    durable_routing_receipt(backup, receipt_path, receipt)
    if cold['units'][timer]['ActiveState'] == 'active':
        receipt['activation']['phase'] = 'timer-starting'
        durable_routing_receipt(backup, receipt_path, receipt)
        backup.run(['systemctl', '--user', 'start', timer])
        assert backup.unit_state(timer)['ActiveState'] == 'active'
        receipt['startedUnits'][timer] = invocation(backup, timer)
        assert receipt['startedUnits'][timer]
        receipt['intakeTimerStarted'] = True
        durable_routing_receipt(backup, receipt_path, receipt)
    assert read_identity() == receipt['adoption']['after'] and read_paused() is True
    receipt['activation']['phase'] = 'resume-starting'
    durable_routing_receipt(backup, receipt_path, receipt)
    assert resume() is False and read_identity() == receipt['adoption']['after'] and read_paused() is False
    receipt['activation']['phase'] = 'complete'
    receipt['status'] = 'active-validated'
    durable_routing_receipt(backup, receipt_path, receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup', required=True, type=Path)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--acceptance', required=True, type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--recover', action='store_true', help='Recover an interrupted pre-start routing transaction')
    parser.add_argument('--adopt-after', action='store_true', help='Adopt the independently validated restarted process while keeping it paused')
    parser.add_argument('--activate', action='store_true', help='Adopt and activate after both real-server checks pass')
    parser.add_argument('--report-dir', type=Path, help='Private before/after real-server acceptance directory within state')
    args = parser.parse_args()
    assert socket.gethostname() == 'tina' and os.getuid() == pwd.getpwnam('tina').pw_uid
    backup = backup_module()
    cold = json.loads((args.backup / 'BACKUP.json').read_text())
    assert cold['status'] == 'verified-cold-backup'
    assert backup.digest(args.backup / 'MANIFEST.json') == cold['manifestSha256']
    assert backup.digest(args.backup / 'INTEGRITY.json') == cold['integritySha256']
    backup.verify_acceptance(json.loads(args.acceptance.read_text()))
    state, release = args.state.resolve(strict=True), args.release.resolve(strict=True)
    assert state.parent == backup.BASE / 'deployments' and release.parent == backup.BASE / 'releases'
    assert str(state) != cold['state'] and str(release) != cold['release']
    receipt_path = state / 'UPGRADE-ROUTING.json'
    node = Path('/usr/local/lib/nodejs/node-v24.19.0-linux-x64/bin/node')
    assert node.is_file()
    units_root = Path('/home/tina/.config/systemd/user')
    assert units_root.resolve(strict=True) == units_root
    filename = '99-fusion9-20261115.conf'
    common = f'Environment="CORTICO_FUSION_STATE={state}"\n'
    contents = {
        backup.MAIN: ('[Service]\n' + f'WorkingDirectory={release}\nExecStart=\nExecStart={node} {release}/src/fusion-launcher.mjs\n'
                      + 'EnvironmentFile=\n' + f'EnvironmentFile={state}/deployment/.env\n' + common
                      + f'Environment="CORTICO_FUSION_DSH_ROOT={release}/runtime/dsh-0.1.5-rc.2"\n'
                      + f'Environment="CORTICO_HOME={state}"\nEnvironment="CORTICO_EXTENSIONS_DIR={state}/extensions"\n'
                      + 'Environment="CORTICO_FUSION_PORT=7789"\nEnvironment="CORTICO_START_PAUSED=1"\n'
                      + 'TimeoutStopSec=infinity\n'),
        'tina-agent-memory-intake.service': '[Service]\nExecStart=\n' + f'ExecStart={node} {release}/ops/fusion-intake.mjs\n' + common,
        'tina-session-archive.service': '[Service]\nExecStart=\n' + f'ExecStart={node} {release}/ops/fusion-session-archive.cjs\n' + common,
    }
    paths = {name: units_root / (name + '.d') / filename for name in contents}
    assert sum(bool(value) for value in (args.recover, args.rollback, args.adopt_after, args.activate)) <= 1
    if args.adopt_after or args.activate:
        assert args.report_dir and args.report_dir.is_absolute(), 'An explicit acceptance report directory is required'
        session_id = (state / 'conversation/dsh-session-id').read_text().strip()
        receipt = adopt_restart(backup, receipt_path, args.report_dir, release, state, session_id, apply=args.apply)
        if not args.apply:
            print(json.dumps({'status': 'activation-plan' if args.activate else 'adoption-plan', 'state': str(state)}))
            return
        if args.activate:
            receipt = activate_adopted(backup, receipt_path, receipt, paths, contents, cold, state, release)
        print(json.dumps({'status': receipt['status'], 'receipt': str(receipt_path), 'nativeSessionId': session_id}))
        return
    if args.recover:
        assert not args.rollback, 'Choose recovery or rollback'
        assert not receipt_path.is_symlink(), 'Routing receipt may not redirect'
        receipt = json.loads(receipt_path.read_text())
        assert receipt.get('backup') == str(args.backup), 'Routing intent names another backup'
        if not args.apply:
            print(json.dumps({'status': 'recovery-plan', 'transactionStatus': receipt.get('status'), 'state': str(state)}))
            return
        recover_unstarted_routing(backup, receipt_path, receipt, paths, contents, cold, state, release)
        print(json.dumps({'status': receipt['status'], 'preservedState': str(state)}))
        return
    if args.rollback:
        assert args.apply, 'Rollback requires --apply'
        receipt = json.loads(receipt_path.read_text())
        assert receipt['release'] == str(release) and receipt['state'] == str(state)
        assert receipt['status'] in ('started-paused-awaiting-real-server-validation', 'adopted-paused', 'activation-in-progress', 'active-validated'), 'Routing is not owned by an active cutover'
        assert backup.unit_state(backup.MAIN)['WorkingDirectory'] == str(release), 'Another deployment owns the live unit; do not stop it'
        activation = receipt.get('activation', {})
        main_entry = receipt['dropIns'][backup.MAIN]
        if activation.get('phase') == 'dropin-intent' and os.path.lexists(paths[backup.MAIN]):
            info = paths[backup.MAIN].stat()
            if activation.get('targetFileId') == {'device': info.st_dev, 'inode': info.st_ino} and backup.digest(paths[backup.MAIN]) == activation.get('targetSha256'):
                main_entry.update(fileId=activation['targetFileId'], sha256=activation['targetSha256'])
        for name, path in paths.items():
            if path.exists():
                assert backup.digest(path) == receipt['dropIns'][name]['sha256'], 'Owned drop-in changed; inspect before rollback'
        errors = undo_owned_routing(backup, receipt, paths, list(paths.values()), cold, state)
        receipt.update(status='rollback-needs-inspection' if errors else 'rolled-back-routing-only',
                       rollbackErrors=errors, newMemoryAndSessionsPreserved=True)
        backup.save(receipt_path, receipt)
        if errors:
            raise RuntimeError('Rollback needs inspection; new and old state preserved')
        print(json.dumps({'status': receipt['status'], 'preservedState': str(state)}))
        return
    assert not os.path.lexists(receipt_path), 'A routing receipt already exists'
    assert all(not os.path.lexists(path) for path in paths.values()), 'Never replace an existing drop-in'
    preparation = json.loads((state / 'UPGRADE-STATE.json').read_text())
    assert preparation['initialCopyVerified'] is True and preparation['source'] == cold['state'] and preparation['target'] == str(state)
    assert preparation['sourceManifestSha256'] == cold['manifestSha256']
    relocation = json.loads((state / 'native-relocation-backup/receipt.json').read_text())
    assert relocation['applied'] is True and relocation['phase'] == 'published'
    assert relocation['canonicalEventsPreserved'] is True and relocation['deployment'] == str(state)
    assert relocation['newCwd'] == str(state / 'native/dsh-embedded/workspace')
    assert relocation['oldCwd'] == str(Path(cold['state']) / 'native/dsh-embedded/workspace')
    assert (state / 'conversation/dsh-session-id').read_bytes() == (Path(cold['state']) / 'conversation/dsh-session-id').read_bytes()
    assert relocation['sessionId'] == (state / 'conversation/dsh-session-id').read_text().strip()
    installation = json.loads((release / 'INSTALLATION_RECEIPT.json').read_text())
    assert installation['complete'] is True
    platform = json.loads((release / 'runtime/dsh-0.1.5-rc.2/.platform-deps/PLATFORM-INSTALL.json').read_text())
    assert platform['status'] == 'passed'
    source = json.loads((release / 'RELEASE-ACCEPTANCE.json').read_text())
    assert source['schema'] == 'tina-release-acceptance/v1' and source['status'] == 'passed'
    assert source['releaseRoot'] == str(release) and source['stateRoot'] == str(state)
    assert source['acceptanceSha256'] == backup.digest(args.acceptance) and source['exactRuntimeBytes'] is True
    assert source['packageManifestSha256'] == backup.digest(release / 'PACKAGE_MANIFEST.json')
    config = json.loads((state / 'deployment/config.json').read_text())
    assert config['activeProvider'] == 'chatgpt-acceptance'
    provider = json.loads((state / 'providers/chatgpt-acceptance/config.json').read_text())
    assert provider['kind'] == 'chatgpt' and provider['spec']['model'] == 'gpt-6-astra' and provider['spec']['reasoningEffort'] == 'max'
    secret = state / 'providers/chatgpt-acceptance/.env'
    assert secret.is_file() and secret.stat().st_mode & 0o077 == 0 and secret.stat().st_size > 0
    plan = {'state': str(state), 'release': str(release), 'backup': str(args.backup),
            'status': 'planned-paused-start', 'dropIns': {name: {'path': str(paths[name]), 'text': text} for name, text in contents.items()},
            'nativeSessionId': relocation['sessionId'], 'intakeTimerStarted': False, 'startedUnits': {}}
    if not args.apply:
        print(json.dumps(plan))
        return
    backup.assert_stopped([Path(value) for value in cold['sourceRoots']])
    assert backup.unit_state(backup.MAIN)['WorkingDirectory'] == cold['release']
    assert backup.digest(args.backup / 'snapshot.tar.zst') == cold['archiveSha256']
    backup.run([str(node), str(release / 'scripts/verify-deployment-source.mjs'), '--release=' + str(release),
                '--state=' + str(state), '--snapshot=' + str(args.acceptance.parent / 'code-snapshot.json'),
                '--acceptance=' + str(args.acceptance)])
    written = []
    os.umask(0o077)
    plan['dropIns'] = {name: {'path': str(path), 'sha256': hashlib.sha256(contents[name].encode('utf-8')).hexdigest(),
                              'published': False} for name, path in paths.items()}
    plan['status'] = 'routing-writing'
    # If receipt creation itself fails, no unit was touched and any published
    # intent remains recoverable; do not run the service rollback handler.
    durable_routing_receipt(backup, receipt_path, plan, create=True)
    try:
        for name, path in paths.items():
            def before_publish(file_id):
                plan['dropIns'][name]['fileId'] = file_id
                durable_routing_receipt(backup, receipt_path, plan)
            publish_dropin(backup, path, contents[name], plan['dropIns'][name]['sha256'],
                           before_publish, lambda: written.append(path))
            assert backup.digest(path) == plan['dropIns'][name]['sha256']
            plan['dropIns'][name]['published'] = True
            durable_routing_receipt(backup, receipt_path, plan)
        plan['status'] = 'routing-written'
        durable_routing_receipt(backup, receipt_path, plan)
        backup.run(['systemctl', '--user', 'daemon-reload'])
        assert backup.unit_state(backup.MAIN)['WorkingDirectory'] == str(release)
        for name in [backup.MAIN, 'tina-memory-gateway.service', 'tina-session-archive.service']:
            if name == backup.MAIN or cold['units'][name]['ActiveState'] == 'active':
                try:
                    backup.run(['systemctl', '--user', 'start', name])
                finally:
                    identity = invocation(backup, name)
                    if identity:
                        plan['startedUnits'][name] = identity
                    backup.save(receipt_path, plan)
        plan['status'] = 'started-paused-awaiting-real-server-validation'
        backup.save(receipt_path, plan)
        print(json.dumps({'status': plan['status'], 'receipt': str(receipt_path), 'nativeSessionId': plan['nativeSessionId']}))
    except BaseException:
        # Retain both deployments and private credentials; restore only routing.
        errors = undo_owned_routing(backup, plan, paths, written, cold, state)
        plan['status'] = 'failed-rollback-needs-inspection' if errors else 'failed-routing-restored-new-state-preserved'
        plan['rollbackErrors'] = errors
        backup.save(receipt_path, plan)
        raise


if __name__ == '__main__':
    main()
