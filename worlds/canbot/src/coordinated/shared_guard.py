"""Linux-only shared playback/microphone lock with a durable unknown latch.

Every participating client MUST hold playback.lock and call reserve before its
single POST, then settle only after a definitive device receipt. No stale-lock
age, PID death, process exit or device restart clears an unresolved latch.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import stat
import time
import uuid


class GuardError(Exception):
    pass


def _sync_dir(folder):
    fd = os.open(str(folder), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def acquire(folder, timeout=0):
    folder = Path(folder)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not folder.is_dir() or stat.S_IMODE(folder.stat().st_mode) & 0o077:
        raise GuardError('guard_directory_not_private')
    flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(folder / 'playback.lock', flags, 0o600)
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise GuardError('guard_busy') from None
                time.sleep(.05)
        try:
            yield folder
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _atomic_json(folder, name, value):
    temp = folder / ('.tmp-' + str(uuid.uuid4()))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as out:
            json.dump(value, out, ensure_ascii=False, sort_keys=True)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, folder / name)
        _sync_dir(folder)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def ensure_clear(folder):
    if (folder / 'unsettled.json').exists():
        raise GuardError('previous_operation_unsettled')


def reserve(folder, operation):
    ensure_clear(folder)
    if set(operation) != {'operationId', 'instanceId', 'sequence', 'kind'}:
        raise GuardError('guard_operation_invalid')
    try:
        uuid.UUID(operation['operationId'])
        uuid.UUID(operation['instanceId'])
    except (ValueError, TypeError, AttributeError):
        raise GuardError('guard_operation_invalid') from None
    if operation['kind'] not in ('microphone', 'microphone_stream', 'audio', 'tone', 'photo', 'video', 'frames', 'preview') or type(operation['sequence']) is not int or operation['sequence'] < 1:
        raise GuardError('guard_operation_invalid')
    _atomic_json(folder, 'unsettled.json', {**operation, 'state': 'reserved_before_single_post'})


def settle(folder, operation_id, result):
    path = folder / 'unsettled.json'
    try:
        record = json.loads(path.read_text(encoding='utf8'))
    except (OSError, ValueError):
        raise GuardError('guard_latch_missing_or_invalid') from None
    if record.get('operationId') != operation_id or result not in ('completed', 'failed', 'cancelled', 'rejected'):
        raise GuardError('guard_settlement_invalid')
    _atomic_json(folder, 'receipt-' + operation_id + '.json', {**record, 'state': result})
    path.unlink()
    _sync_dir(folder)


def quarantine_generation(folder, operation_id, new_instance):
    """Isolate, never resolve, an old operation after an observed new instance."""
    path = folder / 'unsettled.json'
    record = json.loads(path.read_text(encoding='utf8'))
    try:
        uuid.UUID(new_instance)
    except (ValueError, TypeError, AttributeError):
        raise GuardError('new_instance_invalid') from None
    if record.get('operationId') != operation_id or record.get('kind') != 'microphone_stream' or record.get('instanceId') == new_instance:
        raise GuardError('generation_not_changed')
    existing = list(folder.glob('quarantine-*.json'))
    if len(existing) >= 128: raise GuardError('quarantine_capacity_reached')
    if (folder / ('quarantine-' + operation_id + '.json')).exists(): raise GuardError('quarantine_already_exists')
    _atomic_json(folder, 'quarantine-' + operation_id + '.json', {**record, 'state': 'interrupted_unresolved', 'observedNewInstanceId': new_instance})
    path.unlink()
    _sync_dir(folder)


def reconcile(folder, client):
    """GET-only resolution of the exact retained device operation.

    Missing receipt, changed generation or an unsettled/active operation leaves
    the latch in place. A process restart or elapsed time is never evidence.
    """
    try:
        record = json.loads((folder / 'unsettled.json').read_text(encoding='utf8'))
        if record.get('kind') == 'microphone_stream':
            # Device settlement alone does not prove all tail WAVs were fsynced
            # and ACKed. Stream-aware recovery must establish both first.
            return False
        operation_id = record['operationId']
        uuid.UUID(operation_id)
        status = client.request('/v1/status')
        if status.get('instanceId') != record['instanceId'] or status.get('activeOperation') is not None:
            return False
        receipt = client.request('/v1/operations/' + operation_id)
        if (receipt.get('operationId') != operation_id or receipt.get('sequence') != record['sequence']
                or receipt.get('kind') != record['kind'] or receipt.get('settled') is not True
                or receipt.get('state') not in ('complete', 'failed', 'cancelled', 'timed_out')):
            return False
        # Race with a different media operation or process restart after GET.
        status2 = client.request('/v1/status')
        if status2.get('instanceId') != record['instanceId'] or status2.get('activeOperation') is not None:
            return False
        mapped = 'completed' if receipt['state'] == 'complete' else 'cancelled' if receipt['state'] == 'cancelled' else 'failed'
        settle(folder, operation_id, mapped)
        return True
    except (OSError, ValueError, KeyError, TypeError, GuardError):
        return False
