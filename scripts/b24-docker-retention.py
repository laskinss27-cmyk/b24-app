#!/usr/bin/env python3
"""Scoped production retention. Dry-run by default; never removes volumes."""
import argparse
import datetime as dt
import json
import re
import subprocess
import time
import urllib.request

GRACE_SECONDS = 3600
KEEP_ROLLBACKS = 2


class Deferred(RuntimeError):
    pass


def run(*args, check=True):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=check)


def inspect_all(kind):
    # Scheduled --rm jobs can disappear between listing and inspection.
    # Retry the whole snapshot; never infer that an uninspected object is unused.
    for attempt in range(5):
        ids = sorted(set(run("docker", kind, "ls", "-aq").stdout.split()))
        result = []
        for start in range(0, len(ids), 100):
            inspected = run("docker", kind, "inspect", *ids[start:start+100], check=False)
            if inspected.returncode:
                break
            result.extend(json.loads(inspected.stdout))
        else:
            return result
        time.sleep(0.2)
    raise RuntimeError("Cannot obtain a stable Docker " + kind + " inventory")


def epoch(value):
    value = re.sub(r"\.(\d{6})\d+", r".\1", value)
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def owned(ref):
    repo = ref.split(":")[0]
    return repo in ("b24-app", "b24-backend", "cr.yandex/crpj8ipjmjimigbf8dq7/b24-app") or repo.startswith("b24-app-migrate-") or repo == "b24-app-request-identity-dry-run"


def owned_image(im):
    tags = im.get("RepoTags") or []
    if tags:
        return all(owned(tag) for tag in tags)
    cfg = im.get("Config") or {}
    # Audited legacy b24-app builds whose tags were overwritten (June/July).
    return (not im.get("RepoDigests") and cfg.get("WorkingDir") == "/app"
            and cfg.get("Cmd") == ["node", "packages/backend/dist/server.js"]
            and set(cfg.get("ExposedPorts") or {}) == {"8080/tcp"})


def pinned(obj):
    return (obj.get("Config", {}).get("Labels") or {}).get("b24.retention.keep") == "true"


def scheduled_images():
    cron = run("crontab", "-l").stdout
    lines = [x for x in cron.splitlines() if x.strip() and not x.lstrip().startswith("#")]
    refs = set()
    for job in ("/root/sync/tilda-stock-sync-job.sh", "/root/sync/b24-app-catalog-sync-job.sh"):
        matches = [line for line in lines if job in line]
        if not matches:
            raise RuntimeError("Required scheduled job missing: " + job)
        with open(job, encoding="utf-8") as source:
            body = source.read()
        tags = set(re.findall(r"\bb24-app:[A-Za-z0-9_.-]+", "\n".join(matches) + "\n" + body))
        if not tags:
            raise RuntimeError("Cannot resolve scheduled image: " + job)
        refs.update(tags)
    # Also protect explicit app image references in other active cron entries.
    refs.update(re.findall(r"\bb24-app:[A-Za-z0-9_.-]+", "\n".join(lines)))
    ids = set()
    for ref in sorted(refs):
        ids.add(json.loads(run("docker", "image", "inspect", ref).stdout)[0]["Id"])
    return refs, ids


def plan(containers, images, scheduled, now):
    backend = next(c for c in containers if c["Name"] == "/b24-backend")
    if not backend["State"]["Running"] or "erpnext_frappe_network" not in backend["NetworkSettings"]["Networks"]:
        raise RuntimeError("Backend is not running on the required ERP network")
    if now - epoch(backend["State"]["StartedAt"]) < GRACE_SECONDS:
        raise Deferred("Backend changed recently; retry after the one-hour safety window")
    rollback = sorted((c for c in containers if c["Name"].startswith("/b24-backend-prev")
                       and c["State"]["Status"] == "exited" and c["State"].get("ExitCode") == 0),
                      key=lambda c: c["Created"], reverse=True)
    keep = []
    seen = {backend["Image"]}
    for c in rollback:
        if c["Image"] not in seen:
            keep.append(c)
            seen.add(c["Image"])
        if len(keep) == KEEP_ROLLBACKS:
            break
    protected_containers = {c["Id"] for c in keep}
    remove = []
    for c in containers:
        name = c["Name"].lstrip("/")
        scoped = name.startswith(("b24-backend-", "b24-app-migrate-", "b24-app-catalog-sync-"))
        if (scoped and owned(c["Config"]["Image"]) and c["State"]["Status"] == "exited"
                and c["Id"] not in protected_containers and not pinned(c)
                and not any(m["Type"] == "volume" for m in c.get("Mounts", []))
                and now - epoch(c["State"]["FinishedAt"]) >= GRACE_SECONDS):
            remove.append(c)
    removed_ids = {c["Id"] for c in remove}
    protected_images = scheduled | {c["Image"] for c in containers if c["Id"] not in removed_ids}
    candidates = []
    for im in images:
        if (owned_image(im) and im["Id"] not in protected_images
                and not pinned(im) and now - epoch(im["Created"]) >= GRACE_SECONDS):
            candidates.append(im)
    return backend, keep, remove, candidates


