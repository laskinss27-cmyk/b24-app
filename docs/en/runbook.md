# Runbook

[Русская версия](../runbook.md)

Production procedures for integration, updates, and recovery. For quick incident diagnostics, see [SOS.md](SOS.md).

## Addresses and paths

The values below are sanitised placeholders, **not executable values or real paths**. Before running a procedure, replace them from the private production configuration. Angle brackets are used deliberately so a placeholder cannot be mistaken for a working path.

| Purpose | Value |
|---|---|
| VPS | `root@<APP_HOST>` |
| public URL | `https://app.example.com` |
| repository on VPS | `<APP_REPO>` |
| ERPNext Compose file | `<ERP_COMPOSE_FILE>` |
| initial backend environment | `<BACKEND_ENV>` |
| service scripts | `<SERVICE_DIR>` |
| local backups | `<BACKUP_DIR>` |
| nginx | `<NGINX_SITE_FILE>` |

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

This procedure updates an **already running** `b24-backend`. It does not depend on the location of an old environment file: the effective environment, state volume, and public URL are captured from the current container. A first deployment with no current container must instead use an explicitly verified `<BACKEND_ENV>` from the private configuration.

Set only the real repository path before running the block. The procedure intentionally exits before stopping the backend when that value is missing, tracked changes are present, the current container cannot reach the ERPNext network, or the rollback name is already occupied.

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

: "${APP_REPO:?set APP_REPO from the private production configuration}"
cd "$APP_REPO"

git diff --quiet
git diff --cached --quiet
if git ls-files --others --exclude-standard -- \
  packages package.json package-lock.json tsconfig.base.json Dockerfile .dockerignore \
  | grep -q .; then
  echo "untracked files would enter the Docker build context" >&2
  exit 1
fi
git fetch origin
git checkout main
git merge --ff-only origin/main

COMMIT=$(git rev-parse --short HEAD)
ROLLBACK="b24-backend-prev-before-$COMMIT"

docker container inspect b24-backend >/dev/null
if docker container inspect "$ROLLBACK" >/dev/null 2>&1; then
  echo "rollback container already exists: $ROLLBACK" >&2
  exit 1
fi
docker inspect --format '{{json .NetworkSettings.Networks}}' b24-backend \
  | grep -q '"erpnext_frappe_network"'

STATE_DIR=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/state"}}{{.Source}}{{end}}{{end}}' b24-backend)
PUBLIC_URL=$(docker exec b24-backend printenv PUBLIC_BASE_URL)
test -n "$STATE_DIR"
test -n "$PUBLIC_URL"

umask 077
ENV_SNAPSHOT=$(mktemp /tmp/b24-backend-env.XXXXXX)
trap 'rm -f "$ENV_SNAPSHOT"' EXIT
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' b24-backend > "$ENV_SNAPSHOT"
test -s "$ENV_SNAPSHOT"

docker build -t "b24-app:$COMMIT" .

restore_previous() {
  docker rm -f b24-backend >/dev/null 2>&1 || true
  docker rename "$ROLLBACK" b24-backend
  docker start b24-backend
  curl --fail --retry 15 --retry-delay 1 --retry-all-errors http://127.0.0.1:3000/health
  curl --fail --retry 5 --retry-delay 1 --retry-all-errors "${PUBLIC_URL%/}/health"
}

docker stop b24-backend
if ! docker rename b24-backend "$ROLLBACK"; then
  docker start b24-backend
  exit 1
fi

if ! docker run -d \
  --name b24-backend \
  --network erpnext_frappe_network \
  -p 127.0.0.1:3000:8080 \
  -v "$STATE_DIR:/app/state" \
  --env-file "$ENV_SNAPSHOT" \
  --restart unless-stopped \
  "b24-app:$COMMIT"; then
  restore_previous
  exit 1
fi

verify_release() {
  curl --fail --retry 15 --retry-delay 1 --retry-all-errors http://127.0.0.1:3000/health || return 1
  curl --fail --retry 5 --retry-delay 1 --retry-all-errors "${PUBLIC_URL%/}/health" || return 1
  test "$(docker inspect --format '{{.Config.Image}}' b24-backend)" = "b24-app:$COMMIT" || return 1
  docker inspect --format '{{json .NetworkSettings.Networks}}' b24-backend \
    | grep -q '"erpnext_frappe_network"' || return 1
  docker exec b24-backend node -e '
    const base = String(process.env.ERPNEXT_URL || "").replace(/\/$/, "");
    const token = String(process.env.ERPNEXT_TOKEN || "");
    fetch(base + "/api/resource/Company?fields=%5B%22name%22%5D&limit_page_length=1", {
      headers: { Authorization: token },
    }).then((response) => {
      if (!response.ok) throw new Error(`ERPNext HTTP ${response.status}`);
      return response.json();
    }).then((payload) => {
      console.log(JSON.stringify({ ok: true, rows: Array.isArray(payload.data) ? payload.data.length : 0 }));
    }).catch((error) => { console.error(error.message); process.exit(1); });
  ' || return 1
}

if ! verify_release; then
  restore_previous
  exit 1
fi

rm -f "$ENV_SNAPSHOT"
trap - EXIT
```

The previous container remains stopped under the name in `$ROLLBACK`. Do not remove it until release stability is confirmed separately. A successful `verify_release` already checks both health endpoints, the expected image, membership in `erpnext_frappe_network`, and an authenticated read-only request to ERPNext.

```bash
docker ps --filter name=b24-backend
docker inspect --format '{{.Config.Image}}' b24-backend
docker inspect --format '{{json .NetworkSettings.Networks}}' b24-backend
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
