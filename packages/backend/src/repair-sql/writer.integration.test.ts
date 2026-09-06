import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import mariadb, { type Pool } from 'mariadb';
import { applyMigrations } from '../database/migrations.js';
import type { TransferSqlPool } from '../transfers/sql-store.js';
import { buildRepairSqlBackfillPlan } from './backfill-plan.js';
import { compareRepairSqlParity } from './compare.js';
import { readRepairSqlRecords } from './reader.js';
import {
	applyRepairSqlBackfill, claimRepairBitrixMirror, createNativeRepairSql, deleteNativeRepairSql,
	markRepairBitrixDeleteDelivered, markRepairBitrixMirrorDelivered, readPendingRepairBitrixMirrors,
	readRepairBitrixExternalId, reserveNativeRepairIdentity, updateNativeRepairSql, writeRepairSqlRecord,
} from './writer.js';

const enabled = process.env['B24_REPAIR_TEST_MARIADB'] === '1';
const database = 'b24_repair_rehearsal';
const writerUser = 'b24_repair_backfill';
const writerPassword = 'repair-rehearsal-only-password';
const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

function sourceItem(options: { history?: number; photos?: number; status?: string } = {}): Record<string, unknown> {
	const historyCount = options.history ?? 2;
	const photoCount = options.photos ?? 2;
	return {
		ID: '501', NAME: 'Камера · DS-2CD · Клиент', DATE_CREATE: '2026-09-01T10:00:00Z', CREATED_BY: '1858',
		DETAIL_TEXT: JSON.stringify({
			kind: 'client', status: options.status ?? 'sent', repairNo: 133,
			client: { contactId: 55, name: 'Клиент', phone: '+70000000000' },
			device: 'Камера', model: 'DS-2CD', serial: 'SN', point: 'Дунайский',
			appearance: 'без повреждений', defect: 'не включается', payType: 'paid', cost: 1000, ourPrice: 1500,
			dealId: 77, taskId: 88, clientRefusal: null, repairItemCode: 'REPAIR-133', repairStore: 'Дунайский',
			issueStore: null, repairDeliveryNote: null, productId: null, sourceStore: null,
			comment: 'Комментарий', internalComment: 'Проверить блок питания',
			photos: Array.from({ length: photoCount }, (_, index) => ({ id: index + 1, name: `photo-${index + 1}.jpg`, url: `https://example.test/photo-${index + 1}.jpg` })),
			files: [{ id: 10, name: 'act.pdf', url: 'https://example.test/act.pdf', type: 'application/pdf' }],
			createdAt: '2026-09-01T10:00:00.000Z', createdById: '1858', createdByName: 'Owner',
			history: Array.from({ length: historyCount }, (_, index) => ({
				at: `2026-09-0${index + 1}T10:00:00.000Z`, status: index === 0 ? 'received_tt' : (options.status ?? 'sent'), byId: '1858', byName: 'Owner',
			})),
		}),
	};
}

function plan(item: Record<string, unknown>, observedAt: string) {
	return buildRepairSqlBackfillPlan({ observedAt, sourceComplete: true, sourceRecordCount: 1, items: [item] });
}

