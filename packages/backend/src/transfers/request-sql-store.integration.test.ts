import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import mariadb, { type Pool } from 'mariadb';
import { applyMigrations } from '../database/migrations.js';
import type { StoredTransferRequest } from './request-model.js';
import { applyTransferRequestBackfill, buildTransferRequestBackfillPlan } from './request-sql-backfill.js';
import { compareTransferRequestSqlParity } from './request-sql-compare.js';
import { readCurrentSqlTransferRequests } from './request-sql-reader.js';
import {
	createNativeTransferRequestSql,
	deleteNativeTransferRequestSql,
	markTransferRequestSqlDeleted,
	readPendingTransferRequestBitrixMirrors,
	updateNativeTransferRequestSql,
	writeTransferRequestSqlRevision,
} from './request-sql-store.js';
import type { TransferSqlPool } from './sql-store.js';

const enabled = process.env['B24_TRANSFER_REQUEST_TEST_MARIADB'] === '1';
const database = 'b24_transfer_request_rehearsal';
const writerUser = 'b24_transfer_request_writer';
const writerPassword = 'request-rehearsal-only-password';
const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

function request(note = 'Первая версия'): StoredTransferRequest {
	return {
		id: 21, name: 'Заявка снабжению #21', kind: 'supply', fromStore: '', toStore: 'Основной', lines: [],
		supplyLines: [{ productId: 100, name: 'Камера', qty: 2, link: 'https://example.test/item', note: 'чёрная' }],
		note, status: 'pending', createdAt: '2026-09-04T08:00:00.000Z', createdById: '1', createdByName: 'Менеджер',
		convertedAt: '', convertedById: '', convertedByName: '', transferId: null, taskId: 77,
		canceledAt: '', canceledById: '', canceledByName: '',
	};
}

async function count(pool: Pool, table: string): Promise<number> {
	const rows = await pool.query<Array<Record<string, unknown>>>(`SELECT COUNT(*) AS count FROM ${table}`);
	return Number(rows[0]?.['count']);
}

test('real MariaDB transfer request mirror is normalized, append-only and DML-only', { skip: !enabled }, async () => {
	const host = String(process.env['B24_TRANSFER_REQUEST_TEST_HOST'] ?? '127.0.0.1');
	const port = Number(process.env['B24_TRANSFER_REQUEST_TEST_PORT']);
	const rootPassword = String(process.env['B24_TRANSFER_REQUEST_TEST_ROOT_PASSWORD'] ?? '');
	assert.ok(Number.isInteger(port) && port > 0 && rootPassword);
	const root = mariadb.createPool({ host, port, user: 'root', password: rootPassword, connectionLimit: 1 });
	const rehearsalDirectory = await mkdtemp(join(tmpdir(), 'b24-transfer-request-migrations-'));
	let schemaPool: Pool | undefined;
	let writerPool: Pool | undefined;
	try {
		for (const filename of [
			'0046_create_stock_transfer_request_records.sql', '0047_create_stock_transfer_request_revisions.sql',
			'0048_create_stock_transfer_request_revision_lines.sql', '0049_create_stock_transfer_request_backfill_checkpoints.sql',
			'0050_add_stock_transfer_request_public_id.sql', '0051_create_stock_transfer_request_public_ids.sql',
			'0052_create_stock_transfer_request_identity_checkpoints.sql', '0053_make_stock_transfer_request_bitrix_identity_optional.sql',
			'0054_create_stock_transfer_request_commands.sql', '0055_create_stock_transfer_request_bitrix_outbox.sql',
			'0056_allow_stock_transfer_request_sql_native_source.sql',
		]) await copyFile(join(migrationsDirectory, filename), join(rehearsalDirectory, filename));
		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${writerUser}'@'%'`);
		await root.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
		schemaPool = mariadb.createPool({ host, port, user: 'root', password: rootPassword, database, connectionLimit: 1 });
		assert.equal((await applyMigrations(schemaPool, rehearsalDirectory)).length, 11);
		assert.deepEqual(await applyMigrations(schemaPool, rehearsalDirectory), []);
		await root.query(`CREATE USER '${writerUser}'@'%' IDENTIFIED BY '${writerPassword}'`);
		await root.query(`GRANT SELECT, INSERT, UPDATE ON ${database}.* TO '${writerUser}'@'%'`);
		writerPool = mariadb.createPool({ host, port, user: writerUser, password: writerPassword, database, connectionLimit: 2 });
		const sqlPool = writerPool as unknown as TransferSqlPool;
		const initial = request();
		const plan = buildTransferRequestBackfillPlan({ observedAt: '2026-09-04T09:00:00Z', sourceComplete: true, sourceRecordCount: 1, requests: [initial] });
		assert.equal((await applyTransferRequestBackfill(sqlPool, plan, plan.planHash)).createdRevisionCount, 1);
		assert.equal((await applyTransferRequestBackfill(sqlPool, plan, plan.planHash)).alreadyApplied, true);
		assert.equal(compareTransferRequestSqlParity([initial], await readCurrentSqlTransferRequests(sqlPool)).matches, true);
		const changed = request('Вторая версия');
		const { id, name, ...data } = changed;
		await writeTransferRequestSqlRevision(sqlPool, { externalId: id, name, data, sourceKind: 'bitrix_dual_write' });
		assert.equal(compareTransferRequestSqlParity([changed], await readCurrentSqlTransferRequests(sqlPool)).matches, true);
		assert.equal(await count(schemaPool, 'stock_transfer_request_records'), 1);
		assert.equal(await count(schemaPool, 'stock_transfer_request_revisions'), 2);
		await markTransferRequestSqlDeleted(sqlPool, { externalId: id, name });
		assert.deepEqual(await readCurrentSqlTransferRequests(sqlPool), []);
		await writeTransferRequestSqlRevision(sqlPool, { externalId: id, name, data, sourceKind: 'repair' });
		assert.equal((await readCurrentSqlTransferRequests(sqlPool)).length, 1);
		assert.equal(await count(schemaPool, 'stock_transfer_request_revisions'), 2);
		const nativeData = { ...data, createdAt: '2026-09-04T10:00:00.000Z', taskId: null };
		const native = await createNativeTransferRequestSql(sqlPool, { idempotencyKey: 'integration:request:create', name: 'Новая заявка', data: nativeData });
		const repeated = await createNativeTransferRequestSql(sqlPool, { idempotencyKey: 'integration:request:create', name: 'Новая заявка', data: nativeData });
		assert.equal(native.publicId, 22);
		assert.equal(repeated.publicId, native.publicId);
		assert.equal(repeated.alreadyApplied, true);
		const nativeUpdate = await updateNativeTransferRequestSql(sqlPool, {
			publicId: native.publicId, idempotencyKey: 'integration:request:update', name: `Заявка снабжению #${native.publicId}`,
			data: { ...nativeData, note: 'SQL primary' },
		});
		assert.equal(nativeUpdate.revisionNo, 2);
		assert.deepEqual((await readPendingTransferRequestBitrixMirrors(sqlPool)).map((entry) => entry.publicId), [native.publicId]);
		const deleted = await deleteNativeTransferRequestSql(sqlPool, { publicId: native.publicId, idempotencyKey: 'integration:request:delete', name: `Заявка снабжению #${native.publicId}` });
		assert.equal(deleted.alreadyApplied, false);
		assert.equal((await readPendingTransferRequestBitrixMirrors(sqlPool))[0]?.operationKind, 'delete');
		await assert.rejects(() => writerPool!.query('DELETE FROM stock_transfer_request_records WHERE id = -1'), /(?:denied|command)/i);
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