def main():
    import fcntl
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--empty-cache", action="store_true", help="Initial approved cleanup only")
    args = parser.parse_args()
    lock = open("/run/lock/b24-docker-retention.lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    refs, scheduled = scheduled_images()
    containers, images = inspect_all("container"), inspect_all("image")
    try:
        backend, keep, remove, candidates = plan(containers, images, scheduled, time.time())
    except Deferred as reason:
        print(json.dumps({"deferred": str(reason)}), flush=True)
        return
    with urllib.request.urlopen("http://127.0.0.1:3000/health", timeout=15) as response:
        if response.status != 200:
            raise RuntimeError("Backend health failed")
    report = {"mode": "apply" if args.apply else "dry-run", "keep_rollbacks": [c["Name"] for c in keep],
              "scheduled_images": sorted(refs), "remove_containers": len(remove),
              "remove_images": len(candidates), "protected_running": [c["Name"] for c in containers if c["State"]["Running"]]}
    print(json.dumps(report, ensure_ascii=False), flush=True)
    if not args.apply:
        return

    def guard():
        current = json.loads(run("docker", "container", "inspect", "b24-backend").stdout)[0]
        if current["Id"] != backend["Id"] or not current["State"]["Running"] or scheduled_images() != (refs, scheduled):
            raise RuntimeError("Production configuration changed during cleanup; aborting")

    deleted_containers, failed = 0, 0
    for c in remove:
        guard()
        fresh = json.loads(run("docker", "container", "inspect", c["Id"]).stdout)[0]
        if fresh["State"]["Status"] != "exited":
            continue
        result = run("docker", "container", "rm", c["Id"], check=False)
        deleted_containers += result.returncode == 0
        failed += result.returncode != 0
        if deleted_containers and deleted_containers % 25 == 0:
            print(json.dumps({"deleted_containers": deleted_containers}), flush=True)
    deleted_images = 0
    for im in candidates:
        guard()
        # A newly started container always protects its actual image, even if its tag changed.
        if im["Id"] in {c["Image"] for c in inspect_all("container")}:
            continue
        for tag in im.get("RepoTags") or []:
            fresh = run("docker", "image", "inspect", tag, check=False)
            if fresh.returncode == 0 and json.loads(fresh.stdout)[0]["Id"] == im["Id"]:
                run("docker", "image", "rm", "--no-prune", tag, check=False)
        fresh = run("docker", "image", "inspect", im["Id"], check=False)
        if fresh.returncode == 0:
            run("docker", "image", "rm", "--no-prune", im["Id"], check=False)
        if run("docker", "image", "inspect", im["Id"], check=False).returncode != 0:
            deleted_images += 1
        else:
            failed += 1
        if deleted_images and deleted_images % 25 == 0:
            print(json.dumps({"deleted_images": deleted_images}), flush=True)
    guard()
    cache_args = [] if args.empty_cache else ["--max-used-space", "2GB", "--reserved-space", "0"]
    cache = run("docker", "builder", "prune", "--all", "--force", *cache_args)
    # Avoid dumping the verbose build cache index into logs.
    print(json.dumps({"deleted_containers": deleted_containers, "deleted_images": deleted_images,
                      "skipped_or_failed": failed, "cache_summary": cache.stdout.splitlines()[-1:]}), flush=True)
    if failed:
        raise RuntimeError("Some candidates remain; inspect before retrying")


if __name__ == "__main__":
    main()
