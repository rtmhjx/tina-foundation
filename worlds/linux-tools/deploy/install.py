#!/usr/bin/python3
"""Install the fixed executor. Run this script as root from the staged source directory."""
import grp
import os
from pathlib import Path
import pwd
import shutil
import subprocess

def run(*args):
    subprocess.run(args, check=True)

assert os.geteuid() == 0
source = Path(__file__).resolve().parents[1]
try:
    user = pwd.getpwnam('tina-tools')
except KeyError:
    run('useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'tina-tools')
    user = pwd.getpwnam('tina-tools')
gid = grp.getgrnam('tina').gr_gid
state = Path('/var/lib/tina-linux-tools')
state.mkdir(mode=0o750, exist_ok=True)
os.chown(state, user.pw_uid, gid)
work = state / 'workspace'
work.mkdir(exist_ok=True)
# A real capacity boundary, rather than a check performed before writing a file.
image = Path('/var/lib/tina-linux-tools-workspace.img')
if not image.exists():
    with image.open('xb') as f:
        f.truncate(512 * 1024 * 1024)
    image.chmod(0o600)
    run('mkfs.ext4', '-q', '-m', '0', str(image))
mount_unit = Path('/etc/systemd/system/var-lib-tina\x2dlinux\x2dtools-workspace.mount')
# systemd unit names escape hyphens in path components.
mount_unit = Path('/etc/systemd/system') / subprocess.check_output(['systemd-escape', '--path', '--suffix=mount', str(work)], text=True).strip()
mount_unit.write_text(f'''[Unit]
Description=Tina tools bounded workspace
Before=tina-linux-tools.service
[Mount]
What={image}
Where={work}
Type=ext4
Options=loop,nodev,nosuid
[Install]
WantedBy=multi-user.target
''')
bin_dir = Path('/usr/local/libexec')
bin_dir.mkdir(exist_ok=True)
shutil.copy2('/usr/bin/bwrap', bin_dir / 'tina-tools-bwrap')
(bin_dir / 'tina-tools-bwrap').chmod(0o755)
shutil.copy2(source / 'src/broker.py', bin_dir / 'tina-linux-tools-broker.py')
(bin_dir / 'tina-linux-tools-broker.py').chmod(0o755)
# Ubuntu 24.04 restricts unprivileged user namespaces. Scope this exception to the
# dedicated, root-owned bwrap binary; never disable the global kernel restriction.
profile = Path('/etc/apparmor.d/tina-linux-tools-bwrap')
profile.write_text('''abi <abi/4.0>,
include <tunables/global>
profile tina-linux-tools-bwrap /usr/local/libexec/tina-tools-bwrap flags=(unconfined) {
  userns,
}
''')
run('apparmor_parser', '-r', str(profile))
unit = Path('/etc/systemd/system/tina-linux-tools.service')
unit.write_text(f'''[Unit]
Description=Tina isolated Linux tools executor
Requires={mount_unit.name}
After={mount_unit.name}
[Service]
Type=simple
User=tina-tools
Group=tina
ExecStart=/usr/bin/python3 /usr/local/libexec/tina-linux-tools-broker.py
WorkingDirectory=/var/lib/tina-linux-tools
RuntimeDirectory=tina-linux-tools
RuntimeDirectoryMode=0750
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/tina-linux-tools /run/tina-linux-tools
PrivateTmp=yes
PrivateNetwork=yes
PrivateDevices=yes
ProtectKernelTunables=no
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=512M
MemorySwapMax=0
TasksMax=64
CPUQuota=50%
LimitNOFILE=256
LimitCORE=0
KillMode=control-group
TimeoutStopSec=5
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
''')
run('systemctl', 'daemon-reload')
run('systemctl', 'enable', '--now', mount_unit.name)
os.chown(work, user.pw_uid, gid)
work.chmod(0o770)
run('systemctl', 'enable', '--now', unit.name)
print('Executor installed; workspace mount:', mount_unit.name)
