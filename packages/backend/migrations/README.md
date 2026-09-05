# b24_app migrations

The migration runner is manual and never runs at application startup. The four
`0001`-`0004` files define the first supply identity/graph mirror only. They do
not backfill data, grant runtime DML, or switch any application read/write path.
As of 2026-08-20 their exact hashes have been applied to production by a
separate one-shot runner. Production contains the metadata table and four empty
domain tables; no backfill or application source switch has occurred.
The exact four hashes passed an isolated MariaDB 11.8 server rehearsal and an
idempotent second runner invocation. This rehearsal did not connect to the
production database. Provision every target database explicitly as
`utf8mb4/utf8mb4_unicode_ci`; do not rely on the MariaDB image default.

`0005` adds only an atomic supply mirror checkpoint keyed by the deterministic
plan hash. It does not add a startup job, writer permission, data rows, or a
source switch. It was applied to production by a separately authorized
one-shot runner on 2026-08-21; the checkpoint table was empty before and after
the post-DDL backup/restore drill.

`0006` defines the separate Tilda product-identity mapping table. It preserves
Tilda UID, External ID and the historical Tilda SKU while treating ERP Item
codes as external references. The migration contains no catalog rows, no
startup job and no Tilda/ERP write path. `confirmed` rows require an ERP Item;
`unresolved` and `ignored` rows can never enter the stock projection.

`0007` adds the narrow Tilda reconciliation run journal. It stores hashes,
counts, timestamps and a bounded redacted error only; it contains no payload or
credentials and does not create a scheduler. The external one-shot worker uses
a connection-scoped MariaDB lock and a dedicated account limited to `SELECT` on
the mapping table plus `SELECT/INSERT/UPDATE` on this journal. Applying `0007`,
creating that account and installing cron remain three separate production
operations.

`0008` makes the workflow line ordinal a fallback identity only when an external
line key is absent.

`0009`-`0017` are the SQL foundation for soft stock reservations:
availability lock keys, approval requests and immutable request lines,
reservation projections and lines, early-release requests, idempotent commands,
append-only events, and a deterministic manual-backfill checkpoint. They contain
DDL only and do not add runtime SQL access,
backfill rows, startup work, routes, or a source switch. `active_qty` is a stored
generated value that can only decrease through consumed, released, or shortfall
quantities. All nine files passed a clean and repeated MariaDB 11.8 rehearsal on
2026-09-01: 9 reservation tables, 32 CHECK constraints and 11 foreign keys.
They were applied to production on 2026-09-01 by a separately authorized,
least-privilege one-shot DDL identity. The temporary identity was removed and
the permanent migrator password was not changed. A post-DDL dump was restored
into an isolated database and the structure/history hashes matched. All
reservation tables remain empty and `B24_APP_RESERVATIONS=off`; DDL application
did not activate a reader, writer, backfill, route behavior, or source switch.

`0018`-`0020` extend that model for supply-created reservations and a mutable,
audited optional deal link. They add no rows and perform no backfill: existing
deal reservations remain readable through their immutable source identity until
they are naturally closed, while all newly approved reservations persist the
explicit `deal_id`. Applying these files and deploying code are separate,
explicitly authorized production operations.

Future files must use `NNNN_short_name.sql`, be append-only after application,
and contain one idempotent MariaDB statement per file. A changed checksum stops
the runner. The first production run independently verified columns, indexes,
foreign keys and CHECK constraints rather than relying on `IF NOT EXISTS`.

`0032`-`0034` prepare an application-owned public number for transfer documents.
They add a nullable, unique `public_id`, an allocator seeded later by a guarded
one-shot backfill, and a deterministic checkpoint table. DDL alone does not
populate a number, loosen the existing Bitrix identity constraint, grant DML,
or change any runtime read/write path.

`0035`-`0037` prepare SQL-first transfer mutations after the identity backfill.
They make the legacy Bitrix entity ID optional, add an idempotency command
ledger, and add a normalized revision-reference outbox for the compatibility
mirror. The outbox stores no JSON payload: every entry points to an immutable
normalized revision. These migrations do not switch runtime flags, enqueue
existing rows, or contact Bitrix24.

`0038`-`0045` define the normalized product-catalog mirror: checkpoints,
products, attributes, prices, warehouses and stock balances. ERPNext remains
the source of truth and is read only through its official REST API; Bitrix24
supplies existing iblock/section identity and metadata fallbacks. The mirror
stores no JSON payloads and never physically deletes catalog rows. A complete
snapshot is published atomically with its checkpoint last, while readers first
select the latest checkpoint and then filter every graph table by the same
observation timestamp. These migrations contain DDL only. They do not grant a
sync credential, run a backfill, install a scheduler, enable
`B24_APP_CATALOG_SQL_READ`, or switch the catalog route.

`0044` expands the human-readable attribute label from `VARCHAR(255)` to
`TEXT` after the first production source scan observed a valid 506-character
label. The failed first snapshot rolled back before its checkpoint and left all
six catalog tables empty; the append-only migration preserves the already
applied checksum of `0040`.

`0045` records whether ERPNext contained a structured catalog-content object,
including the valid empty object. This preserves exact read parity without
storing a JSON payload.

`0057`-`0064` are the disabled SQL foundation for inventory records, catalog
sections, warehouse points, immutable opening snapshots, entered counts and
comments, submitted discrepancy rows, ERP document references, and guarded
backfill checkpoints. No table contains JSON. Blank product rows are represented
by the absence of a count row; a comment-only row has a nullable fact quantity
and therefore cannot become an accidental zero. Frozen snapshot rows are never
updated or deleted by the writer. Mutable child rows use an `is_present`
tombstone instead of `DELETE`, so a least-privilege backfill can apply complete
states atomically. These migrations do not run a backfill, grant credentials,
deploy routes, or switch inventory reads and writes.

`0068`-`0071` add the disabled public-identity foundation required before
inventory writes can become SQL-first. The migrations add a nullable stable
public number, an allocator preserving every legacy Bitrix number, a guarded
identity checkpoint, and only then make the compatibility Bitrix id nullable.
They contain DDL only: they do not assign identities, allocate a native number,
change the runtime flags, or write/delete any inventory document. Assignment is
a separate dry-run/hash/apply operation through `inventories:identity-backfill`.

`0072`-`0074` add the disabled SQL-first write journal, idempotency commands,
and a recoverable Bitrix compatibility outbox. The outbox stores identifiers
and delivery state only; the normalized inventory tables remain the sole state
payload and no JSON column is introduced. These migrations do not switch a
runtime flag, enqueue existing inventories, grant credentials, or contact
Bitrix. SQL-first writes require inventory reads to already be `primary`.
