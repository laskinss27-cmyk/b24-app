#!/usr/bin/env python3
"""Read-only verification against the approved cleanup's sanitized baseline."""
import hashlib
import json
import subprocess
import urllib.request


def read(*args):
    return subprocess.check_output(args, text=True)


def mounts(container):
    # Docker does not promise a stable ordering of the mount array.
    return sorted(container["Mounts"], key=lambda m: (m["Destination"], m["Source"]))


with open("/var/lib/b24-docker-retention/before-20260915.json") as f:
    before = json.load(f)
ids = read("docker", "ps", "-aq").split()
containers = json.loads(read("docker", "inspect", *ids))
current = {c["Id"]: c for c in containers}
unchanged = all(c["Id"] in current and current[c["Id"]]["State"]["Running"]
                and current[c["Id"]]["Image"] == c["Image"]
                and mounts(current[c["Id"]]) == mounts(c) for c in before["running"])
backend = next(c for c in containers if c["Name"] == "/b24-backend")
env = dict(v.split("=", 1) for v in backend["Config"]["Env"])
with urllib.request.urlopen(env["PUBLIC_BASE_URL"].rstrip("/") + "/health", timeout=30) as response:
    public_status = response.status
probe = """
(async () => {
  const internal = await fetch('http://127.0.0.1:8080/health', {signal: AbortSignal.timeout(20000)});
  const erp = await fetch(process.env.ERPNEXT_URL.replace(/\\/$/, '') + '/api/method/frappe.auth.get_logged_user', {
    headers: {Authorization: process.env.ERPNEXT_TOKEN}, signal: AbortSignal.timeout(20000)});
  const data = await erp.json();
  const ok = erp.ok && typeof data.message === 'string' && data.message !== 'Guest';
  console.log(JSON.stringify({internal_health: internal.status, erp_http: erp.status, erp_authenticated: ok}));
  if (!internal.ok || !ok) process.exitCode = 1;
})().catch(() => { console.log(JSON.stringify({probe_error: true})); process.exitCode = 1; });
"""
checks = json.loads(read("docker", "exec", "b24-backend", "node", "-e", probe))
checks.update(running_and_mounts_unchanged=unchanged,
              volumes_unchanged=sorted(before["volumes"]) == sorted(read("docker", "volume", "ls", "-q").split()),
              cron_unchanged=before["cron_sha256"] == hashlib.sha256(subprocess.check_output(["crontab", "-l"])).hexdigest(),
              public_health=public_status,
              erp_network="erpnext_frappe_network" in backend["NetworkSettings"]["Networks"],
              running_count=sum(c["State"]["Running"] for c in containers),
              stopped=[{"name": c["Name"], "image": c["Config"]["Image"]} for c in containers if not c["State"]["Running"]],
              docker_disk=read("docker", "system", "df"), disk_before=before["disk"], disk_after=read("df", "-B1", "/"))
print(json.dumps(checks, ensure_ascii=False, indent=2))
assert unchanged and checks["volumes_unchanged"] and checks["cron_unchanged"] and checks["erp_network"]
assert public_status == 200 and checks["internal_health"] == 200 and checks["erp_authenticated"]
