"""Deploy only the independent orders receiver/worker from a verified Git image."""
import copy
import fcntl
import hashlib
import http.client
import json
import os
import pathlib
import re
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
from contextlib import closing

NAMES = ('b24-orders-receiver-1', 'b24-orders-worker-1')


def run(args, env=None):
    result = subprocess.run(args, capture_output=True, text=True, env=env)
    if result.returncode:
        raise RuntimeError('Command failed: ' + args[0])
    return result.stdout


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


class DockerSocket(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')


def create_body(old, image, labels):
    keys = ('Hostname', 'Domainname', 'User', 'ExposedPorts', 'Env', 'Cmd',
            'Healthcheck', 'Volumes', 'WorkingDir', 'Entrypoint', 'Labels',
            'StopSignal', 'StopTimeout')
    body = {key: copy.deepcopy(old['Config'][key]) for key in keys if key in old['Config']}
    body['Hostname'] = ''
    body['Image'] = image
    body['Env'] = [x for x in body['Env'] if not x.startswith('UMNIYDOM_CALLBACK_ENABLED=')]
    body['Env'].append('UMNIYDOM_CALLBACK_ENABLED=1')
    body['Labels'].update(labels)
    body['HostConfig'] = copy.deepcopy(old['HostConfig'])
    body['NetworkingConfig'] = {'EndpointsConfig': {
        name: {'Aliases': data.get('Aliases')} for name, data in old['NetworkSettings']['Networks'].items()
    }}
    return body


def create(name, body):
    connection = DockerSocket('localhost', timeout=30)
    connection.request('POST', '/containers/create?name=' + name, json.dumps(body), {'Content-Type': 'application/json'})
    response = connection.getresponse()
    result = json.loads(response.read())
    connection.close()
    if response.status != 201:
        raise RuntimeError('Candidate creation failed')
    return result['Id']


def backup(database, target):
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(target)) as destination:
        source.backup(destination)
        if destination.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            raise RuntimeError('Backup verification failed')
    target.chmod(0o600)


def health(url, sha):
    for attempt in range(30):
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                value = json.load(response)
            if value.get('ok') and value.get('gitSha') == sha:
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Receiver health/version check failed')


