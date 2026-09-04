import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import mariadb, { type Pool } from 'mariadb';
import { applyMigrations } from '../database/migrations.js';
import type { TransferSqlPool } from '../transfers/sql-store.js';
import { buildInventorySqlBackfillPlan } from './backfill-plan.js';
import { compareInventorySqlParity } from './compare.js';
import { readInventorySqlRecords } from './reader.js';
import { applyInventorySqlBackfill } from './writer.js';

const enabled = process.env['B24_INVENTORY_TEST_MARIADB'] === '1';
const database = 'b24_inventory_rehearsal';
const writerUser = 'b24_inventory_backfill';
const writerPassword = 'inventory-rehearsal-only-password';
const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

function sourceItem(factQty = 2, snapshotQty = 3): Record<string, unknown> {
	return {
		ID: '21664', NAME: 'Незаконченная ревизия', DATE_CREATE: '2026-09-04T08:00:00Z', CREATED_BY: '1858',
		DETAIL_TEXT: JSON.stringify({
			status: 'active', deadline: '2026-09-05', createdById: '1858', createdAt: '2026-09-04T08:00:00Z',
			stockSnapshotAt: '2026-09-04T08:00:00Z', sectionIds: [4, 9],
			points: [{
				storeId: -1366325545, storeName: 'Основной', status: 'in_progress', responsibleId: '986', responsibleName: 'Сотрудник',
				stockSnapshot: { version: 1, capturedAt: '2026-09-04T08:00:00Z', lines: [[11962, snapshotQty], [13017, 2]] },
				draft: { 11962: factQty }, comments: { 13017: 'Ещё не считал' }, draftSessionId: 'browser-session-1', draftSequence: 7,
			}],
		}),
	};
}

function plan(item: Record<string, unknown>, observedAt: string) {
	return buildInventorySqlBackfillPlan({ observedAt, sourceComplete: true, sourceRecordCount: 1, items: [item] });
}

test('real MariaDB keeps active inventory drafts normalized and freezes their opening snapshot', { skip: !enabled }, async () => {
	const host = String(process.env['B24_INVENTORY_TEST_HOST'] ?? '127.0.0.1');
	const port = Number(process.env['B24_INVENTORY_TEST_PORT']);
	const rootPassword = String(process.env['B24_INVENTORY_TEST_ROOT_PASSWORD'] ?? '');
	assert.ok(Number.isInteger(port) && port > 0 && rootPassword);
	const root = mariadb.createPool({ host, port, user: 'root', password: rootPassword, connectionLimit: 1 });
	const rehearsalDirectory = await mkdtemp(join(tmpdir(), 'b24-inventory-migrations-'));
	let schemaPool: Pool | undefined;
	let writerPool: Pool | undefined;
	try {
		for (const filename of [
			'0057_create_inventory_records.sql', '0058_create_inventory_sections.sql',
			'0059_create_inventory_points.sql', '0060_create_inventory_snapshot_lines.sql',
			'0061_create_inventory_count_lines.sql', '0062_create_inventory_result_lines.sql',
			'0063_create_inventory_erp_documents.sql', '0064_create_inventory_backfill_checkpoints.sql',
		]) await copyFile(join(migrationsDirectory, filename), join(rehearsalDirectory, filename));
		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${writerUser}'@'%'`);
		await root.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
		schemaPool = mariadb.createPool({ host, port, user: 'root', password: rootPassword, database, connectionLimit: 1 });
		assert.equal((await applyMigrations(schemaPool, rehearsalDirectory)).length, 8);
		assert.deepEqual(await applyMigrations(schemaPool, rehearsalDirectory), []);
		await root.query(`CREATE USER '${writerUser}'@'%' IDENTIFIED BY '${writerPassword}'`);
		await root.query(`GRANT SELECT, INSERT, UPDATE ON ${database}.* TO '${writerUser}'@'%'`);
		writerPool = mariadb.createPool({ host, port, user: writerUser, password: writerPassword, database, connectionLimit: 2 });
		const sqlPool = writerPool as unknown as TransferSqlPool;

		const initial = plan(sourceItem(), '2026-09-04T10:00:00Z');
		assert.equal((await applyInventorySqlBackfill(sqlPool, initial, initial.planHash)).changedInventoryCount, 1);
		assert.equal((await applyInventorySqlBackfill(sqlPool, initial, initial.planHash)).alreadyApplied, true);
		assert.equal(compareInventorySqlParity(initial.inventories, await readInventorySqlRecords(sqlPool)).matches, true);

		const changed = plan(sourceItem(0), '2026-09-04T10:05:00Z');
		assert.equal((await applyInventorySqlBackfill(sqlPool, changed, changed.planHash)).changedInventoryCount, 1);
		const stored = await readInventorySqlRecords(sqlPool);
		assert.equal(compareInventorySqlParity(changed.inventories, stored).matches, true);
		assert.equal(stored[0]?.points[0]?.countLines.find((line) => line.productId === 11962)?.factQty, 0);
		assert.equal(stored[0]?.points[0]?.countLines.find((line) => line.productId === 13017)?.factQty, null);

		const driftingSnapshot = plan(sourceItem(0, 2), '2026-09-04T10:10:00Z');
		await assert.rejects(
			() => applyInventorySqlBackfill(sqlPool, driftingSnapshot, driftingSnapshot.planHash),
			/Frozen inventory snapshot changed/,
		);
		assert.equal(compareInventorySqlParity(changed.inventories, await readInventorySqlRecords(sqlPool)).matches, true);
		await assert.rejects(() => writerPool!.query('DELETE FROM inventory_records WHERE id = -1'), /(?:denied|command)/i);
		await assert.rejects(() => writerPool!.query('CREATE TABLE forbidden_ddl (id INT NOT NULL)'), /(?:denied|command)/i);
	} finally {
		if (writerPool) await writerPool.end();
		if (schemaPool) await schemaPool.end();
		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${writerUser}'@'%'`);
		await root.end();
		await rm(rehearsalDirectory, { recursive: true, force: true });
	}
});
