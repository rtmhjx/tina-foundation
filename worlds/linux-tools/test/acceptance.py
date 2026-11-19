"""Real Linux boundary tests. Never issue a destructive command against host paths."""
import concurrent.futures
import hashlib
import http.client
import json
from pathlib import Path
import socket
import time
import uuid

class Connection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(135)
        self.sock.connect('/run/tina-linux-tools/broker.sock')

def request(path, data=None):
    c = Connection('localhost')
    c.request('POST' if data else 'GET', path, body=json.dumps(data) if data else None,
              headers={'Content-Type': 'application/json'})
    r = c.getresponse()
    value = json.loads(r.read())
    c.close()
    assert r.status == 200, value
    return value

def call(command, timeout=10, ident=None):
    ident = ident or hashlib.sha256(uuid.uuid4().bytes).hexdigest()
    return request('/run', {'id': ident, 'command': command, 'timeout_seconds': timeout})

results = []
def check(name, predicate, detail=None):
    assert predicate, (name, detail)
    results.append({'case': name, 'passed': True})

check('executor_ready', request('/health')['ready'])
r = call("mkdir -p acceptance; printf 'hello Tina' > acceptance/hello.txt; python3 -c \"print(open('acceptance/hello.txt').read())\"")
check('bash_python_file_roundtrip', r['exit_code'] == 0 and r['stdout'].strip() == 'hello Tina', r)
r = call("node -e \"console.log('node-ready')\"")
check('node_available', r['exit_code'] == 0 and 'node-ready' in r['stdout'], r)
checks = {
    'host_home_hidden': "test ! -e /home/tina/tina-runtime && test ! -e /root/.ssh",
    'host_credentials_hidden': "test ! -e /home/tina/.ssh && test ! -e /home/tina/tina-runtime/deployments",
    'raw_devices_hidden': "test ! -e /dev/sda && test ! -e /dev/nvme0n1 && test ! -e /dev/mapper",
    'host_sockets_hidden': "test ! -e /run/systemd/private && test ! -e /run/tina-linux-tools/broker.sock && test ! -e /run/user/1000/bus",
    'pid_namespace_cannot_see_host': "test ! -e /proc/1/root/home/tina/tina-runtime",
    'direct_system_write_denied': "if printf danger > /etc/server-delete-test 2>/dev/null; then exit 1; else exit 0; fi",
    'python_system_write_denied': "python3 - <<'PY'\ntry:\n open('/usr/tina-delete-test','w').write('x')\nexcept OSError:\n print('denied')\nelse:\n raise SystemExit(1)\nPY",
    'symlink_cannot_reach_host': "ln -sfn /home/tina/tina-runtime acceptance/host-link; test ! -e acceptance/host-link/deployments",
    'no_privilege_escalation': "test \"$(id -u)\" != 0 && ! sudo -n true 2>/dev/null",
    'host_network_denied': "python3 - <<'PY'\nimport socket\ns=socket.socket();s.settimeout(1)\ntry:s.connect(('127.0.0.1',7789))\nexcept OSError:print('denied')\nelse:raise SystemExit(1)\nPY",
    'no_new_privileges': "grep -q 'NoNewPrivs:[[:space:]]*1' /proc/self/status",
}
for name, command in checks.items():
    r = call(command)
    check(name, r['state'] == 'completed' and r['exit_code'] == 0, r)
r = call("python3 -c \"print('x'*100000)\"")
check('output_bounded', r['truncated']['stdout'] and len(r['stdout']) <= 32768, r)
r = call('sleep 30', timeout=1)
check('timeout_terminates', r['state'] == 'timeout' and r['duration_ms'] < 4000, r)
ident = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
cmd = "printf 'once\\n' >> acceptance/dedup.txt; wc -l < acceptance/dedup.txt"
r = call(cmd, ident=ident); again = call(cmd, ident=ident)
check('same_call_not_reexecuted', r == again, (r, again))
r = call('exit 7')
check('nonzero_preserved', r['exit_code'] == 7, r)
ident = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
with concurrent.futures.ThreadPoolExecutor() as pool:
    future = pool.submit(call, 'sleep 30', 40, ident)
    time.sleep(0.5)
    request('/cancel', {'id': ident})
    r = future.result(timeout=5)
check('cancel_terminates', r['state'] == 'cancelled', r)
ident = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
request('/cancel', {'id': ident})
r = call("touch acceptance/must-not-exist", ident=ident)
check('cancel_before_launch', r['state'] == 'cancelled' and call('test ! -e acceptance/must-not-exist')['exit_code'] == 0, r)
st = request('/status')
check('workspace_capacity_real', 400*1024*1024 < st['workspace']['total_bytes'] < 520*1024*1024, st['workspace'])
check('no_approval', st['approval'] == 'none')
print(json.dumps({'passed': len(results), 'cases': results, 'status': st}, ensure_ascii=False, indent=2))
