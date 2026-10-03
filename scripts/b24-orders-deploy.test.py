import importlib.util
import json
import pathlib
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

try:
    import fcntl
except ImportError:
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *args: None)

spec = importlib.util.spec_from_file_location('orders_deploy', pathlib.Path(__file__).with_name('b24-orders-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTests(unittest.TestCase):
    def old(self, name):
        return {'Id': name + '-id', 'Image': 'old-image', 'State': {'Running': True},
                'Config': {'Env': ['SECRET=private', 'UMNIYDOM_CALLBACK_ENABLED=0'], 'Cmd': ['node', 'app/cli.js', 'serve'],
                           'Labels': {'com.docker.compose.project.config_files': '/old.yaml'}, 'Hostname': 'old'},
                'HostConfig': {'PortBindings': {'3091/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3091'}]}, 'Binds': ['/state:/app/state']},
                'Mounts': [{'Destination': '/app/state', 'Source': '/state', 'Type': 'bind'}],
                'NetworkSettings': {'Networks': {'b24-orders_orders': {'Aliases': ['receiver']}}}}

    def test_clone_preserves_private_runtime_and_adds_only_callback_activation(self):
        old = self.old('receiver')
        body = deploy.create_body(old, 'new-image', {'org.opencontainers.image.revision': 'sha'})
        self.assertEqual(body['Env'], ['SECRET=private', 'UMNIYDOM_CALLBACK_ENABLED=1'])
        self.assertEqual(body['HostConfig'], old['HostConfig'])
        self.assertEqual(body['Cmd'], old['Config']['Cmd'])
        self.assertEqual(body['NetworkingConfig']['EndpointsConfig'], {'b24-orders_orders': {'Aliases': ['receiver']}})
        self.assertEqual(old['Config']['Env'][-1], 'UMNIYDOM_CALLBACK_ENABLED=0')

    def test_failed_health_restores_both_old_container_ids_and_configuration(self):
        sha = 'a' * 40
        image = 'b24-orders:git-' + sha
        old = {name: self.old(name) for name in deploy.NAMES}
        main = self.old('b24-backend')
        main['NetworkSettings']['Networks'] = {'erpnext_frappe_network': {}}
        current = {**old, 'b24-backend': main}
        current.update({item['Id']: item for item in current.values()})
        current[image] = {'Config': {'Labels': {'org.opencontainers.image.revision': sha}}}
        events = []
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            original_path = type(root)
            def path(value):
                return root / str(value).lstrip('/')
            nginx = path('/etc/nginx/sites-available/b24')
            monitor = path('/opt/b24-orders/monitor.py')
            nginx.parent.mkdir(parents=True)
            monitor.parent.mkdir(parents=True)
            path('/opt/b24-orders/releases').mkdir()
            nginx.write_text('server_name example.test;\n    location = /api/integrations/umniydom/v1/planner-requests { client_max_body_size 16k; }')
            monitor.write_text('baseline')
            path('deploy').mkdir()
            path('deploy/orders-monitor-baseline.sha256').write_text(deploy.hashlib.sha256(b'baseline').hexdigest())
            path('deploy/orders-monitor.py').write_text('new monitor')
            before = nginx.read_bytes()
            def run(args, env=None):
                events.append(args)
                if args[0] == 'node':
                    return json.dumps({'imageId': 'new-image-id', 'containers': {name: {'id': value['Id']} for name, value in old.items()}})
                if args[:2] == ['docker', 'rename']:
                    ident, name = args[2:]
                    for key, value in list(current.items()):
                        if value is current[ident] and key != ident:
                            del current[key]
                    current[name] = current[ident]
                return ''
            def create(name, body):
                ident = name + '-id'
                current[ident] = {'Id': ident, 'Image': 'new-image-id', 'State': {'Running': False}}
                return ident
            def lock_open(*args):
                return original_path(root / 'lock').open('a')
            with patch.object(deploy.pathlib, 'Path', path), patch.object(deploy, 'inspect', side_effect=lambda name: current[name]), \
                 patch.object(deploy, 'run', side_effect=run), patch.object(deploy, 'create', side_effect=create), \
                 patch.object(deploy, 'backup'), patch.object(deploy, 'health', side_effect=RuntimeError('health failed')), \
                 patch('builtins.open', side_effect=lock_open), patch.object(deploy.fcntl, 'flock'), patch.object(deploy.subprocess, 'run'):
                with self.assertRaisesRegex(RuntimeError, 'health failed'):
                    deploy.main(image, sha, 'b' * 40)
            for name, value in old.items():
                self.assertEqual(current[name]['Id'], value['Id'])
                self.assertIn(['docker', 'start', value['Id']], events)
            self.assertEqual(nginx.read_bytes(), before)
            self.assertEqual(monitor.read_text(), 'baseline')
            self.assertFalse(any(event[:3] == ['docker', 'stop', main['Id']] for event in events))

    def test_monitor_includes_callback_delays_failures_and_expired_leases_without_test_requests(self):
        spec = importlib.util.spec_from_file_location('orders_monitor', pathlib.Path(__file__).parent.parent / 'deploy/orders-monitor.py')
        monitor = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(monitor)
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            receiver, website = root / 'receiver.sqlite', root / 'website.sqlite'
            with sqlite3.connect(receiver) as db:
                db.executescript("CREATE TABLE orders_meta(id,mode,source_id); CREATE TABLE orders_destination(id,portal,chat); CREATE TABLE orders_jobs(receipt,state,lease_until,reason); CREATE TABLE orders_inbox(receipt,created_at); CREATE TABLE callback_inbox_v1(payload,state,lease_until);")
                db.execute('INSERT INTO orders_meta VALUES(1,?,?)', ('production', '9c0725f4-1634-423e-b11a-5168d3e47ffe'))
                db.execute('INSERT INTO orders_destination VALUES(1,?,?)', ('umniydom.bitrix24.ru', 'chat3092'))
                db.execute('INSERT INTO callback_inbox_v1 VALUES(?,?,?)', (json.dumps({'createdAt': '1970-01-01T00:10:00Z'}), 'processing', 1))
                db.execute('INSERT INTO callback_inbox_v1 VALUES(?,?,?)', ('{}', 'manual', 0))
            db.close()
            with sqlite3.connect(website) as db:
                db.executescript('CREATE TABLE callback_requests_v1(created_at,is_test,status,lease_until);')
                db.execute("INSERT INTO callback_requests_v1 VALUES('1970-01-01T00:12:00Z',0,'pending',0)")
                db.execute("INSERT INTO callback_requests_v1 VALUES('1970-01-01T00:00:00Z',1,'pending',0)")
                db.execute("INSERT INTO callback_requests_v1 VALUES('1970-01-01T00:12:00Z',0,'failed',0)")
            db.close()
            self.assertEqual(monitor.queue_status(receiver, 1200, website), {'pending': 2, 'oldestSeconds': 600, 'expiredLeases': 1, 'technicalReview': 2})


if __name__ == '__main__':
    unittest.main()
