import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyTransferIdentityBackfill,
	buildTransferIdentityBackfillPlan,
	type TransferIdentityRow,
} from './sql-identity.js';
import type { TransferSqlConnection, TransferSqlPool } from './sql-store.js';

test('identity plan preserves every legacy document number and is stable after assignment', () => {
	const before: TransferIdentityRow[] = [
		{ recordId: 2, bitrixExternalId: 420, publicId: null },
		{ recordId: 1, bitrixExternalId: 311, publicId: null },
	];
	const after = before.map((row) => ({ ...row, publicId: row.bitrixExternalId }));
	const first = buildTransferIdentityBackfillPlan(before, '2026-09-03T08:00:00Z');
	const repeated = buildTransferIdentityBackfillPlan(after, '2026-09-04T08:00:00Z');
	assert.equal(first.readyToApply, true);
	assert.equal(first.assignedRecordCount, 2);
	assert.deepEqual(first.targets.map((target) => target.publicId), [311, 420]);
	assert.equal(repeated.assignedRecordCount, 0);
	assert.equal(repeated.planHash, first.planHash);
});

test('identity plan fails closed when an existing public number differs from Bitrix', () => {
	const plan = buildTransferIdentityBackfillPlan([
		{ recordId: 1, bitrixExternalId: 311, publicId: 999 },
	], '2026-09-03T08:00:00Z');
	assert.equal(plan.readyToApply, false);
	assert.deepEqual(plan.issues.map((issue) => issue.code), ['public_id_conflict']);
});

class IdentityConnection implements TransferSqlConnection {
	readonly records: TransferIdentityRow[];
	readonly allocator = new Map<number, number | null>();
	checkpoint: { hash: string; sourceRecordCount: number; assignedRecordCount: number } | null = null;
	commits = 0;
	rollbacks = 0;

	constructor(records: TransferIdentityRow[]) { this.records = records.map((row) => ({ ...row })); }

	async query<T = unknown>(sql: string, values: unknown[] = []): Promise<T> {
		if (sql.includes('GET_LOCK')) return [{ acquired: 1 }] as T;
		if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }] as T;
		if (sql.includes('FROM stock_transfer_identity_checkpoints')) {
			if (!this.checkpoint) return [] as T;
			const requested = Buffer.isBuffer(values[0]) ? values[0].toString('hex') : '';
			return (requested === this.checkpoint.hash ? [{
				source_record_count: this.checkpoint.sourceRecordCount,
				assigned_record_count: this.checkpoint.assignedRecordCount,
			}] : []) as T;
		}
		if (sql.includes('FROM stock_transfer_records')) return this.records.map((row) => ({
			id: row.recordId,
			bitrix_external_id: row.bitrixExternalId,
			public_id: row.publicId,
		})) as T;
		if (sql.includes('FROM stock_transfer_public_ids')) return [...this.allocator].map(([publicId, legacyId]) => ({
			public_id: publicId,
			legacy_bitrix_external_id: legacyId,
		})) as T;
		if (sql.startsWith('INSERT INTO stock_transfer_public_ids')) {
			this.allocator.set(Number(values[0]), Number(values[1]));
			return { affectedRows: 1 } as T;
		}
		if (sql.startsWith('UPDATE stock_transfer_records')) {
			const row = this.records.find((candidate) => candidate.recordId === Number(values[1]));
			if (!row || row.publicId != null) return { affectedRows: 0 } as T;
			row.publicId = Number(values[0]);
			return { affectedRows: 1 } as T;
		}
		if (sql.includes('INSERT INTO stock_transfer_identity_checkpoints')) {
			this.checkpoint = {
				hash: (values[0] as Buffer).toString('hex'),
				sourceRecordCount: Number(values[2]),
				assignedRecordCount: Number(values[3]),
			};
			return { affectedRows: 1 } as T;
		}
		throw new Error(`Unexpected SQL: ${sql}`);
	}

	async batch(): Promise<unknown> { return undefined; }
	async beginTransaction(): Promise<void> {}
	async commit(): Promise<void> { this.commits += 1; }
	async rollback(): Promise<void> { this.rollbacks += 1; }
	async release(): Promise<void> {}
}

function pool(connection: IdentityConnection): TransferSqlPool {
	return {
		async getConnection() { return connection; },
		async query() { throw new Error('pool query is not expected'); },
	};
}

test('identity apply assigns legacy ids atomically and the same checkpoint is a no-op', async () => {
	const connection = new IdentityConnection([
		{ recordId: 1, bitrixExternalId: 311, publicId: null },
		{ recordId: 2, bitrixExternalId: 420, publicId: null },
	]);
	const plan = buildTransferIdentityBackfillPlan(connection.records, '2026-09-03T08:00:00Z');
	const applied = await applyTransferIdentityBackfill(pool(connection), plan, plan.planHash);
	assert.deepEqual(applied, {
		planHash: plan.planHash,
		alreadyApplied: false,
		sourceRecordCount: 2,
		assignedRecordCount: 2,
	});
	assert.deepEqual(connection.records.map((row) => row.publicId), [311, 420]);
	assert.deepEqual([...connection.allocator.keys()], [311, 420]);
	assert.equal(connection.commits, 1);

	const repeated = await applyTransferIdentityBackfill(pool(connection), plan, plan.planHash);
	assert.equal(repeated.alreadyApplied, true);
	assert.equal(connection.rollbacks, 1);
	assert.equal(connection.commits, 1);
});

test('identity apply refuses an unapproved plan hash before opening SQL', async () => {
	const plan = buildTransferIdentityBackfillPlan([], '2026-09-03T08:00:00Z');
	await assert.rejects(
		() => applyTransferIdentityBackfill({} as TransferSqlPool, plan, '0'.repeat(64)),
		/does not match the approved plan/,
	);
});
