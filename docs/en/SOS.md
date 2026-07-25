# SOS: incident diagnostics

[Русская версия](../SOS.md)

Identify the failing layer before restarting the entire server.

## 1. General check

On the VPS:

```bash
status
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:8080/api/method/ping
curl --fail https://app.example.com/health
```

If the `status` command is missing, install the current copy:

```bash
cp /srv/b24-app/scripts/sos-status.sh /usr/local/bin/status
chmod +x /usr/local/bin/status
```

## 2. None of our screens opens

If the internal backend health check fails:

```bash
docker ps -a --filter name=b24-backend
docker logs --tail 150 b24-backend
docker restart b24-backend
```

Repeat both health checks after the restart. If the problem began immediately after a deployment, follow the rollback procedure in [runbook.md](runbook.md).

## 3. Internal health works, public health does not

Check nginx and the certificate:

```bash
nginx -t
systemctl status nginx --no-pager
journalctl -u nginx --since "30 minutes ago" --no-pager
certbot certificates
systemctl status certbot.timer --no-pager
```

Reload nginx only after `nginx -t` succeeds.

## 4. Screens open, but inventory data is missing

```bash
curl --fail http://127.0.0.1:8080/api/method/ping
cd /srv/erpnext
docker compose -p erpnext -f pwd.yml ps
docker logs --tail 150 erpnext-backend-1
docker logs --tail 100 erpnext-db-1
```

If an individual container is stopped, safely start the existing stack:

```bash
docker compose -p erpnext -f pwd.yml up -d
```

Do not run `down -v`, `volume rm`, or any volume cleanup.

## 5. Only one employee or one placement is affected

Check:

1. whether the production `PUBLIC_BASE_URL/health` opens;
2. whether another one of our sections works for the same user;
3. whether the user has Bitrix24 permission for the relevant CRM entity;
4. whether the error persists after a full page reload;
5. whether an administrator opened the application after the placement changed.

If a new section is behind a beta gate, its absence for a regular user may be expected.

## 6. One record fails

Do not repeatedly trigger a write action. Record:

- deal, document, or repair ID;
- exact time;
- user;
- error text;
- action taken immediately before the error.

Then inspect backend logs for that interval:

```bash
docker logs --since "20 minutes ago" b24-backend
```

Before retrying, verify whether the document was already created in ERPNext or Bitrix24.

## 7. Backup failed

```bash
tail -200 /srv/b24-service/core-backup.log
ls -lhtr /srv/b24-backups | tail
docker exec erpnext-backend-1 bench --site frontend backup
```

A successful manual dump does not replace verification of the Bitrix24 Drive upload. Do not manually delete older backups until the scheduled job is restored.

## 8. After a VPS reboot

```bash
systemctl is-active docker nginx
cd /srv/erpnext
docker compose -p erpnext -f pwd.yml up -d
docker start b24-backend
status
```

Containers have restart policies, but final state must still be confirmed with health checks.

## 9. When to stop

Do not attempt database recovery, bulk migration, duplicate cleanup, or container-volume deletion as an improvised repair. These actions require a confirmed cause, a fresh backup, and an agreed maintenance window.
