# SQL inventory foundation — 2026-09-04

Status: local foundation only. Production DDL, credentials, backfill, deploy,
shadow reads, dual writes, and source switch have not been performed.

## Current source and safety problem

Each `ctv_inv` item stores the entire inventory and every warehouse point in one
Bitrix `DETAIL_TEXT` JSON object. A point can be actively autosaved while another
operator is preparing the SQL mirror. A one-time copy without a final delta can
therefore miss a later browser save. The existing in-process lock protects only
requests handled by one backend process and cannot make an external backfill
atomic with Bitrix.

The SQL cutover must preserve unfinished inventories exactly:

- immutable ERP stock snapshot and its capture timestamp;
- point status and responsible employee;
- entered facts, including explicit zeroes;
- comment-only rows without inventing a fact quantity;
- absent rows as absent, never as zero;
- draft session id, monotonic browser sequence and last server save metadata;
- submitted result totals and discrepancy lines;
- legacy Stock Reconciliation or the newer issue/receipt document references;
- inventory and point timestamps, sections, deadline and Bitrix public identity.

## Normalized schema

Migrations `0057`-`0064` define eight tables. Forward compatibility migrations
`0065`-`0066` preserve the root catalog scope (`sectionIds: [0]`) and the legacy
result calculation timestamp (`resultBookAt`) found by the first live dry-run:

1. `inventory_records` — Bitrix identity, title, lifecycle status, deadline,
   creator, opening time and deterministic current-state hash.
2. `inventory_sections` — ordered catalog scope with reversible tombstones.
3. `inventory_points` — one current row per warehouse, including draft sequence,
   lifecycle timestamps and result totals.
4. `inventory_snapshot_lines` — immutable product/quantity pairs captured at
   inventory opening.
5. `inventory_count_lines` — explicit fact or comment rows. `fact_qty` is nullable
   so an uncounted position cannot be converted into zero.
6. `inventory_result_lines` — submitted immutable discrepancy evidence.
7. `inventory_erp_documents` — typed references to legacy reconciliation or the
   newer issue/receipt Stock Entries.
8. `inventory_backfill_checkpoints` — exact plan hash, observation time and all
   source/target cardinalities.

The schema contains no JSON column and no cascade/delete path. A complete child
set is replaced with `is_present` flags inside one transaction. Frozen snapshot
rows are insert-once: any later quantity, product or cardinality difference aborts
the transaction.

## Local code gate

`inventory-sql/model.ts` parses and validates every currently known source field.
Unknown legacy fields block the plan instead of disappearing silently.
`inventory-sql/backfill-plan.ts` produces a deterministic hash independent of
observation time. `inventory-sql/writer.ts` requires that exact hash, takes a
MariaDB advisory lock, writes one transaction, never executes `DELETE`, and
records its checkpoint last. `inventory-sql/reader.ts` reconstructs normalized
state and recomputes every inventory state hash before returning data.

Focused tests cover an unfinished point with a frozen snapshot, one entered
quantity, one comment-only uncounted product, browser draft sequence, submitted
result rows, both new ERP adjustment documents, deterministic replay, malformed
source blocking, immutable snapshot rejection, transaction boundaries and SQL
read-back hash verification.

An isolated MariaDB `11.8.8` tmpfs rehearsal applied all eight migrations and
confirmed that a repeated migration run is a no-op. The real writer/read-back
cycle preserved an active draft, explicit zero and a comment-only uncounted row;
an exact replay was idempotent, a changed draft produced one new checkpoint, and
a changed opening snapshot rolled back. The DML-only user was unable to execute
`DELETE` or DDL. The rehearsal exposed and fixed two timezone conversions:
`DATETIME` values are now written as explicit UTC wall time and the calendar-only
deadline is read with `DATE_FORMAT`, so neither can drift on a Moscow host. The
temporary database, user and container were removed after the successful run.

## Remaining production gates

The read-only owner diagnostic, backup/restore gate and production DDL are now
prepared or completed as recorded below. The remaining separately authorized
steps are:

1. Run a read-only live plan. Any unknown field or malformed record is resolved
   before granting a backfill writer.
2. Apply the first exact plan with a temporary DML-only credential and prove SQL
   read-back parity. Repeat while employees continue counting.
3. Deploy `shadow` read/dual-write code with the legacy Bitrix response unchanged.
4. For the final cutover, ask users to close inventory tabs for a short window,
   wait for autosave, apply the final delta, require zero differences, enable SQL
   primary, and ask users to reload.

