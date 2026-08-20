# b24_app migrations

The migration runner is present, but this directory intentionally contains no
domain migration in stage 0/1. Running the command creates only the migration
metadata table and does not backfill or switch any application data.

Future files must use `NNNN_short_name.sql`, be append-only after application,
and contain one idempotent MariaDB statement per file. A changed checksum stops
the runner. Migrations are manual and must never run during application startup.
