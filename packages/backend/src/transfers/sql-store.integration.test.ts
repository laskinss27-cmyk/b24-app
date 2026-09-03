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
import { applyTransferIdentityBackfill, buildTransferIdentityBackfillPlan, readTransferIdentityRows } from './sql-identity.js';
import { readCurrentSqlTransfer, readCurrentSqlTransfers } from './sql-reader.js';
import {
	createNativeTransferSql,
	claimTransferBitrixMirror,
	deleteNativeTransferSql,
	markTransferBitrixDeleteDelivered,
	markTransferBitrixMirrorDelivered,
	markTransferSqlDeleted,
	readPendingTransferBitrixMirrors,
	readTransferBitrixExternalId,
	updateNativeTransferSql,
	writeTransferSqlRevision,
	type TransferSqlPool,
} from './sql-store.js';

const enabled = process.env['B24_TRANSFER_TEST_MARIADB'] === '1';
const database = 'b24_transfer_rehearsal';
const writerUser = 'b24_transfer_rehearsal_writer';
const writerPassword = 'transfer-rehearsal-only-password';
const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

function transfer(qty = 2): StoredTransfer {
	const data = newTransferData({
		fromStore: 'Склад А', toStore: 'Склад Б', lines: [{ productId: 100, name: 'Камера', qty }],
		createdAt: '2026-09-02T07:00:00.000Z', createdById: '1', createdByName: 'Менеджер',
	});
	data.history.push({
		at: '2026-09-02T07:01:00.000Z', status: 'draft', byId: '1', action: 'lines_changed',
		changes: [{ productId: 100, name: 'Камера', field: 'planned', from: '', to: qty }],
	});
	return {
		id: 7,
		name: 'Перемещение #7',
		...data,
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
			'0030_add_stock_transfer_revision_format.sql',
			'0031_add_stock_transfer_change_value_types.sql',
			'0032_add_stock_transfer_public_id.sql',
			'0033_create_stock_transfer_public_ids.sql',
			'0034_create_stock_transfer_identity_checkpoints.sql',
			'0035_make_stock_transfer_bitrix_identity_optional.sql',
			'0036_create_stock_transfer_commands.sql',
			'0037_create_stock_transfer_bitrix_outbox.sql',
		]) await copyFile(join(migrationsDirectory, filename), join(rehearsalMigrationsDirectory, filename));

		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${writerUser}'@'%'`);
		await root.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
		schemaPool = mariadb.createPool({ host, port, user: 'root', password: rootPassword, database, connectionLimit: 1 });
		assert.equal((await applyMigrations(schemaPool, rehearsalMigrationsDirectory)).length, 15);
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

		const identityPlan = buildTransferIdentityBackfillPlan(
			await readTransferIdentityRows(sqlPool),
			'2026-09-03T08:00:00.000Z',
		);
		const identityApplied = await applyTransferIdentityBackfill(sqlPool, identityPlan, identityPlan.planHash);
		const identityRepeated = await applyTransferIdentityBackfill(sqlPool, identityPlan, identityPlan.planHash);
		assert.equal(identityApplied.assignedRecordCount, 0);
		assert.equal(identityRepeated.alreadyApplied, true);
		assert.deepEqual(await readTransferIdentityRows(sqlPool), [{ recordId: 1, bitrixExternalId: 7, publicId: 7 }]);
		const allocator = await schemaPool.query<Array<Record<string, unknown>>>(
			'SELECT public_id, legacy_bitrix_external_id FROM stock_transfer_public_ids',
		);
		assert.deepEqual(allocator.map((row) => [Number(row['public_id']), Number(row['legacy_bitrix_external_id'])]), [[7, 7]]);

		const changed = transfer(3);
		const { id, name, ...data } = changed;
		await writeTransferSqlRevision(sqlPool, { externalId: id, name, data, sourceKind: 'bitrix_dual_write' });
		assert.equal(compareTransferSqlParity([changed], await readCurrentSqlTransfers(sqlPool)).matches, true);
		assert.equal(await count(schemaPool, 'stock_transfer_records'), 1);
		assert.equal(await count(schemaPool, 'stock_transfer_revisions'), 2);
		assert.equal(await count(schemaPool, 'stock_transfer_backfill_checkpoints'), 1);
		assert.equal(await count(schemaPool, 'stock_transfer_identity_checkpoints'), 1);

		const nativeData = newTransferData({
			fromStore: 'Склад В', toStore: 'Склад Г', lines: [{ productId: 200, name: 'Монитор', qty: 1 }],
			createdAt: '2026-09-03T10:00:00.000Z', createdById: '2', createdByName: 'Снабжение',
		});
		const native = await createNativeTransferSql(sqlPool, {
			idempotencyKey: 'integration:create:one', name: 'Перемещение SQL', data: nativeData,
		});
		const nativeRepeated = await createNativeTransferSql(sqlPool, {
			idempotencyKey: 'integration:create:one', name: 'Перемещение SQL', data: nativeData,
		});
		assert.equal(native.publicId, 8);
		assert.equal(native.alreadyApplied, false);
		assert.equal(nativeRepeated.publicId, native.publicId);
		assert.equal(nativeRepeated.alreadyApplied, true);
		await assert.rejects(() => createNativeTransferSql(sqlPool, {
			idempotencyKey: 'integration:create:one', name: 'Другой документ', data: nativeData,
		}), /already used/);
		assert.equal((await readCurrentSqlTransfer(sqlPool, native.publicId))?.lines[0]?.qty, 1);

		const nativeChanged = structuredClone(nativeData);
		nativeChanged.lines[0]!.qty = 2;
		const nativeUpdate = await updateNativeTransferSql(sqlPool, {
			publicId: native.publicId, idempotencyKey: 'integration:update:one', name: 'Перемещение SQL', data: nativeChanged,
		});
		const nativeUpdateRepeated = await updateNativeTransferSql(sqlPool, {
			publicId: native.publicId, idempotencyKey: 'integration:update:one', name: 'Перемещение SQL', data: nativeChanged,
		});
		assert.equal(nativeUpdate.revisionNo, 2);
		assert.equal(nativeUpdateRepeated.alreadyApplied, true);
		assert.equal((await readCurrentSqlTransfer(sqlPool, native.publicId))?.lines[0]?.qty, 2);
		const pending = await readPendingTransferBitrixMirrors(sqlPool);
		assert.deepEqual(pending.map((entry) => [entry.publicId, entry.revisionId, entry.operationKind]), [[native.publicId, nativeUpdate.revisionId, 'upsert']]);
		const mirrorLeaseToken = '00000000-0000-4000-8000-000000000001';
		assert.equal(await claimTransferBitrixMirror(sqlPool, {
			publicId: native.publicId, revisionId: nativeUpdate.revisionId, operationKind: 'upsert', leaseToken: mirrorLeaseToken,
		}), true);
		assert.equal(await claimTransferBitrixMirror(sqlPool, {
			publicId: native.publicId,
			revisionId: nativeUpdate.revisionId,
			operationKind: 'upsert',
			leaseToken: '00000000-0000-4000-8000-000000000002',
		}), false);
		await markTransferBitrixMirrorDelivered(sqlPool, {
			publicId: native.publicId, revisionId: nativeUpdate.revisionId, bitrixExternalId: 900, leaseToken: mirrorLeaseToken,
		});
		assert.equal(await readTransferBitrixExternalId(sqlPool, native.publicId), 900);
		assert.deepEqual(await readPendingTransferBitrixMirrors(sqlPool), []);
		assert.equal(await count(schemaPool, 'stock_transfer_commands'), 2);
		assert.equal(await count(schemaPool, 'stock_transfer_bitrix_outbox'), 2);

		const nativeDelete = await deleteNativeTransferSql(sqlPool, {
			publicId: native.publicId, idempotencyKey: 'integration:delete:one', name: 'Перемещение SQL',
		});
		const nativeDeleteRepeated = await deleteNativeTransferSql(sqlPool, {
			publicId: native.publicId, idempotencyKey: 'integration:delete:one', name: 'Переименованное удалённое перемещение',
		});
		assert.equal(nativeDelete.alreadyApplied, false);
		assert.equal(nativeDeleteRepeated.alreadyApplied, true);
		assert.equal(await readCurrentSqlTransfer(sqlPool, native.publicId), null);
		assert.deepEqual((await readPendingTransferBitrixMirrors(sqlPool)).map((entry) => [entry.publicId, entry.operationKind]), [[native.publicId, 'delete']]);
		const deleteLeaseToken = '00000000-0000-4000-8000-000000000003';
		assert.equal(await claimTransferBitrixMirror(sqlPool, {
			publicId: native.publicId, revisionId: nativeDelete.revisionId, operationKind: 'delete', leaseToken: deleteLeaseToken,
		}), true);
		assert.equal(await claimTransferBitrixMirror(sqlPool, {
			publicId: native.publicId,
			revisionId: nativeDelete.revisionId,
			operationKind: 'delete',
			leaseToken: '00000000-0000-4000-8000-000000000004',
		}), false);
		await markTransferBitrixDeleteDelivered(sqlPool, {
			publicId: native.publicId, revisionId: nativeDelete.revisionId, leaseToken: deleteLeaseToken,
		});
		assert.deepEqual(await readPendingTransferBitrixMirrors(sqlPool), []);
		assert.equal(await count(schemaPool, 'stock_transfer_commands'), 3);
		assert.equal(await count(schemaPool, 'stock_transfer_bitrix_outbox'), 3);
		assert.equal(await count(schemaPool, 'stock_transfer_records'), 2);
		assert.equal(await count(schemaPool, 'stock_transfer_revisions'), 4);

		await markTransferSqlDeleted(sqlPool, { externalId: 7, name: 'Перемещение #7' });
		assert.deepEqual((await readCurrentSqlTransfers(sqlPool)).map((item) => item.id), []);
		await writeTransferSqlRevision(sqlPool, { externalId: id, name, data, sourceKind: 'repair' });
		assert.deepEqual((await readCurrentSqlTransfers(sqlPool)).map((item) => item.id), [7]);
		assert.equal(await count(schemaPool, 'stock_transfer_revisions'), 4);

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
