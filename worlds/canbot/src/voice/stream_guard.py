#!/usr/bin/env python3
"""Private stdio child; holds the same flock as the candidate playback helper."""
import json
import os
from pathlib import Path
import sys
import shared_guard


def reply(value):
    print(json.dumps(value), flush=True)


def main():
    folder = Path(os.environ.get('CANBOT_AUDIO_STATE', '/home/tina/.local/share/canbot-audio-play'))
    try:
        with shared_guard.acquire(folder, timeout=0) as held:
            first = json.loads(sys.stdin.readline(4097))
            if first.get('action') == 'recover':
                operation = json.loads((held / 'unsettled.json').read_text(encoding='utf8'))
                if operation.get('operationId') != first.get('operationId') or operation.get('kind') != 'microphone_stream':
                    raise ValueError('recovery_operation_mismatch')
                reply({'ok': True})
                for line in sys.stdin:
                    msg = json.loads(line)
                    if msg.get('operationId') != operation['operationId'] or msg.get('action') not in ('settle', 'quarantine'):
                        raise ValueError('settlement_mismatch')
                    if msg['action'] == 'quarantine':
                        shared_guard.quarantine_generation(held, operation['operationId'], msg.get('newInstanceId'))
                    else:
                        shared_guard.settle(held, operation['operationId'], msg.get('outcome'))
                    reply({'ok': True}); return 0
                return 76
            shared_guard.ensure_clear(held)
            if first.get('action') == 'lock':
                reply({'ok': True})
                first = json.loads(sys.stdin.readline(4097))
            if first.get('action') != 'reserve': raise ValueError('reserve_required')
            operation = first['operation']
            shared_guard.reserve(held, operation)
            reply({'ok': True})
            for line in sys.stdin:
                if len(line) > 4096: raise ValueError('message_too_large')
                msg = json.loads(line)
                if msg.get('action') != 'settle' or msg.get('operationId') != operation['operationId']:
                    raise ValueError('settlement_mismatch')
                shared_guard.settle(held, operation['operationId'], msg.get('outcome'))
                reply({'ok': True})
                return 0
            # Parent disappeared: lock releases; durable latch deliberately remains.
            return 76
    except Exception:
        reply({'ok': False, 'error': 'guard_busy_or_unsettled'})
        return 76


if __name__ == '__main__': sys.exit(main())
