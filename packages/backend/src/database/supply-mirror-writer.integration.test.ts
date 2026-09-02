import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import mariadb, { type Pool } from 'mariadb';
import { newTransferData } from '../transfers/model.js';
import { applyMigrations } from './migrations.js';
import { buildSupplyMirrorPlan } from './supply-backfill-plan.js';
import type { SupplyMirrorSnapshot } from './supply-backfill-types.js';
import { readLatestSupplyMirrorSnapshot, type SupplyMirrorReadPool } from './supply-mirror-reader.js';
import { applySupplyMirrorPlan, type SupplyMirrorWriterPool } from './supply-mirror-writer.js';
import { compareSupplyMirrorShadow } from './supply-shadow-compare.js';

const enabled = process.env['B24_WRITER_TEST_MARIADB'] === '1';
const database = 'b24_writer_rehearsal';
const backfillUser = 'b24_writer_rehearsal_user';
const backfillPassword = 'rehearsal-only-password';
const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

function snapshot(status = 'ordered', observedAt = '2026-08-21T08:00:00.000Z'): SupplyMirrorSnapshot {
	const request = { externalSystem: 'erpnext' as const, documentType: 'supply_request' as const, externalId: 'MR-1' };
	const purchase = { externalSystem: 'erpnext' as const, documentType: 'purchase_order' as const, externalId: 'PO-1' };
	const transfer = { externalSystem: 'bitrix' as const, documentType: 'transfer' as const, externalId: '7' };
	const transferData = newTransferData({
		fromStore: 'Incoming',
		toStore: 'Target',
		lines: [{ productId: 100, name: 'Item', qty: 2 }],
		note: 'MariaDB payload rehearsal',
		createdAt: '2026-08-21T07:00:00.000Z',
		createdById: '1858',
		createdByName: 'Owner',
	});
	return {
		observedAt,
		sources: {
			erpnext: { complete: true, records: 2 },
			bitrixTransfers: { complete: true, records: 1 },
			bitrixTransferRequests: { complete: true, records: 0 },
		},
		documents: [
			{
				...request,
				externalRevisionKey: 'MR-1@created',
				externalStatus: 'Pending',
				externalDocstatus: 0,
				bitrixDealId: 42,
				observedAt,
				sourcePayload: { name: 'MR-1', status: 'Pending' },
				lines: [{ externalLineKey: 'MRI-1', lineOrdinal: 1, erpItemCode: '100', requestQty: 2, sourcePayload: { name: 'MRI-1', qty: 2 } }],
			},
			{
				...purchase,
				externalRevisionKey: 'MR-1@created',
				externalStatus: status,
				externalDocstatus: 0,
				bitrixDealId: 42,
				observedAt,
				sourcePayload: { name: 'PO-1', status },
				lines: [{ externalLineKey: 'POI-1', lineOrdinal: 1, erpItemCode: '100', plannedQty: 2, requestQty: 2, sourcePayload: { name: 'POI-1', qty: 2 } }],
			},
			{
				...transfer,
				externalStatus: 'draft',
				externalDocstatus: 0,
				observedAt,
				sourcePayload: { ID: '7', NAME: 'Transfer 7', DETAIL_TEXT: JSON.stringify(transferData) },
				lines: [{ lineOrdinal: 1, erpItemCode: '100', plannedQty: 2, sourceWarehouse: 'Incoming', targetWarehouse: 'Target', sourcePayload: transferData.lines[0] }],
			},
		],
		transferPayloads: [{ document: transfer, externalId: 7, name: 'Transfer 7', data: transferData, observedAt }],
		links: [{
			from: purchase,
			to: request,
			relationType: 'ordered_for_request',
			evidenceKind: 'explicit_external_field',
			evidenceSource: 'b24_supply_request',
			observedAt,
			sourcePayload: { purchase: 'PO-1', request: 'MR-1' },
		}],
		allocations: [{
			source: { document: request, externalLineKey: 'MRI-1', lineOrdinal: 1 },
			target: { document: purchase, externalLineKey: 'POI-1', lineOrdinal: 1 },
			allocationType: 'ordered',
			quantity: 2,
			evidenceKind: 'derived_match',
			evidenceSource: 'item_code+request_qty',
			observedAt,
			sourcePayload: { requestLine: 'MRI-1', purchaseLine: 'POI-1', quantity: 2 },
		}],
	};
}

function snapshotWithReorderedRequestLines(observedAt: string, includeRemovedLine: boolean): SupplyMirrorSnapshot {
	const value = snapshot('ordered', observedAt);
	const request = value.documents[0]!;
	request.lines = [
		{ externalLineKey: 'MRI-1', lineOrdinal: 1, erpItemCode: '100', requestQty: 2, sourcePayload: { name: 'MRI-1', qty: 2 } },
		{ externalLineKey: 'MRI-A', lineOrdinal: 2, erpItemCode: '101', requestQty: 1, sourcePayload: { name: 'MRI-A', qty: 1 } },
		...(includeRemovedLine
			? [{ externalLineKey: 'MRI-B', lineOrdinal: 3, erpItemCode: '102', requestQty: 1, sourcePayload: { name: 'MRI-B', qty: 1 } }]
			: []),
		{ externalLineKey: 'MRI-C', lineOrdinal: includeRemovedLine ? 4 : 3, erpItemCode: '103', requestQty: 1, sourcePayload: { name: 'MRI-C', qty: 1 } },
	];
	return value;
}

