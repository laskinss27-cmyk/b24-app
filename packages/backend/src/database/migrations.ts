import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolConnection } from 'mariadb';

const MIGRATION_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MIGRATION_LOCK = 'b24_app_schema_migrations';

export interface MigrationFile {
	version: string;
	filename: string;
	checksum: string;
	sql: string;
}

export async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
	const filenames = (await readdir(directory))
		.filter((filename) => filename.endsWith('.sql'))
		.sort((left, right) => left.localeCompare(right, 'en'));
	const migrations: MigrationFile[] = [];
	for (const filename of filenames) {
		const match = MIGRATION_NAME.exec(filename);
		if (!match) throw new Error(`Invalid migration filename: ${filename}`);
		// Git checkouts and Docker build contexts may materialize the same migration
		// with different line endings. Normalize before hashing so an immutable SQL
		// migration has one checksum on Windows and Linux.
		const sql = (await readFile(join(directory, filename), 'utf8')).replace(/\r\n?/g, '\n');
		if (!sql.trim()) throw new Error(`Empty migration: ${filename}`);
		migrations.push({
			version: match[1]!,
			filename,
			checksum: createHash('sha256').update(sql).digest('hex'),
			sql,
		});
	}
	if (new Set(migrations.map((migration) => migration.version)).size !== migrations.length) {
		throw new Error('Duplicate migration version');
	}
	return migrations;
}

async function acquireMigrationLock(connection: PoolConnection): Promise<void> {
	const rows = await connection.query<Array<Record<string, unknown>>>(
		'SELECT GET_LOCK(?, 10) AS acquired',
		[MIGRATION_LOCK],
	);
	if (Number(rows[0]?.['acquired']) !== 1) throw new Error('Could not acquire migration lock');
}

async function releaseMigrationLock(connection: PoolConnection): Promise<void> {
	await connection.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK]);
}

export async function applyMigrations(pool: Pool, directory: string): Promise<string[]> {
	const migrations = await readMigrationFiles(directory);
	const connection = await pool.getConnection();
	try {
		await acquireMigrationLock(connection);
		try {
			await connection.query(`
				CREATE TABLE IF NOT EXISTS b24_app_schema_migrations (
					version VARCHAR(32) CHARACTER SET ascii NOT NULL,
					filename VARCHAR(255) NOT NULL,
					checksum CHAR(64) CHARACTER SET ascii NOT NULL,
					applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
					PRIMARY KEY (version),
					UNIQUE KEY uq_b24_app_schema_migrations_filename (filename)
				) ENGINE=InnoDB
			`);
			const rows = await connection.query<Array<Record<string, unknown>>>(
				'SELECT version, filename, checksum FROM b24_app_schema_migrations ORDER BY version',
			);
			const applied = new Map(rows.map((row) => [String(row['version']), row]));
			const appliedNow: string[] = [];
			for (const migration of migrations) {
				const previous = applied.get(migration.version);
				if (previous) {
					if (String(previous['filename']) !== migration.filename || String(previous['checksum']) !== migration.checksum) {
						throw new Error(`Applied migration changed: ${migration.version}`);
					}
					continue;
				}
				await connection.query(migration.sql);
				await connection.query(
					'INSERT INTO b24_app_schema_migrations (version, filename, checksum) VALUES (?, ?, ?)',
					[migration.version, migration.filename, migration.checksum],
				);
				appliedNow.push(migration.filename);
			}
			return appliedNow;
		} finally {
			await releaseMigrationLock(connection);
		}
	} finally {
		await connection.release();
	}
}
