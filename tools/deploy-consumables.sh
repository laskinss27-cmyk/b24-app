#!/usr/bin/env bash
set -Eeuo pipefail
ARCHIVE=${1:?archive}
RELEASE=${2:?release}
EXPECTED_ID=${3:?expected container}
EXPECTED_SHA=${4:?archive checksum}
case "$ARCHIVE" in /tmp/b24-consumables-release-*.tgz|/tmp/b24-stock-conditions-release-*.tgz) ;; *) exit 2;; esac
[[ "$RELEASE" =~ ^[0-9a-f]+-(consumables|stock-conditions)-[0-9T]+$ ]] || exit 2
test "$(sha256sum "$ARCHIVE" | cut -d ' ' -f 1)" = "$EXPECTED_SHA"
test "$(docker inspect --format '{{.Id}}' b24-backend)" = "$EXPECTED_ID"
docker inspect --format '{{json .NetworkSettings.Networks}}' b24-backend | grep -q '"erpnext_frappe_network"'
test "$(docker inspect --format '{{len .Mounts}}' b24-backend)" = 1
STATE_DIR=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/state"}}{{.Source}}{{end}}{{end}}' b24-backend)
PUBLIC_URL=$(docker exec b24-backend printenv PUBLIC_BASE_URL)
test -n "$STATE_DIR" && test -d "$STATE_DIR" && test -n "$PUBLIC_URL"
test "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' b24-backend)" = unless-stopped
test "$(docker inspect --format '{{(index (index .HostConfig.PortBindings "8080/tcp") 0).HostIp}}' b24-backend)" = 127.0.0.1
test "$(docker inspect --format '{{(index (index .HostConfig.PortBindings "8080/tcp") 0).HostPort}}' b24-backend)" = 3000
ROLLBACK="b24-backend-prev-before-$RELEASE"
FAILED="b24-backend-failed-$RELEASE"
if docker container inspect "$ROLLBACK" >/dev/null 2>&1; then echo 'Rollback name already exists' >&2; exit 1; fi
umask 077
ENV_SNAPSHOT=$(mktemp /tmp/b24-consumables-env.XXXXXX)
BUILD_DIR=$(mktemp -d /tmp/b24-consumables-build.XXXXXX)
SWITCHED=0
restore_previous() {
  set +e
  if docker container inspect b24-backend >/dev/null 2>&1; then
    docker stop b24-backend >/dev/null
    docker rename b24-backend "$FAILED"
  fi
  docker rename "$ROLLBACK" b24-backend
  docker start b24-backend >/dev/null
  curl --fail --retry 15 --retry-delay 1 --retry-all-errors -s -o /dev/null http://127.0.0.1:3000/health
  echo 'Previous backend restored; candidate retained for diagnosis' >&2
}
finish() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ] && [ "$SWITCHED" -eq 1 ]; then restore_previous; fi
  rm -f -- "$ENV_SNAPSHOT"
  exit "$code"
}
trap finish EXIT
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' b24-backend > "$ENV_SNAPSHOT"
test -s "$ENV_SNAPSHOT"
tar -xzf "$ARCHIVE" -C "$BUILD_DIR"
docker build -t "b24-app:$RELEASE" "$BUILD_DIR"
# Refuse to replace a deployment that appeared while this build was running.
test "$(docker inspect --format '{{.Id}}' b24-backend)" = "$EXPECTED_ID"
docker stop b24-backend >/dev/null
if ! docker rename b24-backend "$ROLLBACK"; then docker start b24-backend >/dev/null; exit 1; fi
SWITCHED=1
docker run -d --name b24-backend --network erpnext_frappe_network \
  -p 127.0.0.1:3000:8080 -v "$STATE_DIR:/app/state" --env-file "$ENV_SNAPSHOT" \
  --restart unless-stopped "b24-app:$RELEASE" >/dev/null
curl --fail --retry 20 --retry-delay 1 --retry-all-errors -s -o /dev/null http://127.0.0.1:3000/health
curl --fail --retry 10 --retry-delay 1 --retry-all-errors -s -o /dev/null "${PUBLIC_URL%/}/health"
docker exec b24-backend node --input-type=module -e '
const health = await fetch("http://127.0.0.1:8080/health");
if(!health.ok) throw Error("Internal health failed");
const {ErpClient} = await import("/app/packages/backend/dist/erp/client.js");
const erp=ErpClient.fromEnv(); if(!erp) throw Error("ERP not configured");
const rows=await erp.list("Company",["name"],[],1);
if(!rows.length) throw Error("ERP read returned no company");
console.log(JSON.stringify({internalHealth:true,erpRead:true}));
'
test "$(docker inspect --format '{{.Config.Image}}' b24-backend)" = "b24-app:$RELEASE"
docker inspect --format '{{json .NetworkSettings.Networks}}' b24-backend | grep -q '"erpnext_frappe_network"'
SWITCHED=0
echo "RELEASE_OK image=b24-app:$RELEASE rollback=$ROLLBACK publicHealth=true network=erpnext_frappe_network"
