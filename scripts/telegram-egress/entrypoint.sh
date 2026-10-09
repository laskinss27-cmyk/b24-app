#!/bin/bash
set -Eeuo pipefail
umask 077
# Registration is a separate, explicitly approved administrator action.
test -s /var/lib/cloudflare-warp/reg.json
test -s /etc/xray/config.json
mkdir -p /run/dbus
dbus-daemon --system --fork --nopidfile
warp_pid=''
xray_pid=''
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$xray_pid" ]]; then kill "$xray_pid" 2>/dev/null || true; fi
  if [[ -n "$warp_pid" ]]; then kill "$warp_pid" 2>/dev/null || true; fi
  wait || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
warp-svc &
warp_pid=$!
ready=false
for attempt in {1..30}; do
  kill -0 "$warp_pid"
  if warp-cli --accept-tos mode proxy >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
$ready || { echo 'WARP service unavailable' >&2; exit 1; }
warp-cli --accept-tos proxy port 40000
warp-cli --accept-tos connect
# Authenticated Docker-only SOCKS front end; WARP itself listens on loopback.
setpriv --reuid=65532 --regid=65532 --clear-groups /usr/local/bin/xray run -config /etc/xray/config.json &
xray_pid=$!
wait -n "$warp_pid" "$xray_pid"
# Restart the container if either critical process exits, even with status 0.
exit 1
