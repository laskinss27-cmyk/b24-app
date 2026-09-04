#!/usr/bin/env bash
set -Eeuo pipefail

# Install in cron only after a reviewed production dry run. Secrets stay in the
# root-owned env file and are never passed on the command line.
: "${B24_CATALOG_SYNC_IMAGE:?B24_CATALOG_SYNC_IMAGE is required}"
: "${B24_CATALOG_SYNC_ENV_FILE:?B24_CATALOG_SYNC_ENV_FILE is required}"

case "$B24_CATALOG_SYNC_IMAGE" in
	*:*|*@sha256:*) ;;
	*) echo "Refusing a mutable or unversioned catalog sync image" >&2; exit 1 ;;
esac
if [[ "$B24_CATALOG_SYNC_IMAGE" == *:latest ]]; then
	echo "Refusing the mutable latest image tag" >&2
	exit 1
fi
if [[ "$B24_CATALOG_SYNC_ENV_FILE" != /* || ! -f "$B24_CATALOG_SYNC_ENV_FILE" ]]; then
	echo "B24_CATALOG_SYNC_ENV_FILE must be an existing absolute path" >&2
	exit 1
fi
if [[ "$(stat -c '%U' "$B24_CATALOG_SYNC_ENV_FILE")" != root ]]; then
	echo "Catalog sync env file must be owned by root" >&2
	exit 1
fi
env_mode="$(stat -c '%a' "$B24_CATALOG_SYNC_ENV_FILE")"
if [[ "$env_mode" != 600 && "$env_mode" != 400 ]]; then
	echo "Catalog sync env file mode must be 600 or 400" >&2
	exit 1
fi

exec 9>/run/lock/b24-app-catalog-sync.lock
if ! flock -n 9; then
	echo "Catalog sync skipped: previous host job is still running"
	exit 0
fi

timeout --signal=TERM 5m docker run --rm \
	--network erpnext_frappe_network \
	--env-file "$B24_CATALOG_SYNC_ENV_FILE" \
	"$B24_CATALOG_SYNC_IMAGE" \
	node packages/backend/dist/catalog-mirror/sync.js 9>&-
