# Repairs SQL migration — 6 September 2026

## Local foundation

The legacy `ctv_repairs` entity currently contains 33 valid records, repair
numbers through 133 and no duplicate repair number. Its JSON contract is now
mapped into normalized `repair_records`, `repair_history` and `repair_media`
tables. Checkpoints, identities, idempotent commands, immutable mutations and a
payload-free Bitrix compatibility outbox are separate tables; none contains a
JSON column.

Migrations `0075`–`0082` only create empty tables. Append-only migration `0083`
expands `repair_media.media_url` to `MEDIUMTEXT`, because the current source
stores some repair photos as embedded `data:` URLs (the production maximum
observed on 6 September was 234,135 characters). The parser keeps a bounded
4,000,000-character limit. The backfill is manual,
checkpointed by an exact deterministic hash, runs under one advisory lock and
fails closed for incomplete pagination, invalid JSON, unknown fields, duplicate
identities or any value without a normalized destination. Runtime deletion is a
soft tombstone; the application SQL users require no `DELETE` or DDL privilege.

Every repair route now uses one storage adapter. In `shadow`, Bitrix commits
first and SQL failure is logged without turning a successful employee action
into a false failure. `verified` may reconstruct the response from SQL only
after exact current parity. In `primary`, SQL commits first; a failed Bitrix
compatibility mirror remains in the bounded retry outbox. Native creation first
reserves both the public id and repair number under the same lock. The browser
keeps the same idempotency key across a failed creation retry.

A disposable MariaDB 11.8 instance applied all eight migrations twice, ran the
backfill and exact replay, changed history/media with tombstones, reserved and
replayed a native identity, created/updated/deleted a native repair, claimed and
completed both mirror operations, and denied physical `DELETE` and DDL to the
DML-only account. The complete backend suite passed 438 tests; backend and
frontend production builds and workspace typecheck passed. The disposable
database was removed.

No production migration, credential, backfill, environment change, container
replacement, source switch or deploy was performed by this local step.

## Production sequence (requires an explicit command)

1. Run the full `b24_app` backup, external read-back and preserved restore drill.
2. Apply migrations `0075`–`0083` with the migration identity.
3. Grant the one-shot backfill identity `SELECT/INSERT/UPDATE` only on the eight
   repair tables, then run the dry plan and apply only its exact printed hash.
4. Create a permanent repair runtime identity with table-scoped
   `SELECT/INSERT/UPDATE`, no checkpoint write, no `DELETE`, no DDL, and store its
   password only in a root-owned `0600` secret file.
5. Deploy `REPAIR_SQL_READ=shadow` and `REPAIR_SQL_WRITE=shadow`; verify internal
   and public health, readiness, official ERP API access and
   `erpnext_frappe_network` membership.
6. Observe exact full parity, then move reads through `verified`. Switch both
   repair read and write to `primary` only after another exact parity check.

At every deploy preserve the running backend as rollback. A rollback changes
the flags/container only; it must not delete SQL rows, commands, outbox entries,
backups, restore schemas or rollback containers.
