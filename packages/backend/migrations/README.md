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

Future files must use `NNNN_short_name.sql`, be append-only after application,
and contain one idempotent MariaDB statement per file. A changed checksum stops
the runner. The first production run independently verified columns, indexes,
foreign keys and CHECK constraints rather than relying on `IF NOT EXISTS`.
