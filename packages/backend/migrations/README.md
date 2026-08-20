# b24_app migrations

The migration runner is manual and never runs at application startup. The four
`0001`-`0004` files define the first supply identity/graph mirror only. They do
not backfill data, grant runtime DML, or switch any application read/write path.
As of 2026-08-20 they are prepared locally but have not been applied to
production; production still contains only the migration metadata table.
The exact four hashes passed an isolated MariaDB 11.8 server rehearsal and an
idempotent second runner invocation. This rehearsal did not connect to the
production database. Provision every target database explicitly as
`utf8mb4/utf8mb4_unicode_ci`; do not rely on the MariaDB image default.

Future files must use `NNNN_short_name.sql`, be append-only after application,
and contain one idempotent MariaDB statement per file. A changed checksum stops
the runner. Before the first production run, verify that all four target tables
are absent; after the run, verify their columns, indexes, foreign keys and CHECK
constraints rather than relying on `IF NOT EXISTS` alone.
