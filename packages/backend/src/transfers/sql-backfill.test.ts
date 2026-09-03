import assert from 'node:assert/strict';
import test from 'node:test';
import { newTransferData, type StoredTransfer } from './model.js';
import { applyTransferSqlBackfill, buildTransferSqlBackfillPlan } from './sql-backfill.js';
import type { TransferSqlConnection, TransferSqlPool } from './sql-store.js';

function transfer(id = 7): StoredTransfer {
	return {
		id,
		name: `Перемещение #${id}`,
		...newTransferData({
			fromStore: 'А', toStore: 'Б', lines: [{ productId: 100, name: 'Товар', qty: 1 }],
			createdAt: '2026-09-02T07:00:00.000Z', createdById: '1', createdByName: 'Менеджер',
		}),
	};
}

class BackfillConnection implements TransferSqlConnection {
	readonly queries: string[] = [];
	checkpointExists = false;
	failRevision = false;
	commitCount = 0;
	rollbackCount = 0;
	releaseCount = 0;

	async query<T = unknown>(sql: string): Promise<T> {
		this.queries.push(sql);
		if (sql.includes('GET_LOCK')) return [{ acquired: 1 }] as T;
		if (sql.includes('FROM stock_transfer_backfill_checkpoints')) {
			return (this.checkpointExists ? [{ created_revision_count: 1, unchanged_record_count: 0 }] : []) as T;
		}
		if (sql.includes('SELECT public_id, legacy_bitrix_external_id')) return [{ public_id: 7, legacy_bitrix_external_id: 7 }] as T;
		if (sql.includes('SELECT id, public_id, last_state_hash')) return [{ id: 41, public_id: 7, last_state_hash: null }] as T;
		if (sql.includes('SELECT id, revision_no')) return [] as T;
		if (sql.includes('INSERT INTO stock_transfer_revisions')) {
			if (this.failRevision) throw new Error('revision failed');
			return { insertId: 51 } as T;
		}
		if (sql.includes('UPDATE stock_transfer_records')) return { affectedRows: 1 } as T;
		if (sql.includes('INSERT INTO stock_transfer_backfill_checkpoints')) this.checkpointExists = true;
		if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }] as T;
		return {} as T;
	}

	async batch(): Promise<unknown> { return {}; }
	async beginTransaction(): Promise<void> {}
	async commit(): Promise<void> { this.commitCount += 1; }
	async rollback(): Promise<void> { this.rollbackCount += 1; }
	release(): void { this.releaseCount += 1; }
}

function pool(connection: BackfillConnection): TransferSqlPool {
	return { async getConnection() { return connection; }, async query<T = unknown>() { return [] as T; } };
}

test('transfer backfill plan is deterministic and refuses incomplete sources', () => {
	const complete = buildTransferSqlBackfillPlan({
		observedAt: '2026-09-02T09:00:00.000Z', sourceComplete: true, sourceRecordCount: 2,
		transfers: [transfer(8), transfer(7)],
	});
	const reordered = buildTransferSqlBackfillPlan({
		observedAt: '2026-09-02T10:00:00.000Z', sourceComplete: true, sourceRecordCount: 2,
		transfers: [transfer(7), transfer(8)],
	});
	assert.equal(complete.readyToApply, true);
	assert.equal(complete.planHash, reordered.planHash);
	assert.deepEqual(complete.transfers.map((item) => item.id), [7, 8]);
	const incomplete = buildTransferSqlBackfillPlan({
		observedAt: '2026-09-02T09:00:00.000Z', sourceComplete: false, sourceRecordCount: 1, transfers: [transfer()],
	});
	assert.equal(incomplete.readyToApply, false);
	assert.equal(incomplete.issues[0]?.code, 'incomplete_source');
});

test('transfer backfill is checkpointed and applied in one transaction', async () => {
	const plan = buildTransferSqlBackfillPlan({
		observedAt: '2026-09-02T09:00:00.000Z', sourceComplete: true, sourceRecordCount: 1, transfers: [transfer()],
	});
	const connection = new BackfillConnection();
	const first = await applyTransferSqlBackfill(pool(connection), plan, plan.planHash);
	assert.deepEqual(first, {
		planHash: plan.planHash, alreadyApplied: false, sourceRecordCount: 1, createdRevisionCount: 1, unchangedRecordCount: 0,
	});
	const second = await applyTransferSqlBackfill(pool(connection), plan, plan.planHash);
	assert.equal(second.alreadyApplied, true);
	assert.equal(connection.commitCount, 1);
	assert.equal(connection.rollbackCount, 1);
	assert.equal(connection.releaseCount, 2);
	assert.ok(connection.queries.every((sql) => !/\bDELETE\b/i.test(sql)));
});

test('transfer backfill fails closed before SQL and rolls back row failures', async () => {
	const plan = buildTransferSqlBackfillPlan({
		observedAt: '2026-09-02T09:00:00.000Z', sourceComplete: true, sourceRecordCount: 1, transfers: [transfer()],
	});
	let opened = 0;
	const unopened: TransferSqlPool = {
		async getConnection() { opened += 1; return new BackfillConnection(); }, async query<T = unknown>() { return [] as T; },
	};
	await assert.rejects(() => applyTransferSqlBackfill(unopened, plan, '0'.repeat(64)), /approved plan/);
	assert.equal(opened, 0);
	const connection = new BackfillConnection();
	connection.failRevision = true;
	await assert.rejects(() => applyTransferSqlBackfill(pool(connection), plan, plan.planHash), /revision failed/);
	assert.equal(connection.commitCount, 0);
	assert.equal(connection.rollbackCount, 1);
	assert.equal(connection.checkpointExists, false);
});