Until step 4, employees can continue counting normally and Bitrix remains the
only source of truth.

## Production DDL foundation — 5 September 2026

The explicitly authorized production step created a pre-DDL backup
`20260905_031730-b24_app-database.sql.gz` (`5,407,352` bytes, `43` table
definitions). Checksum/gzip validation and external Bitrix Disk read-back passed
with `dump_id=107792` and `checksum_id=107790`; retention was disabled. Restore
drill `b24_app_restore_20260905_031730` reproduced all `43` tables while the
source database remained unchanged.

The one-shot migrator used the existing root-only migration credential and the
required `erpnext_frappe_network`. It applied exactly `0057`-`0064`; a second
run returned `No pending migrations`. The stored migration checksums equal the
locally rehearsed files. Production now contains `64` migration rows and eight
empty inventory tables with `85` columns, `41` index rows, `6` foreign keys and
`30` checks. All eight tables are InnoDB with `utf8mb4_unicode_ci` and their row
counts are `0|0|0|0|0|0|0|0`.

Post-DDL backup `20260905_032023-b24_app-database.sql.gz` (`5,409,790` bytes,
`51` table definitions) passed local verification and external read-back with
`dump_id=107796` and `checksum_id=107794`; retention was again disabled. Restore
drill `b24_app_restore_20260905_032023` reproduced all `51` tables. Source and
restore have identical inventory column, index and constraint signatures, the
same full migration signature, and zero rows in all inventory tables.

The backend was not restarted or reconfigured and remains on
`b24-app:b755998`, restart count `0`, with the required Docker network. Internal
and public health, readiness and an official read-only ERPNext API request all
returned HTTP `200`. No inventory data was copied, no SQL reader/writer was
enabled, and Bitrix remains the inventory source of truth. The two isolated
restore databases and root-only migration staging were intentionally preserved;
nothing was deleted.

## First production read-only plan — 5 September 2026

Branch `codex/inventory-sql-foundation` was published without merging into
`main`. A separate diagnostic image was built from exact commit `3c644ab`; it
was never started as `b24-backend`. The owner-authenticated dry-run first called
`user.current`, loaded every `ctv_inv` page and had no SQL write credential or
`--apply` argument.

The source contained `10` inventories, `10` points, `2,507` frozen snapshot
lines, `1,682` count/comment lines, `370` result lines and `7` ERP document
references. The fail-closed plan correctly refused to apply with seven schema
compatibility issues and hash
`c96920cd7fed0351ef0f8befca5ea141479694567de2c7b4590d45c370ddbcd3`:

- six inventories contain the API-supported root catalog section id `0`;
- inventory `21066` contains `resultBookAt`, created by the temporary movement
  compensation logic in commit `15ad6ef` and left as historical evidence when
  that logic was removed in commit `0f4df64`.

No inventory row or SQL row was written. Local forward migrations
`0065_allow_inventory_root_section.sql` and
`0066_add_inventory_result_book_at.sql` address these exact findings without
changing the already-applied migrations. The normalized parser/reader/writer
now preserve both values. Focused tests pass `23/23`, backend typecheck passes,
and a fresh disposable MariaDB `11.8.8` rehearsal applied all ten inventory
migrations, exercised writer/read-back and rejected snapshot drift successfully.
The temporary local MariaDB container was removed. Production migrations
`0065`-`0066` and any data backfill remained unperformed at that stage.

Commit `ff4a225` was explicitly published to the same feature branch. A new
isolated image `b24-app:inventory-diagnostic-ff4a225` was built from that exact
commit without replacing the production backend. The second owner-authenticated
dry-run read the current complete source and succeeded with the same cardinality
(`10` inventories, `10` points, `2,507` snapshots, `1,682` count rows, `370`
results and `7` ERP documents), zero issues, `ready=true` and plan hash
`10b4a9826eba4e165167f377842fd5fd969d49242279c366738b7a302c3d5e06`.
It ran without `--apply` and without migration/backfill credentials. A final
check confirmed production still has migrations through `0064` and zero rows in
all eight inventory tables. Backend image, restart count, required network,
public health and readiness remained unchanged and healthy. Production
`0065`-`0066` and any inventory backfill remain separately gated.

## Production compatibility DDL — 5 September 2026

