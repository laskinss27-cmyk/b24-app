"""Read-only queue checks. Only explicit alert delivery writes to Bitrix.

The host timer uses this file, not the main backend image. No CRM credentials
or customer payloads are printed. Missing activation keeps notifications off.
"""
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import closing


LABELS = {
    'receiver_unavailable': 'Приёмник заказов недоступен',
    'worker_unavailable': 'Обработчик заказов остановлен',
    'queue_unavailable': 'Журнал заказов недоступен',
    'queue_delayed': 'Заказы ожидают обработки более 5 минут',
    'worker_lease_expired': 'Обработка заказа прервалась',
    'technical_review': 'Нужна техническая сверка результата CRM',
    'backup_stale': 'Нет проверенной резервной копии за последние 30 часов',
    'backup_timer_inactive': 'Расписание резервирования остановлено',
}


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, path)


def run(args):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=12)


def queue_status(database, now, website_database=pathlib.Path('/opt/umniydom-site/state/orders.sqlite')):
    # mode=ro refuses a missing DB; only aggregate information leaves SQLite.
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=3)) as db:
        meta = db.execute('SELECT mode,source_id FROM orders_meta WHERE id=1').fetchone()
        if meta != ('production', '9c0725f4-1634-423e-b11a-5168d3e47ffe'):
            raise ValueError('Unexpected database')
        if db.execute('SELECT portal,chat FROM orders_destination WHERE id=1').fetchone() != ('umniydom.bitrix24.ru', 'chat3092'):
            raise ValueError('Unexpected destination')
        pending, oldest = db.execute("SELECT COUNT(*),MIN(i.created_at) FROM orders_jobs j JOIN orders_inbox i USING(receipt) WHERE j.state IN ('pending','retry','processing')").fetchone()
        expired = db.execute("SELECT COUNT(*) FROM orders_jobs WHERE state='processing' AND lease_until<=?", (int(now * 1000),)).fetchone()[0]
        review = db.execute("SELECT COUNT(*) FROM orders_jobs WHERE state='manual' AND COALESCE(reason,'')<>'ambiguous_customer'").fetchone()[0]
        # Include the independent planner pipeline in the existing delivery alarm.
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='planner_inbox_v1'").fetchone():
            count, first = db.execute("SELECT COUNT(*),MIN(CAST(strftime('%s',json_extract(payload,'$.createdAt')) AS INTEGER)*1000) FROM planner_inbox_v1 WHERE state IN ('pending','processing')").fetchone()
            pending += count
            oldest = min(x for x in [oldest, first] if x is not None) if oldest is not None or first is not None else None
            expired += db.execute("SELECT COUNT(*) FROM planner_inbox_v1 WHERE state='processing' AND lease_until<=?", (int(now*1000),)).fetchone()[0]
            review += db.execute("SELECT COUNT(*) FROM planner_inbox_v1 WHERE state='manual'").fetchone()[0]
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='callback_inbox_v1'").fetchone():
            count, first = db.execute("SELECT COUNT(*),MIN(CAST(strftime('%s',json_extract(payload,'$.createdAt')) AS INTEGER)*1000) FROM callback_inbox_v1 WHERE state IN ('pending','processing')").fetchone()
            pending += count
            oldest = min(x for x in [oldest, first] if x is not None) if oldest is not None or first is not None else None
            expired += db.execute("SELECT COUNT(*) FROM callback_inbox_v1 WHERE state='processing' AND lease_until<=?", (int(now*1000),)).fetchone()[0]
            review += db.execute("SELECT COUNT(*) FROM callback_inbox_v1 WHERE state='manual'").fetchone()[0]
        with closing(sqlite3.connect(website_database.as_uri() + '?mode=ro', uri=True)) as website:
            if website.execute("SELECT 1 FROM sqlite_master WHERE name='planner_requests_v1'").fetchone():
                count, first = website.execute("SELECT COUNT(*),MIN(CAST(strftime('%s',created_at) AS INTEGER)*1000) FROM planner_requests_v1 WHERE is_test=0 AND status IN ('pending','sending','retry')").fetchone()
                pending += count
                oldest = min(x for x in [oldest, first] if x is not None) if oldest is not None or first is not None else None
                review += website.execute("SELECT COUNT(*) FROM planner_requests_v1 WHERE is_test=0 AND status='failed'").fetchone()[0]
            if website.execute("SELECT 1 FROM sqlite_master WHERE name='callback_requests_v1'").fetchone():
                count, first = website.execute("SELECT COUNT(*),MIN(CAST(strftime('%s',created_at) AS INTEGER)*1000) FROM callback_requests_v1 WHERE is_test=0 AND status IN ('pending','sending','retry')").fetchone()
                pending += count
                oldest = min(x for x in [oldest, first] if x is not None) if oldest is not None or first is not None else None
                expired += website.execute("SELECT COUNT(*) FROM callback_requests_v1 WHERE is_test=0 AND status='sending' AND lease_until<=?", (int(now*1000),)).fetchone()[0]
                review += website.execute("SELECT COUNT(*) FROM callback_requests_v1 WHERE is_test=0 AND status='failed'").fetchone()[0]
        return {'pending': pending, 'oldestSeconds': max(0, int(now - oldest / 1000)) if oldest else 0, 'expiredLeases': expired, 'technicalReview': review}


