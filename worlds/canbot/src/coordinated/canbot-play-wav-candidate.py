#!/usr/bin/env python3
"""Thin custom backend for cortico-world-audio-play; no TTS or audio queue here.

Secrets are read from a private link.json, never command arguments. One upload is
followed by operation reads; transport ambiguity never resends the WAV. SIGTERM
requests cancellation of that exact operation and waits for device settlement.
"""
import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
import shared_guard

MAX_FRAMES = 480000
MAX_BYTES = MAX_FRAMES * 2 + 4096
DEFAULT_LINK = '/home/tina/.local/share/canbot-head-handoff/20261027T121150Z/link.json'
DEFAULT_STATE = '/home/tina/.local/share/canbot-audio-play'


class PlaybackError(Exception):
    pass


class HttpError(PlaybackError):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class MediaClient:
    def __init__(self, base, token, timeout=3):
        parsed = urllib.parse.urlsplit(base)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname
                or parsed.username or parsed.password or parsed.query
                or parsed.fragment or parsed.path not in ('', '/')):
            raise PlaybackError('media_base_invalid')
        self.base, self.token, self.timeout = base.rstrip('/'), token, timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, method='GET', body=None, headers=None):
        # urllib's socket timeout is an idle timeout, not a total deadline. A
        # slowly dribbling response must not prevent SIGTERM from reaching the
        # operation-specific STOP loop. The daemon worker is never re-used or
        # joined on timeout; an ambiguous audio upload is only queried by ID.
        finished = threading.Event()
        outcome = {}
        def perform():
            try:
                outcome['value'] = self._request(path, method, body, headers)
            except Exception as error:
                outcome['error'] = error
            finally:
                finished.set()
        threading.Thread(target=perform, name='canbot-media-request', daemon=True).start()
        if not finished.wait(self.timeout):
            raise TimeoutError('media_request_deadline')
        if 'error' in outcome:
            raise outcome['error']
        return outcome['value']

    def _request(self, path, method='GET', body=None, headers=None):
        combined = {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/json'}
        combined.update(headers or {})
        request = urllib.request.Request(self.base + path, body, combined, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(65537)
        except urllib.error.HTTPError as error:
            # Do not print a server-controlled body or the request's private header.
            raise HttpError(error.code, 'media_http_' + str(error.code)) from None
        if len(raw) > 65536:
            raise PlaybackError('media_response_too_large')
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError):
            raise PlaybackError('media_response_invalid') from None
        if not isinstance(value, dict):
            raise PlaybackError('media_response_invalid')
        return value


def normalize_audio(file, volume):
    source = Path(file).resolve(strict=True)
    if not source.is_file() or not 0 <= volume <= 100:
        raise PlaybackError('audio_input_invalid')
    # The extra sample window makes >30s input rejectable instead of silently
    # truncating it to an apparently valid 30s clip. Bounded output stays in RAM.
    command = ['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
               '-i', str(source), '-map', '0:a:0', '-vn', '-sn', '-dn',
               '-t', '30.001', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
               '-af', 'volume=' + str(volume / 100), '-f', 'wav', 'pipe:1']
    converted = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               timeout=45, check=False)
    if converted.returncode or len(converted.stdout) > MAX_BYTES:
        raise PlaybackError('audio_conversion_failed_or_over_30s')
    # ffmpeg's nonseekable WAV has unknown chunk lengths. Re-emit a canonical
    # seekable RIFF so the receiver can enforce exact lengths and fingerprints.
    try:
        with wave.open(io.BytesIO(converted.stdout), 'rb') as reader:
            if (reader.getnchannels(), reader.getsampwidth(), reader.getframerate()) != (1, 2, 16000):
                raise PlaybackError('audio_format_invalid')
            pcm = reader.readframes(MAX_FRAMES + 1)
        frames = len(pcm) // 2
        if len(pcm) % 2 or not 0 < frames <= MAX_FRAMES:
            raise PlaybackError('audio_empty_or_over_30s')
        out = io.BytesIO()
        with wave.open(out, 'wb') as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(16000)
            writer.writeframes(pcm)
        return out.getvalue(), frames
    except (wave.Error, EOFError):
        raise PlaybackError('audio_format_invalid') from None


