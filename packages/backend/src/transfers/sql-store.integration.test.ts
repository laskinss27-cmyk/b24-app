import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import mariadb, { type Pool } from 'mariadb';
import { applyMigrations } from '../database/migrations.js';
import { newTransferData, type StoredTransfer } from './model.js';
import { applyTransferSqlBackfill, buildTransferSqlBackfillPlan } from './sql-backfill.js';
import { compareTransferSqlParity } from './sql-compare.js';
import { readCurrentSqlTransfers } from './sql-reader.js';
import { markTransferSqlDeleted, writeTransferSqlRevision, type TransferSqlPool } from './sql-store.js';

const enabled = process.env['B24_TRANSFER_TEST_MARIADB'] === '1';
const database = 'b24_transfer_rehearsal';
const writerUser = 'b24_transfer_rehearsal_writer';
const writerPassword = 'transfer-rehearsal-only-password';
const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

function transfer(qty = 2): StoredTransfer {
	return {
		id: 7,
		name: 'Перемещение #7',
		...newTransferData({
			fromStore: 'Склад А', toStore: 'Склад Б', lines: [{ productId: 100, name: 'Камера', qty }],
			createdAt: '2026-09-02T07:00:00.000Z', createdById: '1', createdByName: 'Менеджер',
		}),
	};
}

async function count(pool: Pool, table: string): Promise<number> {
	const rows = await pool.query<Array<Record<string, unknown>>>(`SELECT COUNT(*) AS count FROM ${table}`);
	return Number(rows[0]?.['count']);
}

test('real MariaDB transfer store is normalized, append-only, recoverable and DML-only', { skip: !enabled }, async () => {
	const host = String(process.env['B24_TRANSFER_TEST_HOST'] ?? '127.0.0.1');
	const port = Number(process.env['B24_TRANSFER_TEST_PORT']);
	const rootPassword = String(process.env['B24_TRANSFER_TEST_ROOT_PASSWORD'] ?? '');
	assert.ok(Number.isInteger(port) && port > 0);
	assert.ok(rootPassword);

	const root = mariadb.createPool({ host, port, user: 'root', password: rootPassword, connectionLimit: 1 });
	const rehearsalMigrationsDirectory = await mkdtemp(join(tmpdir(), 'b24-transfer-migrations-'));
	let schemaPool: Pool | undefined;
	let writerPool: Pool | undefined;
	try {
		for (const filename of [
			'0023_create_stock_transfer_records.sql',
			'0024_create_stock_transfer_revisions.sql',
			'0025_create_stock_transfer_revision_lines.sql',
			'0026_create_stock_transfer_revision_history.sql',
			'0027_create_stock_transfer_history_changes.sql',
			'0028_create_stock_transfer_revision_corrections.sql',
			'0029_create_stock_transfer_backfill_checkpoints.sql',
		]) await copyFile(join(migrationsDirectory, filename), join(rehearsalMigrationsDirectory, filename));

		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${writerUser}'@'%'`);
		await root.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
		schemaPool = mariadb.createPool({ host, port, user: 'root', password: rootPassword, database, connectionLimit: 1 });
		assert.equal((await applyMigrations(schemaPool, rehearsalMigrationsDirectory)).length, 7);
		assert.deepEqual(await applyMigrations(schemaPool, rehearsalMigrationsDirectory), []);

		await root.query(`CREATE USER '${writerUser}'@'%' IDENTIFIED BY '${writerPassword}'`);
		await root.query(`GRANT SELECT, INSERT, UPDATE ON ${database}.* TO '${writerUser}'@'%'`);
		writerPool = mariadb.createPool({ host, port, user: writerUser, password: writerPassword, database, connectionLimit: 2 });
		const sqlPool = writerPool as unknown as TransferSqlPool;

		const initial = transfer();
		const plan = buildTransferSqlBackfillPlan({
			observedAt: '2026-09-02T09:00:00.000Z', sourceComplete: true, sourceRecordCount: 1, transfers: [initial],
		});
		const applied = await applyTransferSqlBackfill(sqlPool, plan, plan.planHash);
		const repeated = await applyTransferSqlBackfill(sqlPool, plan, plan.planHash);
		assert.equal(applied.createdRevisionCount, 1);
		assert.equal(repeated.alreadyApplied, true);
		assert.equal(compareTransferSqlParity([initial], await readCurrentSqlTransfers(sqlPool)).matches, true);

		const changed = transfer(3);
		const { id, name, ...data } = changed;
		await writeTransferSqlRevision(sqlPool, { externalId: id, name, data, sourceKind: 'bitrix_dual_write' });
		assert.equal(compareTransferSqlParity([changed], await readCurrentSqlTransfers(sqlPool)).matches, true);
		assert.equal(await count(schemaPool, 'stock_transfer_records'), 1);
		assert.equal(await count(schemaPool, 'stock_transfer_revisions'), 2);
		assert.equal(await count(schemaPool, 'stock_transfer_backfill_checkpoints'), 1);

		await markTransferSqlDeleted(sqlPool, { externalId: 7, name: 'Перемещение #7' });
		assert.deepEqual(await readCurrentSqlTransfers(sqlPool), []);
		await writeTransferSqlRevision(sqlPool, { externalId: id, name, data, sourceKind: 'repair' });
		assert.equal(compareTransferSqlParity([changed], await readCurrentSqlTransfers(sqlPool)).matches, true);
		assert.equal(await count(schemaPool, 'stock_transfer_revisions'), 2);

		await assert.rejects(() => writerPool!.query('DELETE FROM stock_transfer_records WHERE id = -1'), /(?:denied|command)/i);
		await assert.rejects(() => writerPool!.query('CREATE TABLE forbidden_ddl (id INT NOT NULL)'), /(?:denied|command)/i);
	} finally {
		if (writerPool) await writerPool.end();
		if (schemaPool) await schemaPool.end();
		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${writerUser}'@'%'`);
		await root.end();
		await rm(rehearsalMigrationsDirectory, { recursive: true, force: true });
	}
});
