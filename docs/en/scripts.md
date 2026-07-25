# Operational scripts

[Русская версия](../scripts.md)

The `scripts/` directory contains production tools, migrations, and API research history. The presence of a script does not mean it is safe to run in production.

## Production workflow

| Script | Purpose |
|---|---|
| `sos-status.sh` | reads backend, ERPNext, nginx, certificate, and backup status |
| `core-backup.sh` | daily ERPNext backup |
| `core-backup-disk.ts` | uploads the database dump to Bitrix24 Drive |
| `smoke-security.ts` | checks basic security headers |

Production copies of the backup scripts live in `/root/sync`. Compare them with the repository before changing either copy.

## Migrations

Scripts named `erp-migrate-*`, `bitrix-to-erpnext-*`, `erp-cleanup-*`, and `cleanup-*` either modify data or exist for one-off transitions. They:

- are not scheduled;
- require a fresh export and backup;
- run in dry-run or verification mode first, when available;
- run only in an agreed maintenance window;
- produce a report of created and changed IDs.

`sync.sh` and `erp-migrate-catalog.ts --stock` are preserved as migration history. They are not the current stock synchronisation mechanism and must not be added to cron.

`erp-bridge.ps1`, `erp-stock-sync.ps1`, `vps-b24-heartbeat.sh`, `vps-erp-core.nginx.conf`, and `pull-core-backup.sh` belong to a retired transitional environment. They are not part of production infrastructure and are not used by the procedures under `docs/`.

## Research and test writes

Prefixes:

- `recon-*` — REST API behaviour research;
- `test-*` — targeted checks, some of which create or modify records;
- `erp-*-smoke` and `erp-poc-*` — inventory-core checks.

Read the entire source before execution. A script name is not proof that it is read-only. The `DEV_WEBHOOK` variable often carries broad permissions.

## Safe procedure

1. Check `git status` and the script version.
2. Read which entities and IDs it touches.
3. Confirm that the endpoint and token belong to the intended environment.
4. Obtain approval and create a backup before a write.
5. Run against a limited data set.
6. Verify the result through both the user interface and the API.

Pass secrets through the environment. Never embed them into source or a command that enters shell history.
