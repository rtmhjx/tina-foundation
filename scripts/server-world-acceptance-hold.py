#!/usr/bin/env python3
"""Temporarily hold external Worlds before first startup; restore through native API.

Only the cloned, explicitly prepared deployment is eligible. Online disable/hide
is deliberately never used: it would discard historical pending deliveries.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import socket
import sys
import urllib.request

if sys.flags.optimize:
    raise RuntimeError('Do not disable migration assertions')

KEEP = {'console', 'native-engine'}


def backup_module():
    spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('server-upgrade-backup.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def hold_config(config):
    changed = json.loads(json.dumps(config))
    worlds = changed.setdefault('worlds', {})
    assert isinstance(worlds, dict)
    held = {}
    for name, section in worlds.items():
        assert isinstance(section, dict), 'Unknown World config shape'
        if name not in KEEP and section.get('enabled') is True:
            held[name] = {'enabled': True, 'sectionSha256': canonical(section)}
            section['enabled'] = False
    assert worlds.get('console', {}).get('enabled') is True, 'Existing Console World must be enabled'
    return changed, held


def assert_section_unchanged(config, name, saved, enabled):
    assert type(enabled) is bool and saved.get('enabled') is True, 'Invalid owned World enabled flag'
    section = config.get('worlds', {}).get(name)
    assert isinstance(section, dict) and section.get('enabled') is enabled
    restored = {**section, 'enabled': saved['enabled']}
    assert canonical(restored) == saved['sectionSha256'], 'World settings changed beyond the owned enabled flag'


def assert_worlds_unchanged(config, receipt):
    """Reject unrelated edits before activating any external connection."""
    worlds = config.get('worlds')
    assert isinstance(worlds, dict), 'Unknown World config shape'
    restored = json.loads(json.dumps(worlds))
    for name, saved in receipt['held'].items():
        assert name not in KEEP, 'Framework/Console World may not be held'
        section = worlds.get(name)
        assert isinstance(section, dict), 'Held World disappeared'
        assert_section_unchanged(config, name, saved, section.get('enabled'))
        restored[name]['enabled'] = saved['enabled']
    assert canonical(restored) == receipt['originalWorldsSha256'], 'Unrelated World settings changed during acceptance'


def api(path, body=None):
    origin = 'http://127.0.0.1:7789'
    request = urllib.request.Request(origin + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'Origin': origin})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--mode', required=True, choices=['hold', 'restore'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    assert socket.gethostname() == 'tina' and os.getuid() == pwd.getpwnam('tina').pw_uid
    backup = backup_module()
    state = args.state.absolute()
    assert state.resolve(strict=True) == state and state.parent == backup.BASE / 'deployments'
    preparation = json.loads((state / 'UPGRADE-STATE.json').read_text())
    assert preparation['target'] == str(state) and preparation['initialCopyVerified'] is True
    assert preparation['source'] != str(state)
    path = state / 'deployment/config.json'
    assert path.resolve(strict=True) == path
    receipt_path = state / 'WORLD-ACCEPTANCE-HOLD.json'
    config = json.loads(path.read_text())
    if args.mode == 'hold':
        assert not receipt_path.exists(), 'Hold already exists; inspect its recovery state'
        # This Bot has no implicit World defaults; all mounted external Worlds
        # are explicit config entries. The identity binds this reviewed migration.
        assert json.loads((state / 'deployment.json').read_text())['bot'] == '@tina/self-mem', 'Only the reviewed no-default-World Bot is eligible'
        changed, held = hold_config(config)
        receipt = {'version': 1, 'state': str(state), 'status': 'planned', 'held': held,
                   'beforeConfigSha256': backup.digest(path), 'heldConfigSha256': canonical(changed),
                   'originalWorldsSha256': canonical(config['worlds']),
                   'nativeSessionId': (state / 'conversation/dsh-session-id').read_text().strip(),
                   'scope': 'External World mounts only; not a general native-tool sandbox'}
        if not args.apply:
            print(json.dumps({'status': 'planned', 'mode': args.mode, 'worlds': sorted(held)})); return
        backup.assert_stopped([state, Path(preparation['source'])])
        backup.save(receipt_path, receipt)
        backup.save(path, changed)
        assert canonical(json.loads(path.read_text())) == receipt['heldConfigSha256']
        receipt['status'] = 'held-before-first-start'
        backup.save(receipt_path, receipt)
    else:
        receipt = json.loads(receipt_path.read_text())
        assert receipt['version'] == 1 and receipt['state'] == str(state)
        assert receipt['status'] in ['held-before-first-start', 'restoring', 'restored']
        assert_worlds_unchanged(config, receipt)
        if receipt['status'] == 'restored':
            for name, saved in receipt['held'].items(): assert_section_unchanged(config, name, saved, True)
            print(json.dumps({'status': 'restored', 'alreadyRestored': True})); return
        for name, saved in receipt['held'].items():
            assert_section_unchanged(config, name, saved, config['worlds'][name]['enabled'])
        before = json.loads((state / 'server-upgrade-acceptance/before.json').read_text())
        after = json.loads((state / 'server-upgrade-acceptance/after-restart.json').read_text())
        checkpoint = json.loads((state / 'server-upgrade-acceptance/checkpoint.json').read_text())
        assert before['passed'] is True and after['passed'] is True and after['restartVerified'] is True
        assert checkpoint['state'] == str(state) and checkpoint['beforePassed'] and checkpoint['afterPassed']
        assert before['sessionId'] == after['sessionId'] == (state / 'conversation/dsh-session-id').read_text().strip()
        for report in [before, after]:
            assert report['phases'] and all(row['passed'] is True and all(value is True for value in row['checks'].values()) for row in report['phases'])
        routing = json.loads((state / 'UPGRADE-ROUTING.json').read_text())
        assert routing['state'] == str(state)
        unit = backup.unit_state(backup.MAIN)
        assert unit['ActiveState'] == 'active' and unit['WorkingDirectory'] == routing['release']
        env = (Path('/proc') / unit['MainPID'] / 'environ').read_bytes().split(b'\0')
        assert ('CORTICO_FUSION_STATE=' + str(state)).encode() in env
        identity = backup.run(['systemctl', '--user', 'show', backup.MAIN, '--property=InvocationID', '--value']).stdout.strip()
        assert identity == after['process']['invocationId'] and int(unit['MainPID']) == after['process']['pid']
        status = api('/api/status')['loop']
        assert status['paused'] is True and status['phase']['state'] == 'idle'
        if not args.apply:
            print(json.dumps({'status': 'planned', 'mode': args.mode, 'worlds': sorted(receipt['held'])})); return
        receipt['status'] = 'restoring'; backup.save(receipt_path, receipt)
        for name, saved in receipt['held'].items():
            current = json.loads(path.read_text())
            assert_worlds_unchanged(current, receipt)
            assert_section_unchanged(current, name, saved, current['worlds'][name]['enabled'])
            assert api('/api/status')['loop']['paused'] is True
            assert api('/api/worlds/activation', {'id': name, 'enabled': True})['ok'] is True
            worlds = {item['id']: item for item in api('/api/worlds')['worlds']}
            assert worlds[name]['status'] == 'active'
            assert_section_unchanged(json.loads(path.read_text()), name, saved, True)
            receipt.setdefault('restoredWorlds', {})[name] = {'status': 'active', 'visible': worlds[name].get('visible')}
            backup.save(receipt_path, receipt)
        restored_config = json.loads(path.read_text())
        assert canonical(restored_config['worlds']) == receipt['originalWorldsSha256'], 'Inactive and active World settings must all be preserved'
        assert api('/api/status')['loop']['paused'] is True
        all_worlds = {item['id']: {'status': item['status'], 'visible': item.get('visible')} for item in api('/api/worlds')['worlds']}
        for name, section in restored_config['worlds'].items():
            if section.get('enabled') is False and name in all_worlds:
                assert all_worlds[name]['status'] != 'active', 'An originally inactive World was unexpectedly activated'
        receipt.update(status='restored', release=routing['release'], nativeSessionId=after['sessionId'],
                       process=after['process'], stillPaused=True, worldSettingsRestored=True,
                       restoredWorldsSha256=canonical(restored_config['worlds']), worldStates=all_worlds,
                       beforeReportSha256=backup.digest(state / 'server-upgrade-acceptance/before.json'),
                       afterReportSha256=backup.digest(state / 'server-upgrade-acceptance/after-restart.json'))
        backup.save(receipt_path, receipt)
    print(json.dumps({'status': receipt['status'], 'worlds': sorted(receipt['held']), 'receipt': str(receipt_path)}))


if __name__ == '__main__':
    main()
