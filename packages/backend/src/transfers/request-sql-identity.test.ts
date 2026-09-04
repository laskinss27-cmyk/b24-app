import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyTransferRequestIdentityBackfill,
	buildTransferRequestIdentityBackfillPlan,
	type TransferRequestIdentityRow,
} from './request-sql-identity.js';
import type { TransferSqlConnection, TransferSqlPool } from './sql-store.js';

test('transfer request identity plan preserves every legacy number and rejects conflicts', () => {
	const rows: TransferRequestIdentityRow[] = [
		{ recordId: 2, bitrixExternalId: 17, publicId: null },
		{ recordId: 3, bitrixExternalId: 18, publicId: 18 },
	];
	const plan = buildTransferRequestIdentityBackfillPlan(rows, '2026-09-04T10:00:00Z');
	assert.equal(plan.readyToApply, true);
	assert.equal(plan.assignedRecordCount, 1);
	assert.deepEqual(plan.targets.map((row) => row.publicId), [17, 18]);
	assert.equal(buildTransferRequestIdentityBackfillPlan([
		{ recordId: 2, bitrixExternalId: 17, publicId: 99 },
	], '2026-09-04T10:00:00Z').readyToApply, false);
});

test('transfer request identity apply is atomic and the same checkpoint is a no-op', async () => {
	let publicId: number | null = null;
	let checkpoint = false;
	let commits = 0;
	const connection: TransferSqlConnection = {
		async query<T>(sql: string): Promise<T> {
			if (sql.includes('GET_LOCK')) return [{ acquired: 1 }] as T;
			if (sql.includes('FROM stock_transfer_request_identity_checkpoints')) return (checkpoint ? [{ source_record_count: 1, assigned_record_count: 1 }] : []) as T;
			if (sql.includes('SELECT id, bitrix_external_id, public_id')) return [{ id: 2, bitrix_external_id: 17, public_id: publicId }] as T;
			if (sql.includes('SELECT public_id, legacy_bitrix_external_id')) return [] as T;
			if (sql.includes('UPDATE stock_transfer_request_records')) { publicId = 17; return { affectedRows: 1 } as T; }
			if (sql.includes('INSERT INTO stock_transfer_request_identity_checkpoints')) checkpoint = true;
			return { affectedRows: 1 } as T;
		},
		async batch() {}, async beginTransaction() {}, async commit() { commits += 1; }, async rollback() {}, release() {},
	};
	const pool: TransferSqlPool = { async getConnection() { return connection; }, async query() { return [] as never; } };
	const plan = buildTransferRequestIdentityBackfillPlan([{ recordId: 2, bitrixExternalId: 17, publicId: null }], '2026-09-04T10:00:00Z');
	const first = await applyTransferRequestIdentityBackfill(pool, plan, plan.planHash);
	const second = await applyTransferRequestIdentityBackfill(pool, plan, plan.planHash);
	assert.equal(first.alreadyApplied, false);
	assert.equal(second.alreadyApplied, true);
	assert.equal(publicId, 17);
	assert.equal(commits, 1);
});

test('transfer request identity apply refuses a different approved hash before SQL', async () => {
	const plan = buildTransferRequestIdentityBackfillPlan([], '2026-09-04T10:00:00Z');
	const pool: TransferSqlPool = { async getConnection() { throw new Error('must not connect'); }, async query() { return [] as never; } };
	await assert.rejects(() => applyTransferRequestIdentityBackfill(pool, plan, '0'.repeat(64)), /checkpoint/);
});