async function scalar(pool: Pool, table: string): Promise<number> {
	const rows = await pool.query<Array<Record<string, unknown>>>(`SELECT COUNT(*) AS count FROM ${table}`);
	return Number(rows[0]?.['count']);
}

test('real MariaDB writer is atomic, idempotent and DML-only', { skip: !enabled }, async () => {
	const host = String(process.env['B24_WRITER_TEST_HOST'] ?? '127.0.0.1');
	const port = Number(process.env['B24_WRITER_TEST_PORT']);
	const rootPassword = String(process.env['B24_WRITER_TEST_ROOT_PASSWORD'] ?? '');
	assert.ok(Number.isInteger(port) && port > 0);
	assert.ok(rootPassword);

	const root = mariadb.createPool({ host, port, user: 'root', password: rootPassword, connectionLimit: 1 });
	const rehearsalMigrationsDirectory = await mkdtemp(join(tmpdir(), 'b24-writer-migrations-'));
	let schemaPool: Pool | undefined;
	let writerPool: Pool | undefined;
	try {
		const migrationFilenames = [
			'0001_create_workflow_documents.sql',
			'0002_create_workflow_document_lines.sql',
			'0003_create_workflow_document_links.sql',
			'0004_create_workflow_line_allocations.sql',
			'0005_create_supply_mirror_checkpoints.sql',
			'0006_create_tilda_product_mappings.sql',
			'0007_create_tilda_stock_sync_runs.sql',
			'0022_create_supply_transfer_payloads.sql',
		];
		for (const filename of migrationFilenames) {
			await copyFile(join(migrationsDirectory, filename), join(rehearsalMigrationsDirectory, filename));
		}
		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${backfillUser}'@'%'`);
		await root.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
		schemaPool = mariadb.createPool({ host, port, user: 'root', password: rootPassword, database, connectionLimit: 1 });
		assert.equal((await applyMigrations(schemaPool, rehearsalMigrationsDirectory)).length, 8);
		assert.deepEqual(await applyMigrations(schemaPool, rehearsalMigrationsDirectory), []);

		await root.query(`CREATE USER '${backfillUser}'@'%' IDENTIFIED BY '${backfillPassword}'`);
		await root.query(`GRANT SELECT, INSERT, UPDATE ON ${database}.* TO '${backfillUser}'@'%'`);
		writerPool = mariadb.createPool({ host, port, user: backfillUser, password: backfillPassword, database, connectionLimit: 1 });

		const initialPlan = buildSupplyMirrorPlan(snapshot());
		const first = await applySupplyMirrorPlan(writerPool as unknown as SupplyMirrorWriterPool, initialPlan);
		const repeated = await applySupplyMirrorPlan(writerPool as unknown as SupplyMirrorWriterPool, initialPlan);
		assert.equal(first.alreadyApplied, false);
		assert.equal(repeated.alreadyApplied, true);
		assert.deepEqual(await Promise.all([
			scalar(schemaPool, 'workflow_documents'),
			scalar(schemaPool, 'workflow_document_lines'),
			scalar(schemaPool, 'workflow_document_links'),
			scalar(schemaPool, 'workflow_line_allocations'),
			scalar(schemaPool, 'supply_transfer_payloads'),
			scalar(schemaPool, 'supply_mirror_checkpoints'),
		]), [3, 3, 1, 1, 1, 1]);
		const initialStored = await readLatestSupplyMirrorSnapshot(writerPool as unknown as SupplyMirrorReadPool);
		assert.equal(compareSupplyMirrorShadow(initialPlan, initialStored).status, 'match');
		assert.equal(initialStored?.transferPayloads[0]?.data.note, 'MariaDB payload rehearsal');

		const changedPlan = buildSupplyMirrorPlan(snapshot('cancelled', '2026-08-21T08:05:00.000Z'));
		const changed = await applySupplyMirrorPlan(writerPool as unknown as SupplyMirrorWriterPool, changedPlan);
		assert.equal(changed.alreadyApplied, false);
		const statusRows = await schemaPool.query<Array<Record<string, unknown>>>(
			"SELECT external_status FROM workflow_documents WHERE document_type = 'purchase_order' AND external_id = 'PO-1'",
		);
		assert.equal(statusRows[0]?.['external_status'], 'cancelled');
		assert.equal(await scalar(schemaPool, 'supply_mirror_checkpoints'), 2);
		const changedStored = await readLatestSupplyMirrorSnapshot(writerPool as unknown as SupplyMirrorReadPool);
		assert.equal(compareSupplyMirrorShadow(changedPlan, changedStored).status, 'match');

		const beforeReorderPlan = buildSupplyMirrorPlan(snapshotWithReorderedRequestLines('2026-08-21T08:06:00.000Z', true));
		await applySupplyMirrorPlan(writerPool as unknown as SupplyMirrorWriterPool, beforeReorderPlan);
		const afterReorderPlan = buildSupplyMirrorPlan(snapshotWithReorderedRequestLines('2026-08-21T08:07:00.000Z', false));
		await assert.rejects(
			() => applySupplyMirrorPlan(writerPool as unknown as SupplyMirrorWriterPool, afterReorderPlan),
			/duplicate/i,
		);
		assert.equal(await scalar(schemaPool, 'supply_mirror_checkpoints'), 3);
		const beforeMigrationStored = await readLatestSupplyMirrorSnapshot(writerPool as unknown as SupplyMirrorReadPool);
		assert.equal(compareSupplyMirrorShadow(beforeReorderPlan, beforeMigrationStored).status, 'match');

		const lineIdentityMigration = '0008_make_line_ordinal_identity_conditional.sql';
		await copyFile(join(migrationsDirectory, lineIdentityMigration), join(rehearsalMigrationsDirectory, lineIdentityMigration));
		assert.equal((await applyMigrations(schemaPool, rehearsalMigrationsDirectory)).length, 1);
		assert.deepEqual(await applyMigrations(schemaPool, rehearsalMigrationsDirectory), []);
		await applySupplyMirrorPlan(writerPool as unknown as SupplyMirrorWriterPool, afterReorderPlan);
		const reorderedStored = await readLatestSupplyMirrorSnapshot(writerPool as unknown as SupplyMirrorReadPool);
		assert.equal(compareSupplyMirrorShadow(afterReorderPlan, reorderedStored).status, 'match');
		const reorderedRows = await schemaPool.query<Array<Record<string, unknown>>>(`
			SELECT external_line_key, line_ordinal, identity_line_ordinal
			FROM workflow_document_lines l
			JOIN workflow_documents d ON d.id = l.document_id
			WHERE d.document_type = 'supply_request' AND d.external_id = 'MR-1'
			ORDER BY external_line_key
		`);
		assert.deepEqual(reorderedRows.map((row) => [row['external_line_key'], row['line_ordinal'], row['identity_line_ordinal']]), [
			['MRI-1', 1, null],
			['MRI-A', 2, null],
			['MRI-B', 3, null],
			['MRI-C', 3, null],
		]);

		const requestIdRows = await schemaPool.query<Array<Record<string, unknown>>>(
			"SELECT id FROM workflow_documents WHERE document_type = 'supply_request' AND external_id = 'MR-1'",
		);
		const requestId = requestIdRows[0]?.['id'];
		await schemaPool.query(`
			INSERT INTO workflow_document_lines (
				document_id, external_line_key, line_ordinal, erp_item_code, request_qty, observed_at, source_hash
			) VALUES (?, NULL, 20, 'fallback-a', 1, '2026-08-21 08:07:00.000000', UNHEX(REPEAT('11', 32)))
		`, [requestId]);
		await assert.rejects(() => schemaPool!.query(`
			INSERT INTO workflow_document_lines (
				document_id, external_line_key, line_ordinal, erp_item_code, request_qty, observed_at, source_hash
			) VALUES (?, NULL, 20, 'fallback-b', 1, '2026-08-21 08:07:00.000000', UNHEX(REPEAT('22', 32)))
		`, [requestId]), /duplicate/i);

		const invalidPlan = buildSupplyMirrorPlan(snapshot('broken', '2026-08-21T08:10:00.000Z'));
		invalidPlan.lines[0]!.erpItemCode = 'x'.repeat(192);
		await assert.rejects(() => applySupplyMirrorPlan(writerPool as unknown as SupplyMirrorWriterPool, invalidPlan));
		assert.equal(await scalar(schemaPool, 'supply_mirror_checkpoints'), 4);
		const rolledBackStatus = await schemaPool.query<Array<Record<string, unknown>>>(
			"SELECT external_status FROM workflow_documents WHERE document_type = 'purchase_order' AND external_id = 'PO-1'",
		);
		assert.equal(rolledBackStatus[0]?.['external_status'], 'ordered');

		await assert.rejects(
			() => writerPool!.query('DELETE FROM workflow_documents WHERE id = -1'),
			/(?:denied|command)/i,
		);
		await assert.rejects(
			() => writerPool!.query('CREATE TABLE forbidden_ddl (id INT NOT NULL)'),
			/(?:denied|command)/i,
		);
	} finally {
		if (writerPool) await writerPool.end();
		if (schemaPool) await schemaPool.end();
		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${backfillUser}'@'%'`);
		await root.end();
		await rm(rehearsalMigrationsDirectory, { recursive: true, force: true });
	}
});