The separately authorized compatibility step began with backup
`20260905_034613-b24_app-database.sql.gz` (`5,409,788` bytes, `51` table
definitions). Checksum/gzip and external read-back passed with
`dump_id=107800`, `checksum_id=107798`, and retention disabled. Restore drill
`b24_app_restore_20260905_034613` reproduced all `51` tables without changing
the source.

The exact `ff4a225` diagnostic image was reused only as a one-shot migrator on
`erpnext_frappe_network`. It applied exactly `0065` and `0066`; the repeated
runner returned `No pending migrations`. Production now has `66` migration rows.
Stored checksums match the committed files, the root section check is
`section_id >= 0`, and nullable `inventory_points.result_book_at DATETIME(6)` is
present. All eight inventory tables and the checkpoint table remain empty.

Post-DDL backup `20260905_034750-b24_app-database.sql.gz` (`5,409,827` bytes,
`51` table definitions) passed checksum/gzip and external read-back with
`dump_id=107804`, `checksum_id=107802`, and retention disabled. Restore drill
`b24_app_restore_20260905_034750` reproduced all tables. Source and restore have
identical inventory column, index and constraint signatures and the same full
migration signature. Production remains on `b24-app:b755998`, restart `0`, with
the required network; internal/public health, readiness and official ERPNext
read are HTTP `200`. No inventory backfill, runtime deploy or source switch was
performed, and no backup, restore schema, staging or image was deleted.

## First production inventory backfill — 5 September 2026

The explicitly authorized exact plan remained stable at
`10b4a9826eba4e165167f377842fd5fd969d49242279c366738b7a302c3d5e06`.
Before the first authoritative write, backup
`20260905_035349-b24_app-database.sql.gz` (`5,409,822` bytes, `51` table
definitions) passed checksum/gzip and external read-back with `dump_id=107808`
and `checksum_id=107806`; retention was disabled. Restore drill
`b24_app_restore_20260905_035349` reproduced all `51` tables and left the source
unchanged.

The first transaction exposed an overly strict SQL check and rolled back in
full: production counts remained `0|0|0|0|0|0|0|0`. Historical reconciled
inventories `20688` and `21098` were created under older UI semantics and have
respectively `82/29/53` and `80/31/49` for total/counted/discrepancies. Their
discrepancy lines are valid preserved evidence, but can exceed the old counted
field. No source data was changed to fit the schema.

Forward migration `0067_allow_legacy_inventory_result_counts.sql` changes only
the check to require both counted and discrepancies to be no greater than
total. The parser also rejects discrepancies greater than total. Focused tests
passed `24/24`, the complete backend suite passed `422/422`, workspace typecheck
passed, and a disposable MariaDB `11.8.8` rehearsal preserved the legacy case
with exact writer/read-back parity. Commit `0b5400a` was used to build isolated
image `b24-app:inventory-diagnostic-0b5400a`; the production backend was not
replaced. The one-shot migrator applied only `0067`; its repeat returned
`No pending migrations`, bringing production to `67` migration rows.

The exact guarded backfill then reread every Bitrix inventory page and called
`user.current` before SQL. The source hash was still the approved value and the
single transaction completed with `changed=10`, `unchanged=0`, `parity=match`.
An immediate exact repeat returned `alreadyApplied=true` with parity still
matching. Independent SQL checks found `10` inventories, `10` points, `606`
sections, `2,507` snapshot lines, `1,682` count/comment lines, `370` result
lines, `7` ERP document references and one checkpoint. All six orphan checks
are zero, and the two historical result counters and line counts are unchanged.

Post-backfill backup `20260905_041531-b24_app-database.sql.gz` (`5,447,651`
bytes, `51` table definitions) passed checksum/gzip and external read-back with
`dump_id=107812`, `checksum_id=107810`; retention remained disabled. Restore
drill `b24_app_restore_20260905_041531` reproduced all tables. Each of the eight
inventory table checksums matches between source and restore, as do exact
inventory column, index and check-constraint signatures and the complete
migration signature. The restore database was intentionally preserved.

The runtime remains `b24-app:b755998`, `B24_APP_DB_MODE=readiness`, restart
count `0`, and a member of `erpnext_frappe_network`. Internal and public health,
readiness and an official ERPNext API read are HTTP `200`. No deploy, inventory
SQL read/write activation or source switch occurred; Bitrix remains the live
inventory source.
