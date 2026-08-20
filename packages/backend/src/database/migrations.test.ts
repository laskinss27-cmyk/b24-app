import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readMigrationFiles } from './migrations.js';

test('migration files are ordered and checksummed', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'b24-app-migrations-'));
	try {
		await writeFile(join(directory, '0002_second.sql'), 'SELECT 2;\n');
		await writeFile(join(directory, '0001_first.sql'), 'SELECT 1;\n');
		const migrations = await readMigrationFiles(directory);
		assert.deepEqual(migrations.map((migration) => migration.filename), ['0001_first.sql', '0002_second.sql']);
		assert.match(migrations[0]!.checksum, /^[a-f0-9]{64}$/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('migration filenames have a stable version prefix', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'b24-app-migrations-'));
	try {
		await writeFile(join(directory, 'initial.sql'), 'SELECT 1;\n');
		await assert.rejects(() => readMigrationFiles(directory), /Invalid migration filename/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