test('real MariaDB backfills repairs without JSON or destructive writer privileges', { skip: !enabled }, async () => {
	const host = String(process.env['B24_REPAIR_TEST_HOST'] ?? '127.0.0.1');
	const port = Number(process.env['B24_REPAIR_TEST_PORT']);
	const rootPassword = String(process.env['B24_REPAIR_TEST_ROOT_PASSWORD'] ?? '');
	assert.ok(Number.isInteger(port) && port > 0 && rootPassword);
	const root = mariadb.createPool({ host, port, user: 'root', password: rootPassword, connectionLimit: 1 });
	const rehearsalDirectory = await mkdtemp(join(tmpdir(), 'b24-repair-migrations-'));
	let schemaPool: Pool | undefined;
	let writerPool: Pool | undefined;
	try {
		for (const filename of [
			'0075_create_repair_records.sql', '0076_create_repair_history.sql', '0077_create_repair_media.sql',
			'0078_create_repair_backfill_checkpoints.sql', '0079_create_repair_mutations.sql',
			'0080_create_repair_commands.sql', '0081_create_repair_bitrix_outbox.sql',
			'0082_create_repair_identities.sql', '0083_expand_repair_media_url.sql',
		]) await copyFile(join(migrationsDirectory, filename), join(rehearsalDirectory, filename));
		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${writerUser}'@'%'`);
		await root.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
		schemaPool = mariadb.createPool({ host, port, user: 'root', password: rootPassword, database, connectionLimit: 1 });
		assert.equal((await applyMigrations(schemaPool, rehearsalDirectory)).length, 9);
		assert.deepEqual(await applyMigrations(schemaPool, rehearsalDirectory), []);
		await root.query(`CREATE USER '${writerUser}'@'%' IDENTIFIED BY '${writerPassword}'`);
		await root.query(`GRANT SELECT, INSERT, UPDATE ON ${database}.* TO '${writerUser}'@'%'`);
		writerPool = mariadb.createPool({ host, port, user: writerUser, password: writerPassword, database, connectionLimit: 2 });
		const sqlPool = writerPool as unknown as TransferSqlPool;

		const initial = plan(sourceItem(), '2026-09-06T08:00:00Z');
		assert.equal(initial.readyToApply, true);
		assert.deepEqual(await applyRepairSqlBackfill(sqlPool, initial, initial.planHash), {
			alreadyApplied: false, changedRecordCount: 1, unchangedRecordCount: 0,
		});
		assert.deepEqual(await applyRepairSqlBackfill(sqlPool, initial, initial.planHash), {
			alreadyApplied: true, changedRecordCount: 0, unchangedRecordCount: 1,
		});
		assert.equal(compareRepairSqlParity(initial.records, await readRepairSqlRecords(sqlPool)).matches, true);
		const embeddedSource = sourceItem({ history: 1, photos: 1 });
		const embeddedDetail = JSON.parse(String(embeddedSource['DETAIL_TEXT'])) as Record<string, unknown>;
		const embeddedPhoto = `data:image/jpeg;base64,${'a'.repeat(234_112)}`;
		embeddedDetail['photos'] = [{ id: 0, name: 'photo.jpg', url: embeddedPhoto }];
		embeddedSource['DETAIL_TEXT'] = JSON.stringify(embeddedDetail);
		const embedded = plan(embeddedSource, '2026-09-06T08:01:00Z');
		assert.equal((await applyRepairSqlBackfill(sqlPool, embedded, embedded.planHash)).changedRecordCount, 1);
		assert.equal((await readRepairSqlRecords(sqlPool))[0]?.photos[0]?.url, embeddedPhoto);

		const changed = plan(sourceItem({ history: 1, photos: 1, status: 'issued' }), '2026-09-06T08:05:00Z');
		assert.equal((await applyRepairSqlBackfill(sqlPool, changed, changed.planHash)).changedRecordCount, 1);
		assert.equal(compareRepairSqlParity(changed.records, await readRepairSqlRecords(sqlPool)).matches, true);
		const historyRows = await writerPool.query<Array<Record<string, unknown>>>('SELECT ordinal, is_present FROM repair_history WHERE repair_id = 501 ORDER BY ordinal');
		const mediaRows = await writerPool.query<Array<Record<string, unknown>>>('SELECT media_kind, ordinal, is_present FROM repair_media WHERE repair_id = 501 ORDER BY media_kind, ordinal');
		assert.deepEqual(historyRows.map((row) => [Number(row['ordinal']), Number(row['is_present'])]), [[1, 1], [2, 0]]);
		assert.deepEqual(mediaRows.map((row) => [String(row['media_kind']), Number(row['ordinal']), Number(row['is_present'])]), [['file', 1, 1], ['photo', 1, 1], ['photo', 2, 0]]);
		const shadowSource = sourceItem({ history: 1 });
		shadowSource['ID'] = '550';
		const shadowDetail = JSON.parse(String(shadowSource['DETAIL_TEXT'])) as Record<string, unknown>;
		shadowDetail['repairNo'] = 134;
		shadowSource['DETAIL_TEXT'] = JSON.stringify(shadowDetail);
		const shadow = plan(shadowSource, '2026-09-06T08:06:00Z');
		assert.equal((await writeRepairSqlRecord(sqlPool, shadow.records[0]!)).changed, true);
		assert.equal(Number((await writerPool.query<Array<Record<string, unknown>>>('SELECT COUNT(*) AS count FROM repair_identities WHERE public_id = 550 AND repair_no = 134'))[0]?.['count']), 1);

		const nativeInput = JSON.parse(String(sourceItem({ history: 1 })['DETAIL_TEXT'])) as Record<string, unknown>;
		const reserved = await reserveNativeRepairIdentity(sqlPool, {
			idempotencyKey: 'repair:create:integration', request: { kind: 'client', device: 'Камера' },
		});
		assert.equal(reserved.repairNo, 135);
		assert.equal((await reserveNativeRepairIdentity(sqlPool, {
			idempotencyKey: 'repair:create:integration', request: { kind: 'client', device: 'Камера' },
		})).publicId, reserved.publicId);
		await assert.rejects(() => reserveNativeRepairIdentity(sqlPool, {
			idempotencyKey: 'repair:create:integration', request: { kind: 'client', device: 'Другая' },
		}), /another creation/);
		nativeInput['repairNo'] = reserved.repairNo;
		const created = await createNativeRepairSql(sqlPool, {
			...reserved, idempotencyKey: 'repair:create:integration', name: 'SQL ремонт', data: nativeInput,
		});
		assert.equal(created.publicId, reserved.publicId);
		assert.equal((await reserveNativeRepairIdentity(sqlPool, {
			idempotencyKey: 'repair:create:integration', request: { kind: 'client', device: 'Камера' },
		})).alreadyConsumed, true);
		assert.equal((await createNativeRepairSql(sqlPool, {
			...reserved, idempotencyKey: 'repair:create:integration', name: 'SQL ремонт', data: nativeInput,
		})).alreadyApplied, true);
		nativeInput['internalComment'] = 'Обновлено в SQL';
		const updated = await updateNativeRepairSql(sqlPool, {
			publicId: reserved.publicId, idempotencyKey: 'repair:update:integration', name: 'SQL ремонт', data: nativeInput,
		});
		assert.equal(updated.mutationNo, 2);
		const pending = await readPendingRepairBitrixMirrors(sqlPool);
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.mutationId, updated.mutationId);
		const upsertLease = '123e4567-e89b-42d3-a456-426614174000';
		assert.equal(await claimRepairBitrixMirror(sqlPool, {
			publicId: reserved.publicId, mutationId: updated.mutationId, operationKind: 'upsert', leaseToken: upsertLease,
		}), true);
		await markRepairBitrixMirrorDelivered(sqlPool, {
			publicId: reserved.publicId, mutationId: updated.mutationId, bitrixExternalId: 900, leaseToken: upsertLease,
		});
		assert.equal(await readRepairBitrixExternalId(sqlPool, reserved.publicId), 900);
		const deleted = await deleteNativeRepairSql(sqlPool, {
			publicId: reserved.publicId, idempotencyKey: 'repair:delete:integration',
		});
		assert.equal(deleted.mutationNo, 3);
		assert.equal((await deleteNativeRepairSql(sqlPool, {
			publicId: reserved.publicId, idempotencyKey: 'repair:delete:integration',
		})).alreadyApplied, true);
		const deleteLease = '223e4567-e89b-42d3-a456-426614174000';
		assert.equal(await claimRepairBitrixMirror(sqlPool, {
			publicId: reserved.publicId, mutationId: deleted.mutationId, operationKind: 'delete', leaseToken: deleteLease,
		}), true);
		await markRepairBitrixDeleteDelivered(sqlPool, {
			publicId: reserved.publicId, mutationId: deleted.mutationId, leaseToken: deleteLease,
		});

		await assert.rejects(() => writerPool!.query('DELETE FROM repair_records WHERE id = 501'), /(?:denied|command)/i);
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