def play(client, wav, frames, cancelled, *, before_submit=lambda _op: None, poll_interval=.15, grace=6,
         clock=time.monotonic, sleep=time.sleep):
    status = client.request('/v1/status')
    instance = status.get('instanceId')
    sequence = status.get('lastSequence')
    if (not isinstance(instance, str) or not instance or type(sequence) is not int
            or sequence < 0 or not status.get('foreground')
            or status.get('audioUpload', {}).get('maxDurationMs') != 30000):
        raise PlaybackError('audio_upload_not_ready')
    operation_id = str(uuid.uuid4())
    result = {'operationId': operation_id, 'instanceId': instance,
              'sequence': sequence + 1, 'frames': frames,
              'wavSha256': hashlib.sha256(wav).hexdigest(),
              'retryAutomatically': False, 'physicalAudibility': 'requires_local_confirmation'}
    if cancelled():
        return dict(result, outcome='cancelled_before_upload', settled=True)
    headers = {'Content-Type': 'audio/wav', 'Content-Length': str(len(wav)),
               'X-Canbot-Operation-Id': operation_id,
               'X-Canbot-Instance-Id': instance, 'X-Canbot-Sequence': str(sequence + 1)}
    before_submit({'operationId': operation_id, 'instanceId': instance, 'sequence': sequence + 1, 'kind': 'audio'})
    try:
        reply = client.request('/v1/audio', 'POST', wav, headers)
        if (reply.get('operationId') != operation_id or reply.get('instanceId') != instance
                or type(reply.get('sequence')) is not int or reply['sequence'] != sequence + 1):
            raise PlaybackError('audio_accept_identity_mismatch')
        result['uploadOutcome'] = 'accepted' if reply.get('accepted') else 'receipt_returned'
    except HttpError as error:
        if error.status < 500:
            # An explicit rejected admission is not a reason to try a new ID.
            raise
        result['uploadOutcome'] = 'unknown'
    except (OSError, TimeoutError, PlaybackError):
        result['uploadOutcome'] = 'unknown'
    deadline = clock() + frames / 16000 + 2 + grace
    cancel_sent = False
    last_cancel_attempt = float('-inf')
    while clock() < deadline:
        if cancelled() and not cancel_sent and clock() - last_cancel_attempt >= .5:
            last_cancel_attempt = clock()
            try:
                stop = client.request('/v1/audio/' + operation_id + '/stop', 'POST',
                                      json.dumps({'instanceId': instance}).encode(),
                                      {'Content-Type': 'application/json'})
                cancel_sent = (stop.get('operationId') == operation_id
                               and stop.get('instanceId') == instance)
            except (OSError, PlaybackError):
                result['cancelRequestOutcome'] = 'unknown'
        try:
            receipt = client.request('/v1/operations/' + operation_id)
            if receipt.get('operationId') != operation_id or receipt.get('kind') != 'audio':
                raise PlaybackError('audio_receipt_identity_mismatch')
            if type(receipt.get('sequence')) is not int or receipt['sequence'] != sequence + 1:
                raise PlaybackError('audio_receipt_sequence_mismatch')
            result['operation'] = receipt
            if receipt.get('settled') is True:
                # GET operations in Diagnostics v2 does not carry instanceId.
                # Check the live service before treating this receipt as settled.
                current = client.request('/v1/status')
                if current.get('instanceId') != instance:
                    return dict(result, outcome='unknown', settled=False, reason='media_instance_changed')
                result['settled'] = True
                if receipt.get('state') == 'complete':
                    played = receipt.get('result') or {}
                    if (played.get('playbackComplete') is not True
                            or played.get('expectedFrames') != frames
                            or type(played.get('playbackHeadFrames')) is not int
                            or played['playbackHeadFrames'] < frames
                            or played.get('wavSha256') != result['wavSha256']):
                        raise PlaybackError('audio_completion_evidence_invalid')
                    result['outcome'] = 'completed'
                elif receipt.get('state') == 'cancelled' and cancelled():
                    result['outcome'] = 'cancelled'
                else:
                    result['outcome'] = 'failed'
                return result
        except HttpError as error:
            if error.status == 404:
                # Lost admission replies are queried by the same ID, never reposted.
                try:
                    current = client.request('/v1/status')
                    if current.get('instanceId') != instance:
                        return dict(result, outcome='unknown', settled=False, reason='media_instance_changed')
                except (OSError, PlaybackError):
                    pass
            elif error.status < 500:
                return dict(result, outcome='unknown', settled=False, reason=str(error))
        except PlaybackError as error:
            return dict(result, outcome='unknown', settled=False, reason=str(error))
        except (OSError, TimeoutError):
            pass
        sleep(poll_interval)
    return dict(result, outcome='unknown', settled=False, reason='device_settlement_not_observed')


