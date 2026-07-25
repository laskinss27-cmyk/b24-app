# Runbook

[Русская версия](../runbook.md)

Production procedures for integration, updates, and recovery. For quick incident diagnostics, see [SOS.md](SOS.md).

## Addresses and paths

The values below are sanitised examples. Production addresses, paths, and schedules are held in private environment configuration.

| Purpose | Value |
|---|---|
| VPS | `root@<APP_HOST>` |
| public URL | `https://app.example.com` |
| repository on VPS | `/srv/b24-app` |
| ERPNext Compose file | `/srv/erpnext/pwd.yml` |
| backend environment | `/srv/b24-config/backend.env` |
| service scripts | `/srv/b24-service` |
| local backups | `/srv/b24-backups` |
| nginx | `/etc/nginx/sites-available/b24-app` |

Access is key-based SSH. Passwords, API keys, OAuth secrets, and webhooks must not be copied into commands, logs, or Git.

## Pre-deployment checks

Run from a clean source tree:

```bash
npm ci
npm run typecheck
npm -w @b24-app/backend test
npm run build
```

Do not accidentally include uncommitted user files in either the commit or the image.

## Backend deployment

Replace `COMMIT` with the short hash of a commit already pushed to `main`.

```bash
cd /srv/b24-app
git fetch origin
git checkout main
git pull --ff-only origin main

COMMIT=$(git rev-parse --short HEAD)
docker build -t b24-app:$COMMIT .

docker stop b24-backend
docker rename b24-backend b24-backend-prev-before-$COMMIT

docker run -d \
  --name b24-backend \
  --network erpnext_frappe_network \
  -p 127.0.0.1:3000:8080 \
  --env-file /srv/b24-config/backend.env \
  --restart unless-stopped \
  b24-app:$COMMIT

curl --fail http://127.0.0.1:3000/health
curl --fail https://app.example.com/health
```

The previous container remains stopped and available for rollback. After validation, confirm that the new container is `Up` and uses the expected image:

```bash
docker ps --filter name=b24-backend
docker inspect --format '{{.Config.Image}}' b24-backend
```

## Backend rollback

First identify the retained container name:

```bash
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' | grep b24-backend
```

Then stop the faulty release and restore the retained container:

```bash
docker stop b24-backend
docker rename b24-backend b24-backend-failed-COMMIT
docker rename b24-backend-prev-before-COMMIT b24-backend
docker start b24-backend

curl --fail http://127.0.0.1:3000/health
curl --fail https://app.example.com/health
```

Do not delete the retained container until the incident cause is understood.

## Connecting the Bitrix24 local application

Configure these values in the portal's server-side local application:

- application handler: `https://app.example.com/app/handler`;
- installation handler: `https://app.example.com/install`;
- uninstall handler: `https://app.example.com/uninstall`, if the field is available;
- OAuth client ID and secret must match the private backend environment file.

Application scopes must cover the CRM, placements, tasks, users, catalogue, entity storage, and Drive features actually used. Do not request broader permissions without a need.

After saving the settings, a portal administrator installs the application. Installation binds the deal tab and menu items. If placement names or handlers change, an administrator must open the application once so that the backend can reconcile bindings. After a URL change, a full Bitrix24 page reload is recommended.

## Backend environment variables

The reference structure is [deploy/backend.env.example](../../deploy/backend.env.example). The main required values are:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
PORTAL_DOMAIN=portal.example.bitrix24.ru
PUBLIC_BASE_URL=https://app.example.com
APP_CLIENT_ID=...
APP_CLIENT_SECRET=...
ERPNEXT_URL=http://frontend:8080
ERPNEXT_TOKEN=token ...
```

`APP_SECTION_URL`, `SUPPLY_SECTION_URL`, and `REPAIRS_SECTION_URL` are optional. Do not store unverified numeric placement IDs.

After an environment change, recreate the container: a plain `docker restart` does not reread `--env-file`.

## ERPNext

Production Compose project:

```bash
cd /srv/erpnext
docker compose -p erpnext -f pwd.yml ps
docker compose -p erpnext -f pwd.yml up -d
```

`down -v`, Docker-volume deletion, and volume cleanup are prohibited because they destroy inventory-core data.

## Backups

The production crontab runs `/srv/b24-service/core-backup.sh`. The exact schedule is managed outside the repository. A database dump is created daily; public and private file archives are added periodically. Retention and external-storage policies are held in private configuration.

Verification:

```bash
tail -100 /srv/b24-service/core-backup.log
ls -lhtr /srv/b24-backups | tail
```

`sync.sh` is retained as a migration tool, but is absent from the production crontab and does not run automatically.

## ERPNext recovery

Recovery overwrites the production database. Before starting:

1. stop user operations;
2. record the selected backup timestamp;
3. create an additional fresh backup;
4. verify the database dump and, when required, the file archives;
5. confirm the procedure with the responsible owner.

The base command runs inside `erpnext-backend-1`:

```bash
bench --site frontend restore /path/to/database.sql.gz \
  --with-public-files /path/to/files.tar \
  --with-private-files /path/to/private-files.tar \
  --db-root-username root \
  --db-root-password 'ACTUAL_PASSWORD'
```

Read the current password from the production server configuration, not from documentation. After recovery, check `ping`, the Item count, recent inventory documents, and both application health checks.

## Initial deployment to a new VPS

Build a replacement environment only from:

- repository `main`;
- files under `deploy/`;
- a recent, verified ERPNext backup;
- environment files and keys transferred separately.

Order: Docker and Compose → ERPNext → data recovery → backend → nginx and TLS → health checks → Bitrix24 integration → test deal. Image versions are pinned in [deploy/pwd.yml](../../deploy/pwd.yml); do not upgrade them at the same time as a migration.
