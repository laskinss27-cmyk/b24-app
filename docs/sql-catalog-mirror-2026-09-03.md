# SQL catalog mirror foundation — 2026-09-03

## Goal

`POST /api/catalog/browse` currently reconstructs the full product base from
ERPNext Items, Item Prices, Bins and Warehouses on every uncached opening. The
SQL mirror turns that work into a scheduled snapshot and lets the request read
one normalized local observation. ERPNext remains authoritative and is never
read or written through its MariaDB tables.

## Stored model

Migrations `0038`-`0045` add six payload-free tables:

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
3. apply `0038`-`0045` with the migration-only identity;
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

## Production foundation evidence

On 2026-09-03 the production `b24_app` database applied migrations
`0038`-`0045` with the separate migration identity. Before catalog DDL, two
full `b24_app` dumps were uploaded and checksum-verified in the existing
private Bitrix Disk backup folder; isolated restore schemas reproduced table,
migration and structure parity and were deliberately retained. A third backup
after `0038`-`0043` was likewise uploaded, restored and verified. No backup
retention was run and no prior backup was removed.

The permanent `b24_app_catalog_sync` identity is stored only in root-owned
mode-`0600` operator secret files. Its grants are exactly
`SELECT/INSERT/UPDATE` on the six catalog tables; an independent negative check
confirmed that it cannot read an unrelated workflow table. The credential is
not present in the backend container environment.

The first real source scan exposed a valid 506-character attribute label. Its
transaction failed before checkpoint publication and an independent read
confirmed zero rows in all six mirror tables. Migration `0044` widened only
that normalized label column. Initial shadow comparison then exposed three
lossless reconstruction edge cases: computed ERP-only section ids, an exact
Bitrix fallback string containing trailing whitespace, and a valid empty
catalog-content object. Migration `0045` stores the content-presence bit, while
the reader derives the same section id and preserves the exact fallback value.

The resulting production checkpoint is
`f7607b0737d0e3136574aad4b2e61e4083ffff65fc1bae21ede4744fc415b61e`
with `5,149` products, `38,708` attributes, `6,786` prices, `11` warehouses and
`3,559` stock rows. Independent read-back through the permanent read-only
runtime identity recomputed the same hash and exact counts. A fresh official
ERPNext/Bitrix build compared with SQL at `5,149/5,149` products and `11/11`
warehouses, with zero missing, extra or different products.

The running backend remained image `b24-app:d4404dc`, restart count `0`, on
`erpnext_frappe_network`. Internal and public health checks and an official
ERPNext API read all returned HTTP `200`. `B24_APP_CATALOG_SQL_READ` remains
unset, which is the fail-safe `off` default: no catalog request has switched to
SQL, no scheduler was installed, and no backend deployment occurred in this
foundation stage.