@contextlib.contextmanager
def playback_lock(folder, cancelled):
    import fcntl
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (folder / 'playback.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        deadline = time.monotonic() + 4
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if cancelled() or time.monotonic() >= deadline:
                    raise PlaybackError('previous_robot_playback_not_settled')
                time.sleep(.05)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', required=True)
    parser.add_argument('--volume', type=int, default=80)
    args = parser.parse_args()
    requested = [False]
    def cancel(_number, _frame):
        requested[0] = True
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    result = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    state = Path(os.environ.get('CANBOT_AUDIO_STATE', DEFAULT_STATE))
    try:
        link_path = Path(os.environ.get('CANBOT_AUDIO_LINK', DEFAULT_LINK))
        if stat.S_IMODE(link_path.stat().st_mode) & 0o077:
            raise PlaybackError('link_permissions_not_private')
        link = json.loads(link_path.read_text())
        client = MediaClient(link['mediaBaseUrl'], link['mediaToken'])
        wav, frames = normalize_audio(args.file, args.volume)
        with shared_guard.acquire(state, timeout=4) as guard:
            shared_guard.ensure_clear(guard)
            reserved = [None]
            def before_submit(operation):
                shared_guard.reserve(guard, operation)
                reserved[0] = operation['operationId']
            try:
                result.update(play(client, wav, frames, lambda: requested[0], before_submit=before_submit))
            finally:
                if reserved[0]:
                    if result.get('settled') is True:
                        try:
                            shared_guard.settle(guard, reserved[0], result.get('outcome', 'failed'))
                        except Exception:
                            result.update(outcome='unknown', settled=False, error='guard_settlement_failed')
                    else:
                        result.update(outcome='unknown', settled=False, error='device_or_guard_unsettled')
    except Exception as error:
        # Known symbolic errors are safe; arbitrary exception strings may contain
        # paths, proxy credentials or private request objects and are not printed.
        if result.get('outcome') != 'unknown':
            result.update(outcome='failed', error=str(error) if isinstance(error, PlaybackError)
                          else type(error).__name__, retryAutomatically=False)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    receipt_file = state / ('receipt-' + result.get('operationId', str(uuid.uuid4())) + '.json')
    try:
        receipt_file.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        os.chmod(receipt_file, 0o600)
    except OSError:
        result['receiptStorage'] = 'failed'
    print(json.dumps(result, ensure_ascii=False), flush=True)
    # The small audio-play adapter preserves 76 even after an abort signal;
    # otherwise an unobserved device stop would be hidden as ordinary cancellation.
    return exit_code(result)


def exit_code(result):
    outcome = result.get('outcome')
    return (0 if outcome == 'completed' else 76 if outcome == 'unknown'
            else 130 if outcome in ('cancelled', 'cancelled_before_upload') else 2)


if __name__ == '__main__':
    sys.exit(main())
