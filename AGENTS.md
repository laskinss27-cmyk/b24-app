# Project operating rules

## Production deployment

- Always run `b24-backend` with `--network erpnext_frappe_network`. The backend resolves ERPNext through the Docker hostname `frontend`; without this network, deal plans and other core-backed data appear empty even though the data is intact.
- Preserve the currently running backend container as the rollback container before switching versions.
- Treat every filesystem path in `docs/runbook.md` as a placeholder unless private production configuration confirms it. When updating an existing `b24-backend`, derive its effective environment, `/app/state` source, and public URL from the running container as documented; never assume an env-file path.
- After every deployment, verify all three checks: `GET /health` internally, `GET /health` through the public entry point, and a read-only request from `b24-backend` to ERPNext. The two HTTP health checks alone do not prove that the backend can reach the core.
- Do not consider a deployment complete until `docker inspect b24-backend` confirms membership in `erpnext_frappe_network`.

## b24_app SQL migration

- Keep `B24_APP_DB_MODE=off` unless a user explicitly authorizes the next production step. Never run migrations automatically at backend startup.
- Never read or write ERPNext tables directly. ERPNext stock and submitted accounting documents remain accessible only through the official ERPNext API.
- Do not run a production `b24_app` migration, backfill, shadow write, source switch, or deploy without an explicit user command. Preserve the Bitrix entity-store pagination path as fallback until parity is proven.
- Use separate least-privilege runtime, migration, backup, and one-shot backfill users for `b24_app`; never give MariaDB root credentials to the application. The backfill user must not have DDL or `DELETE` and must never be placed in the permanent backend environment.
- A mirror apply must remain manual, atomic, guarded by a deterministic checkpoint, and fail closed for incomplete/error plans. Never add a startup writer or silently retry a different plan.
- A supply shadow reader must select the latest checkpoint first and then filter every graph table by that checkpoint's `observed_at`. Never compare a current plan with mixed rows from multiple mirror observations, and never turn an incomplete current source into an empty or successful comparison.
- Bench backups do not include the separate `b24_app` database. Before authoritative SQL writes, extend the verified `/root/sync/core-backup.sh`, complete a restore drill, record the result, and confirm rollback as described in `docs/sql-migration.md`.
- Preserve frozen inventory snapshots. Movements after inventory opening are compensated in the physical-count workflow and do not make the stored snapshot stale data to rewrite.
