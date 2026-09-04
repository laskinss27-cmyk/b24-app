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

Migrations `0057`-`0064` define eight tables:

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

## Remaining production gates

1. Run the migrations against a disposable MariaDB 11.8 instance and repeat them.
2. Add a read-only owner diagnostic that reads all `ctv_inv` pages and emits only
   counts, issue codes and hashes; never print full inventory payloads or OAuth.
3. Create and verify a fresh `b24_app` backup and isolated restore.
4. Apply `0057`-`0064` with the one-shot migrator and verify exact structure.
5. Run a read-only live plan. Any unknown field or malformed record is resolved
   before granting a backfill writer.
6. Apply the first exact plan with a temporary DML-only credential and prove SQL
   read-back parity. Repeat while employees continue counting.
7. Deploy `shadow` read/dual-write code with the legacy Bitrix response unchanged.
8. For the final cutover, ask users to close inventory tabs for a short window,
   wait for autosave, apply the final delta, require zero differences, enable SQL
   primary, and ask users to reload.

Until step 8, employees can continue counting normally and Bitrix remains the
only source of truth.
