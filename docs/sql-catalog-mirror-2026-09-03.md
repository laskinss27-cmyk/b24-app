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

The reviewed host wrapper is `scripts/catalog-sync-job.sh`. It requires an
immutable image tag and an absolute root-owned mode-`0600`/`0400` env file,
uses a host `flock`, has a five-minute timeout, joins
`erpnext_frappe_network`, and runs an ephemeral container. The production cron
entry must pin both values explicitly; changing the backend image does not
silently change the sync runner.

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

After the final snapshot, the explicitly authorized backup job created
`20260903_171824-b24_app-database.sql.gz` (`5,381,353` bytes, `35` table
definitions), verified its gzip and SHA-256 pair, and verified both uploaded
objects in the private Bitrix Disk folder (`dump_id=107382`,
`checksum_id=107380`). Retention remained disabled, so no previous backup was
removed. The dump restored only into the new isolated schema
`b24_app_restore_20260903_171824`, which remains preserved. The restore matched
the source charset/collation, all `35` table definitions, column signature
`b75f71a640d55dabaf66c4c59863ce8c638ca25c99bb2a2befaca22053f8f57f`,
index signature
`5b6730cc868502cf9b22bc3416df5b733990bb33092818940f778c759744e9bd`,
all `45` migration rows through `0045`, and every catalog table checksum. Three
unrelated active tables changed after the dump while users continued working;
the verifier reported those live changes separately and confirmed the source
schema itself was untouched. Final catalog read-back still produced checkpoint
`f7607b0737d0e3136574aad4b2e61e4083ffff65fc1bae21ede4744fc415b61e`,
and all health/network/official-ERP checks remained green.

## Production shadow rollout — 2026-09-04

The untouched overnight checkpoint still contained all `5,149` products and
`11` warehouses, with no missing or extra identity, but six products differed
from the current official sources. This confirmed that a recurring refresh was
required before shadow observation. The rollout candidate passed all `403`
backend tests, workspace typecheck and production frontend/backend builds. A
Git archive containing exactly commit `4e0b8f0` was transferred with SHA-256
`c10ccdae6db395542421b87b8e57545f4b116e748fde6f1aea773f133e390e17`
and built as immutable image `b24-app:4e0b8f0`.

The image first passed a read-only-state canary and was deployed with an
explicit `B24_APP_CATALOG_SQL_READ=off`. The prior `b24-app:d4404dc` container
is preserved as `b24-backend-prev-before-4e0b8f0`. Independent checks confirmed
internal/public health, readiness, official ERPNext read, port, state mount,
restart policy, restart count `0`, and `erpnext_frappe_network`. The permanent
backend environment contains no catalog-sync credential.

The reviewed `scripts/catalog-sync-job.sh` was installed root-only as
`/root/sync/b24-app-catalog-sync-job.sh`. Cron runs it every two minutes with
the pinned image `b24-app:4e0b8f0` and root-only
`/root/b24-app-secrets/catalog-sync.env`; the previous crontab is preserved in
the rollout staging directory. Existing ERPNext backup, `b24_app` backup and
Tilda synchronization entries were retained. The first manual refresh produced
checkpoint `df3f73bd1617aeeda926a49fde5174b5a0a9acfb88a91c11c4a452fac1f78fe2`
with `5,149` products, `38,708` attributes, `6,786` prices, `11` warehouses and
`3,560` stock rows. Scheduled runs at `07:50:01Z` and `07:52:02Z` independently
completed as idempotent no-ops with the same hash and counts.

The same image then passed a second canary and was config-only redeployed with
`B24_APP_CATALOG_SQL_READ=shadow`. Its immediately preceding `off` container is
preserved as `b24-backend-prev-before-catalog-shadow-20260904-0751`; the older
image rollback is also preserved. Final independent source comparison reported
`5,149/5,149` products, `11/11` warehouses, and zero missing, extra or different
products. Health, readiness, official ERPNext read, network, state, port and
restart count remained green. Shadow mode still serves the existing live
ERPNext/Bitrix response; `primary` was not enabled.
