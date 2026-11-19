#!/usr/bin/python3
"""Fixed Unix-socket executor. No shell is used to construct the isolation boundary."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import selectors
import signal
import socketserver
import sqlite3
import subprocess
import threading
import time

STATE = Path('/var/lib/tina-linux-tools')
WORK = STATE / 'workspace'
SOCKET = '/run/tina-linux-tools/broker.sock'
BWRAP = '/usr/local/libexec/tina-tools-bwrap'
LIMIT = 32768
lock = threading.RLock()
slot = threading.Semaphore(1)
processes = {}
db = None


def command_args(command):
    # Only /workspace persists and is writable. No host home, sockets, disks, /sys or network.
    args = [BWRAP, '--unshare-all', '--die-with-parent', '--new-session',
            '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr',
            '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
            '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--dir', '/etc', '--proc', '/proc', '--dev', '/dev',
            '--size', '67108864', '--tmpfs', '/tmp', '--dir', '/home',
            '--dir', '/run', '--dir', '/var', '--dir', '/root',
            '--bind', str(WORK), '/workspace', '--chdir', '/workspace',
            '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
            '--setenv', 'HOME', '/workspace', '--setenv', 'TMPDIR', '/tmp',
            '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TZ', 'Asia/Shanghai']
    for path in ['/etc/ld.so.cache', '/etc/localtime', '/etc/alternatives']:
        if Path(path).exists():
            args += ['--ro-bind', path, path]
    return args + ['--remount-ro', '/', '--', '/bin/bash', '--noprofile', '--norc', '-c', command]


def kill(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def read_result(row):
    if row['result']:
        return json.loads(row['result'])
    return {'id': row['id'], 'state': row['state'], 'started_at': row['started']}


def execute(data):
    ident = data.get('id', '')
    cmd = data.get('command')
    timeout = data.get('timeout_seconds', 60)
    if len(ident) != 64 or any(c not in '0123456789abcdef' for c in ident):
        raise ValueError('Invalid call id')
    if not isinstance(cmd, str) or not 1 <= len(cmd) <= 16000 or '\0' in cmd:
        raise ValueError('Command must contain 1..16000 characters, without NUL')
    if type(timeout) is not int or not 1 <= timeout <= 120:
        raise ValueError('timeout_seconds must be 1..120')
    digest = hashlib.sha256(json.dumps([cmd, timeout]).encode()).hexdigest()
    with lock:
        row = db.execute('select * from jobs where id=?', (ident,)).fetchone()
        if row:
            if row['digest'] and row['digest'] != digest:
                raise ValueError('Call id already used with different input')
            return read_result(row)
    if not slot.acquire(blocking=False):
        return {'id': ident, 'state': 'not_started', 'reason': 'Executor busy; no command was launched'}
    proc = None
    started = time.time()
    try:
        with lock:
            row = db.execute('select * from jobs where id=?', (ident,)).fetchone()
            if row:
                return read_result(row)
            db.execute('insert into jobs values (?,?,?,?,?)', (ident, digest, 'running', started, None))
            db.commit()
            # Cancellation and launch are serialized, including cancellation-before-launch.
            proc = subprocess.Popen(command_args(cmd), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    start_new_session=True, close_fds=True, env={'PATH': '/usr/bin:/bin'})
            cancelled = threading.Event()
            processes[ident] = (proc, cancelled)
        buffers = {'stdout': bytearray(), 'stderr': bytearray()}
        truncated = {'stdout': False, 'stderr': False}
        state = 'completed'
        sel = selectors.DefaultSelector()
        for stream, key in [(proc.stdout, 'stdout'), (proc.stderr, 'stderr')]:
            os.set_blocking(stream.fileno(), False)
            sel.register(stream, selectors.EVENT_READ, key)
        while sel.get_map() or proc.poll() is None:
            if cancelled.is_set():
                state = 'cancelled'; kill(proc)
            elif time.time() - started >= timeout:
                state = 'timeout'; kill(proc)
            for key, _ in sel.select(0.05):
                try:
                    chunk = os.read(key.fileobj.fileno(), 65536)
                except BlockingIOError:
                    continue
                if not chunk:
                    sel.unregister(key.fileobj); key.fileobj.close(); continue
                out = buffers[key.data]
                available = max(0, LIMIT - len(out))
                out.extend(chunk[:available])
                if len(chunk) > available:
                    truncated[key.data] = True
        sel.close()
        code = proc.wait()
        if cancelled.is_set():
            state = 'cancelled'
        result = {'id': ident, 'state': state, 'exit_code': code,
                  **{k: v.decode('utf-8', 'replace') for k, v in buffers.items()},
                  'truncated': truncated, 'duration_ms': round((time.time()-started)*1000),
                  'boundary': 'bwrap-v1', 'workspace': '/workspace', 'approval': 'none'}
    except Exception as exc:
        if proc:
            kill(proc); proc.wait()
        result = {'id': ident, 'state': 'failed' if proc is None else 'unknown', 'error': str(exc)}
    finally:
        with lock:
            processes.pop(ident, None)
        slot.release()
    with lock:
        db.execute('update jobs set state=?,result=? where id=?', (result['state'], json.dumps(result), ident))
        db.commit()
    return result


def cancel(ident):
    if not isinstance(ident, str) or len(ident) != 64 or any(c not in '0123456789abcdef' for c in ident):
        raise ValueError('Invalid call id')
    with lock:
        item = processes.get(ident)
        if item:
            item[1].set(); kill(item[0])
            return {'id': ident, 'state': 'cancel_requested'}
        row = db.execute('select * from jobs where id=?', (ident,)).fetchone()
        if row:
            return read_result(row)
        result = {'id': ident, 'state': 'cancelled', 'reason': 'Cancelled before launch'}
        db.execute('insert into jobs values (?,?,?,?,?)', (ident, None, 'cancelled', time.time(), json.dumps(result)))
        db.commit()
        return result


def status():
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in ['MemTotal', 'MemAvailable']:
            memory[key + '_KiB'] = int(value.split()[0])
    disk = os.statvfs('/')
    workspace = os.statvfs(WORK)
    with lock:
        recent = [read_result(r) for r in db.execute('select * from jobs order by started desc limit 5')]
    return {'boundary': 'bwrap-v1', 'approval': 'none', 'time': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'load': os.getloadavg(), 'memory': memory,
            'host_disk': {'total_bytes': disk.f_blocks * disk.f_frsize, 'available_bytes': disk.f_bavail * disk.f_frsize},
            'workspace': {'path_in_command': '/workspace', 'total_bytes': workspace.f_blocks * workspace.f_frsize,
                          'available_bytes': workspace.f_bavail * workspace.f_frsize},
            'limits': {'network': False, 'host_write': False, 'max_seconds': 120, 'output_bytes_per_stream': LIMIT,
                       'memory_bytes': 536870912, 'tasks': 64, 'cpu_quota_percent': 50}, 'recent': recent}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {'boundary': 'bwrap-v1', 'approval': 'none', 'ready': True})
        elif self.path == '/status':
            self.send_json(200, status())
        else:
            self.send_json(404, {'error': 'Not found'})

    def do_POST(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 100000:
                raise ValueError('Invalid body length')
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError('Expected object')
            if self.path == '/run':
                self.send_json(200, execute(data))
            elif self.path == '/cancel':
                self.send_json(200, cancel(data.get('id')))
            else:
                self.send_json(404, {'error': 'Not found'})
        except (ValueError, TypeError) as exc:
            self.send_json(400, {'error': str(exc)})

    def send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers(); self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Durable result remains queryable after loss of the HTTP client.


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    global db
    db = sqlite3.connect(STATE / 'receipts.sqlite', check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute('create table if not exists jobs(id text primary key,digest text,state text,started real,result text)')
    db.execute("update jobs set state='unknown' where state='running'")
    db.commit()
    # Fail closed: no host-shell fallback if namespaces or the dedicated image are unavailable.
    if not os.path.ismount(WORK):
        raise RuntimeError('Workspace filesystem not mounted')
    probe = subprocess.run(command_args('printf sandbox-ready'), capture_output=True, timeout=10)
    if probe.returncode or probe.stdout != b'sandbox-ready':
        raise RuntimeError('Isolation unavailable: ' + probe.stderr.decode('utf-8', 'replace'))
    Path(SOCKET).unlink(missing_ok=True)
    with Server(SOCKET, Handler) as server:
        os.chmod(SOCKET, 0o660)
        server.serve_forever()


if __name__ == '__main__':
    main()