def collect(root, active, now):
    errors = []
    try:
        with urllib.request.urlopen('http://127.0.0.1:3091/ready', timeout=5) as response:
            if response.status != 200 or not json.load(response).get('ok'):
                errors.append('receiver_unavailable')
    except Exception:
        errors.append('receiver_unavailable')
    queue = None
    try:
        queue = queue_status(pathlib.Path('/srv/b24-state/umniydom-orders/orders.sqlite'), now)
        if active and queue['pending'] and queue['oldestSeconds'] >= 300:
            errors.append('queue_delayed')
        if active and queue['expiredLeases']:
            errors.append('worker_lease_expired')
        if active and queue['technicalReview']:
            errors.append('technical_review')
    except Exception:
        errors.append('queue_unavailable')
    if active:
        try:
            worker = json.loads(run(['docker', 'inspect', 'b24-orders-worker-1']))[0]
            env = dict(x.split('=', 1) for x in worker['Config']['Env'] if '=' in x)
            if not worker['State']['Running'] or env.get('UMNIYDOM_ORDERS_PROCESSOR') != 'live':
                errors.append('worker_unavailable')
        except Exception:
            errors.append('worker_unavailable')
    try:
        backup = json.loads((root / 'last-backup.json').read_text())
        stamp = datetime.datetime.strptime(backup['at'].split('-')[0], '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()
        if not backup['restoreVerified'] or not backup['offsiteBackup'] or now - stamp > 30 * 3600:
            errors.append('backup_stale')
    except Exception:
        errors.append('backup_stale')
    try:
        if run(['systemctl', 'is-active', 'b24-orders-backup.timer']).decode().strip() != 'active':
            errors.append('backup_timer_inactive')
    except Exception:
        errors.append('backup_timer_inactive')
    return sorted(set(errors)), queue


def transition(previous, errors, now):
    state = dict(previous)
    fingerprint = ','.join(errors)
    if state.get('pending', {}).get('fingerprint') != fingerprint and state.get('delivery', {}).get('status') not in ('sending', 'unknown'):
        state.pop('pending', None)
        state.pop('delivery', None)
        state.pop('retryAfter', None)
    if state.get('observed') != fingerprint:
        state.update(observed=fingerprint, consecutive=1)
    else:
        state['consecutive'] = state.get('consecutive', 0) + 1
    event = None
    # Two observations avoid chatter on short restarts. No repeats while stable.
    if state['consecutive'] >= 2 and fingerprint != state.get('announced', ''):
        if state.get('pending'):
            event = state['pending']
        else:
            key = hashlib.sha256((fingerprint + ':' + str(now)).encode()).hexdigest()[:16]
            event = {'key': key, 'errors': errors, 'fingerprint': fingerprint, 'kind': 'problem' if errors else 'recovered'}
            state['pending'] = event
    return state, event


def send_alert(root, event):
    # Technical alerts stay in the server journal unless explicitly enabled.
    if os.environ.get('ORDERS_MONITOR_CHAT_NOTIFICATIONS') != '1':
        return {'status': 'disabled'}
    credential = (root / 'private/webhook').read_text().strip()
    if not re.fullmatch(r'https://umniydom\.bitrix24\.ru/rest/[1-9][0-9]*/[A-Za-z0-9_]+/?', credential):
        return {'status': 'rejected', 'code': 'credential_unavailable'}
    marker = 'orders-monitor:' + event['key']
    if event['kind'] == 'problem':
        text = 'Техническое уведомление: заказы интернет-магазина\n' + '\n'.join('• ' + LABELS[code] for code in event['errors'])
        text += '\nНужна проверка b24-app. Не создавайте лиды и не пересылайте заказы вручную до сверки журнала.'
    else:
        text = 'Обработка заказов интернет-магазина восстановлена. Технические проверки снова проходят.'
    body = json.dumps({'DIALOG_ID': 'chat3092', 'MESSAGE': text + '\n' + marker, 'SYSTEM': 'N', 'URL_PREVIEW': 'N'}).encode()
    request = urllib.request.Request(credential.rstrip('/') + '/im.message.add.json', data=body, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            result = json.load(response)
        if result.get('error'):
            return {'status': 'rejected', 'code': 'api_rejected'}
        if str(result.get('result', '')).isdigit():
            return {'status': 'sent', 'id': str(result['result'])}
    except urllib.error.HTTPError as error:
        if error.code in (400, 401, 403, 429):
            return {'status': 'rejected', 'code': 'api_rejected'}
    except Exception:
        pass
    # Ambiguous write outcome: preserve the marker for manual reconciliation.
    return {'status': 'unknown', 'code': 'delivery_requires_review'}


def main():
    root = pathlib.Path('/opt/b24-orders')
    os.umask(0o077)
    with (root / 'monitor.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        active = (root / 'private/worker-enabled').exists()
        now = time.time()
        errors, queue = collect(root, active, now)
        path = root / 'monitor-state.json'
        previous = json.loads(path.read_text()) if path.exists() else {}
        state, event = transition(previous, errors, now)
        if active and event and state.get('delivery', {}).get('status') not in ('sending', 'unknown') and now >= state.get('retryAfter', 0):
            state['delivery'] = {'status': 'sending', 'key': event['key']}
            write_json(path, state)  # Fence notification before its external write.
            state['delivery'] = send_alert(root, event)
            if state['delivery']['status'] in ('sent', 'disabled'):
                state['announced'] = event['fingerprint']
                state.pop('pending', None)
                state['retryAfter'] = 0
            else:
                state['retryAfter'] = now + 900
        state.update(checkedAt=now, active=active, errors=errors, queue=queue)
        write_json(path, state)
        print(json.dumps({'active': active, 'errors': errors, 'queue': queue, 'alertStatus': state.get('delivery', {}).get('status', 'none')}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Orders monitoring failed; inspect service state. Details suppressed.')
        raise SystemExit(1)