def main(image, sha, baseline):
    if not re.fullmatch('[a-f0-9]{40}', sha) or image != 'b24-orders:git-' + sha:
        raise RuntimeError('Full SHA image required')
    os.umask(0o077)
    with open('/run/lock/b24-deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        guard = json.loads(run(['node', 'scripts/b24-release.mjs', 'guard', image, sha, baseline]))
        previous = {name: inspect(name) for name in NAMES}
        main_backend = inspect('b24-backend')
        if not main_backend['State']['Running'] or 'erpnext_frappe_network' not in main_backend['NetworkSettings']['Networks']:
            raise RuntimeError('Main backend network/state changed')
        for name, old in previous.items():
            if old['Id'] != guard['containers'][name]['id']:
                raise RuntimeError('Container changed after guard')
        root = pathlib.Path('/opt/b24-orders/releases/callback-' + sha)
        root.mkdir(mode=0o700)
        db_mount = next(m for m in previous[NAMES[0]]['Mounts'] if m['Destination'] == '/app/state' and m['Type'] == 'bind')
        backup(pathlib.Path(db_mount['Source']) / 'orders.sqlite', root / 'orders-before.sqlite')
        nginx = pathlib.Path('/etc/nginx/sites-available/b24')
        monitor = pathlib.Path('/opt/b24-orders/monitor.py')
        nginx_before, monitor_before = nginx.read_bytes(), monitor.read_bytes()
        expected_monitor = pathlib.Path('deploy/orders-monitor-baseline.sha256').read_text().strip()
        if hashlib.sha256(monitor_before).hexdigest() != expected_monitor:
            raise RuntimeError('Monitor changed since reviewed baseline')
        text = nginx_before.decode()
        block = re.search(r'    location = /api/integrations/umniydom/v1/planner-requests \{[^{}]*\}', text)
        if not block or 'location = /api/integrations/umniydom/v1/callback-requests' in text:
            raise RuntimeError('Unexpected callback proxy baseline')
        callback_block = block.group().replace('planner-requests', 'callback-requests').replace('16k;', '4k;')
        nginx_after = text[:block.end()] + '\n\n' + callback_block + text[block.end():]
        (root / 'nginx-before.conf').write_bytes(nginx_before)
        (root / 'monitor-before.py').write_bytes(monitor_before)
        overlay = root / 'compose.callback.yaml'
        overlay.write_text('services:\n  receiver:\n    image: ' + image + '\n    environment:\n      UMNIYDOM_CALLBACK_ENABLED: "1"\n  worker:\n    image: ' + image + '\n    environment:\n      UMNIYDOM_CALLBACK_ENABLED: "1"\n')
        image_labels = inspect(image)['Config']['Labels']
        candidates = {}
        renamed = {}
        try:
            for name, old in previous.items():
                labels = {key: value for key, value in image_labels.items() if key in ('org.opencontainers.image.revision', 'com.b24.git-tree')}
                labels['com.docker.compose.project.config_files'] = old['Config']['Labels']['com.docker.compose.project.config_files'] + ',' + str(overlay)
                candidate = create(name + '-candidate-' + sha[:12], create_body(old, image, labels))
                candidates[name] = candidate
                actual = inspect(candidate)
                if actual['Image'] != guard['imageId'] or actual['State']['Running']:
                    raise RuntimeError('Stopped candidate image identity mismatch')
            for name, old in previous.items():
                if inspect(name)['Id'] != old['Id']:
                    raise RuntimeError('Runtime changed before switch')
            # Candidates are already pinned; no fresh run/create is allowed after the stop.
            for name, old in previous.items():
                run(['docker', 'stop', '--time', '30', old['Id']])
                rollback = name + '-prev-' + sha[:12]
                run(['docker', 'rename', old['Id'], rollback])
                renamed[name] = rollback
            for name, candidate in candidates.items():
                run(['docker', 'rename', candidate, name])
                run(['docker', 'start', candidate])
            health('http://127.0.0.1:3091/health', sha)
            if not inspect(NAMES[1])['State']['Running']:
                raise RuntimeError('Receiver worker stopped')
            monitor.write_bytes(pathlib.Path('deploy/orders-monitor.py').read_bytes())
            monitor.chmod(0o600)
            nginx.write_text(nginx_after)
            run(['nginx', '-t'])
            run(['systemctl', 'reload', 'nginx'])
            # Public health uses existing reverse proxy hostname, derived from its server_name.
            hostname = re.search(r'server_name\s+([^;\s]+)', text).group(1)
            # /health belongs to main backend; prove receiver routing with a rejected, empty request.
            script = "fetch(process.argv[1],{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>{if(r.status!==401)process.exit(1)})"
            run(['node', '-e', script, 'https://' + hostname + '/api/integrations/umniydom/v1/callback-requests'])
            result_backend = inspect('b24-backend')
            if result_backend['Id'] != main_backend['Id'] or 'erpnext_frappe_network' not in result_backend['NetworkSettings']['Networks']:
                raise RuntimeError('Main backend changed during receiver deployment')
            receipt = {'gitSha': sha, 'imageId': guard['imageId'], 'rollback': {name: old['Id'] for name, old in previous.items()}, 'containers': candidates, 'mainBackendUnchanged': True}
            (root / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            print(json.dumps(receipt))
        except Exception:
            nginx.write_bytes(nginx_before)
            monitor.write_bytes(monitor_before)
            run(['nginx', '-t'])
            run(['systemctl', 'reload', 'nginx'])
            for name, candidate in candidates.items():
                subprocess.run(['docker', 'rm', '-f', candidate], capture_output=True)
            for name, rollback in renamed.items():
                run(['docker', 'rename', previous[name]['Id'], name])
            for name, old in previous.items():
                run(['docker', 'start', old['Id']])
            raise


if __name__ == '__main__':
    try:
        main(*(sys.argv[1:] + [''])[:3])
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
