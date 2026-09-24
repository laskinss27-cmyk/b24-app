#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:?usage: b24-release-source-guard.sh IMAGE}
CONTAINER=${2:-b24-backend}
docker container inspect "$CONTAINER" >/dev/null
docker image inspect "$IMAGE" >/dev/null

current=$(mktemp)
candidate=$(mktemp)
missing=$(mktemp)
trap 'rm -f "$current" "$candidate" "$missing"' EXIT

roots='/app/packages/backend/src /app/packages/frontend/src /app/packages/shared/src'
docker exec "$CONTAINER" sh -c "find $roots -type f | sed 's#^/app/##' | sort" > "$current"
docker run --rm --network none --entrypoint sh "$IMAGE" -c "find $roots -type f | sed 's#^/app/##' | sort" > "$candidate"
comm -23 "$current" "$candidate" > "$missing"

if test -s "$missing"; then
  echo 'Candidate image is missing source files present in production:' >&2
  cat "$missing" >&2
  exit 1
fi
echo 'Source continuity: OK'
