#!/usr/bin/env bash
# Run from the clean, pushed Git checkout used to build the image.
set -Eeuo pipefail
IMAGE=${1:?usage: b24-deploy.sh IMAGE FULL_SHA [LEGACY_BASELINE_FULL_SHA]}
SHA=${2:?full Git SHA required}
BASELINE=${3:-}
if test "${B24_RELEASE_TARGET:-}" = orders; then
  exec python3 scripts/b24-orders-deploy.py "$IMAGE" "$SHA" "$BASELINE"
fi
test "$IMAGE" = "b24-app:git-$SHA" || { echo 'Use the full-SHA b24-app release tag' >&2; exit 1; }

exec 9>/run/lock/b24-deploy.lock
flock -n 9 || { echo 'Another deployment is in progress' >&2; exit 1; }

umask 077
GUARD_RESULT=$(mktemp)
ENV_SNAPSHOT=$(mktemp)
CANDIDATE_ID=''
cleanup() {
  rm -f "$GUARD_RESULT" "$ENV_SNAPSHOT"
  if test -n "$CANDIDATE_ID"; then docker rm "$CANDIDATE_ID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# No stop/rename/run of the service is allowed before this guard succeeds.
node scripts/b24-release.mjs guard "$IMAGE" "$SHA" "$BASELINE" > "$GUARD_RESULT"
IMAGE_ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).imageId)' "$GUARD_RESULT")
PREVIOUS_ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).previousContainerId)' "$GUARD_RESULT")
test "$(docker inspect --format '{{.Id}}' b24-backend)" = "$PREVIOUS_ID"

STATE_DIR=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/state"}}{{.Source}}{{end}}{{end}}' "$PREVIOUS_ID")
PUBLIC_URL=$(docker exec "$PREVIOUS_ID" printenv PUBLIC_BASE_URL)
test -n "$STATE_DIR"
test -n "$PUBLIC_URL"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$PREVIOUS_ID" > "$ENV_SNAPSHOT"
test -s "$ENV_SNAPSHOT"
ROLLBACK="b24-backend-prev-before-${SHA:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
if docker container inspect "$ROLLBACK" >/dev/null 2>&1; then
  echo 'Rollback container already exists' >&2
  exit 1
fi

# Create without executing code, then pin the exact container/image before any downtime.
# Keeping the Git tag in Config.Image also preserves compatibility with the retention service.
CANDIDATE_NAME="b24-backend-candidate-${SHA:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
CANDIDATE_ID=$(docker create --name "$CANDIDATE_NAME" --network erpnext_frappe_network \
  -p 127.0.0.1:3000:8080 -v "$STATE_DIR:/app/state" \
  --env-file "$ENV_SNAPSHOT" --restart unless-stopped "$IMAGE")
test "$(docker inspect --format '{{.Image}}' "$CANDIDATE_ID")" = "$IMAGE_ID"
test "$(docker inspect --format '{{.Id}}' b24-backend)" = "$PREVIOUS_ID"

verify_health() {
  curl --fail --silent --show-error --retry 15 --retry-delay 1 --retry-all-errors "$1" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const h=JSON.parse(s);if(!h.ok||h.gitSha!==process.argv[1])process.exit(1);console.log(JSON.stringify({health:true,gitSha:h.gitSha}));})' "$SHA"
}

rollback() {
  trap - ERR INT TERM
  echo 'Deployment failed; restoring previous container' >&2
  if docker container inspect "$ROLLBACK" >/dev/null 2>&1; then
    docker rm -f b24-backend >/dev/null 2>&1 || true
    docker rename "$ROLLBACK" b24-backend
  fi
  docker start "$PREVIOUS_ID" >/dev/null
  curl --fail --silent --show-error --retry 15 --retry-delay 1 --retry-all-errors http://127.0.0.1:3000/health
  curl --fail --silent --show-error --retry 5 --retry-delay 1 --retry-all-errors "${PUBLIC_URL%/}/health"
  exit 1
}

trap rollback ERR INT TERM
docker stop "$PREVIOUS_ID" >/dev/null
docker rename b24-backend "$ROLLBACK"
docker rename "$CANDIDATE_ID" b24-backend
docker start "$CANDIDATE_ID" >/dev/null

verify_health http://127.0.0.1:3000/health
verify_health "${PUBLIC_URL%/}/health"
test "$(docker inspect --format '{{.Image}}' b24-backend)" = "$IMAGE_ID"
docker inspect --format '{{json .NetworkSettings.Networks}}' b24-backend |
  node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{if(!JSON.parse(s).erpnext_frappe_network)process.exit(1);})'
docker exec b24-backend node -e '
  const base = String(process.env.ERPNEXT_URL || "").replace(/\/$/, "");
  fetch(base + "/api/resource/Company?fields=%5B%22name%22%5D&limit_page_length=1", {
    headers: { Authorization: String(process.env.ERPNEXT_TOKEN || "") }, signal: AbortSignal.timeout(15000),
  }).then(async r => { if (!r.ok) throw new Error(`ERPNext HTTP ${r.status}`); const p=await r.json(); if(!Array.isArray(p.data))throw new Error("Invalid ERPNext response"); console.log("ERPNext read-only check: OK"); })
    .catch(e => { console.error(e.message); process.exit(1); });'
trap - ERR INT TERM
CANDIDATE_ID=''
echo "Release verified: $SHA; rollback: $ROLLBACK"
systemctl start b24-docker-retention.service
