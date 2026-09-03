# SQL catalog mirror foundation — 2026-09-03

## Goal

`POST /api/catalog/browse` currently reconstructs the full product base from
ERPNext Items, Item Prices, Bins and Warehouses on every uncached opening. The
SQL mirror turns that work into a scheduled snapshot and lets the request read
one normalized local observation. ERPNext remains authoritative and is never
read or written through its MariaDB tables.

## Stored model

Migrations `0038`-`0044` add six payload-free tables:

- `catalog_mirror_checkpoints` — deterministic snapshot identity, source counts
  and normalized row counts;
- `catalog_mirror_products` — ERP Item identity plus the existing Bitrix
  iblock/section identity and image provenance;
- `catalog_mirror_attributes` — one typed row per catalog attribute;
- `catalog_mirror_prices` — retail/purchase price plus ERPNext/Bitrix provenance;
- `catalog_mirror_warehouses` — active physical warehouses;
- `catalog_mirror_stocks` — one physical balance per Item and warehouse.

The writer takes a connection-scoped lock, verifies every source and row hash,
upserts a whole observation in one transaction, and publishes its checkpoint
last. It performs no `DELETE`. The reader selects the latest checkpoint first,
filters all five graph tables by that checkpoint's `observed_at`, verifies exact
counts and recomputes all hashes before returning data.

## Source collection

The one-shot command is `npm run catalog:sync -w @b24-app/backend`. It requires:

- official `ERPNEXT_URL` and `ERPNEXT_TOKEN` access;
- `CATALOG_WRITE_WEBHOOK` for the existing Bitrix catalog metadata;
- `B24_APP_DB_MODE=readiness`;
- a separate `B24_APP_CATALOG_SYNC_DB_USER/PASSWORD` identity.

The sync identity must be distinct from runtime, migration, backfill,
reservations, transfers and Tilda identities. Its intended SQL privileges are
only `SELECT/INSERT/UPDATE` on the six `catalog_mirror_*` tables. It needs no
DDL, `DELETE`, ERPNext database access, or privileges on other `b24_app` domain
tables. Credentials remain in a root-only operator secret file and are not part
of the permanent backend environment.

## Read gates

`B24_APP_CATALOG_SQL_READ` defaults to `off`:

- `off` — current ERPNext/Bitrix construction remains unchanged;
- `shadow` — the current response is preserved and compared with SQL;
- `primary` — a verified SQL snapshot is returned, with automatic fallback to
  the current source if SQL is absent, incomplete, corrupted or unavailable.

Both non-off modes additionally require `B24_APP_DB_MODE=readiness`. The normal
backend runtime continues to use its existing read-only SQL identity. The
reservation overlay is applied after either catalog source is built, so SQL
does not change physical stock or reservation semantics.

## Production gates still required

This foundation does not authorize or perform production DDL, snapshot writes,
scheduling, deployment or a read switch. Before the first authoritative write:

1. extend and verify the separate `b24_app` backup job for all six tables;
2. complete an isolated restore drill and record count/hash parity;
3. apply `0038`-`0044` with the migration-only identity;
4. provision the narrow catalog-sync identity and run one guarded snapshot;
5. verify latest-checkpoint reads and full shadow parity;
6. deploy with `off`, then explicitly authorize `shadow`, and only after stable
   parity explicitly authorize `primary`;
7. preserve the previous backend container and complete internal/public health,
   official ERPNext read and `erpnext_frappe_network` checks after each deploy.

## Local rehearsal evidence

On 2026-09-03 a disposable local `mariadb:11.8` container applied all 43
migrations from an empty `b24_app` database. The immediate second migration run
reported `No pending migrations`. A separate test identity with exactly
`SELECT/INSERT/UPDATE` on the six catalog tables atomically wrote and reread a
normalized fixture, verified an unchanged replay as a no-op, published a changed
snapshot, and then safely returned to the earlier content hash without adding a
duplicate checkpoint. Final fixture counts were `2` checkpoints, `1` product,
`1` attribute, `2` prices, `1` warehouse and `1` stock row. The disposable
container was stopped and automatically removed. No production connection or
credential was used.
