import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import mariadb, { type Pool } from 'mariadb';
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
	return {
		observedAt,
		sources: {
			erpnext: { complete: true, records: 2 },
			bitrixTransfers: { complete: true, records: 0 },
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
		],
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
	let schemaPool: Pool | undefined;
	let writerPool: Pool | undefined;
	try {
		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${backfillUser}'@'%'`);
		await root.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
		schemaPool = mariadb.createPool({ host, port, user: 'root', password: rootPassword, database, connectionLimit: 1 });
		assert.equal((await applyMigrations(schemaPool, migrationsDirectory)).length, 5);
		assert.deepEqual(await applyMigrations(schemaPool, migrationsDirectory), []);

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
			scalar(schemaPool, 'supply_mirror_checkpoints'),
		]), [2, 2, 1, 1, 1]);
		const initialStored = await readLatestSupplyMirrorSnapshot(writerPool as unknown as SupplyMirrorReadPool);
		assert.equal(compareSupplyMirrorShadow(initialPlan, initialStored).status, 'match');

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

		const invalidPlan = buildSupplyMirrorPlan(snapshot('broken', '2026-08-21T08:10:00.000Z'));
		invalidPlan.lines[0]!.erpItemCode = 'x'.repeat(192);
		await assert.rejects(() => applySupplyMirrorPlan(writerPool as unknown as SupplyMirrorWriterPool, invalidPlan));
		assert.equal(await scalar(schemaPool, 'supply_mirror_checkpoints'), 2);
		const rolledBackStatus = await schemaPool.query<Array<Record<string, unknown>>>(
			"SELECT external_status FROM workflow_documents WHERE document_type = 'purchase_order' AND external_id = 'PO-1'",
		);
		assert.equal(rolledBackStatus[0]?.['external_status'], 'cancelled');

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
	}
});
