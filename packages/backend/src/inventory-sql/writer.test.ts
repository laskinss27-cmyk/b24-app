import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransferSqlConnection, TransferSqlPool } from '../transfers/sql-store.js';
import { buildInventorySqlBackfillPlan } from './backfill-plan.js';
import { applyInventorySqlBackfill, assertFrozenInventorySnapshot, markInventorySqlDeleted, writeInventorySqlRecord } from './writer.js';

function sourceItem(): Record<string, unknown> {
	return {
		ID: '42', NAME: 'Активная ревизия', DATE_CREATE: '2026-09-04T08:00:00Z', CREATED_BY: '1',
		DETAIL_TEXT: JSON.stringify({
			status: 'active', createdAt: '2026-09-04T08:00:00Z', stockSnapshotAt: '2026-09-04T08:00:00Z', sectionIds: [7],
			points: [{
				storeId: -100, storeName: 'Склад', status: 'in_progress', responsibleId: '2', responsibleName: 'Менеджер',
				stockSnapshot: { version: 1, capturedAt: '2026-09-04T08:00:00Z', lines: [[10, 3], [11, 4]] },
				draft: { 10: 2 }, comments: { 11: 'пока не считал' }, draftSessionId: 's1', draftSequence: 2,
			}],
		}),
	};
}

class RecordingConnection implements TransferSqlConnection {
	queries: string[] = [];
	batches: Array<{ sql: string; rows: unknown[][] }> = [];
	began = false;
	committed = false;
	rolledBack = false;
	released = false;
	recordSelectCount = 0;
	pointSelectCount = 0;

	async query<T = unknown>(sql: string): Promise<T> {
		const compact = sql.replace(/\s+/g, ' ').trim();
		this.queries.push(compact);
		if (compact.startsWith('SELECT GET_LOCK')) return [{ acquired: 1 }] as T;
		if (compact.startsWith('SELECT changed_inventory_count')) return [] as T;
		if (compact.startsWith('SELECT public_id, legacy_bitrix_external_id')) return [{ public_id: 42, legacy_bitrix_external_id: 42 }] as T;
		if (compact.startsWith('SELECT id, public_id, bitrix_external_id, last_state_hash')) {
			this.recordSelectCount += 1;
			return (this.recordSelectCount === 1 ? [] : [{ id: 100, last_state_hash: null, stock_snapshot_at: null }]) as T;
		}
		if (compact.startsWith('SELECT id, snapshot_version')) {
			this.pointSelectCount += 1;
			return (this.pointSelectCount === 1 ? [] : [{ id: 200, snapshot_version: 1, snapshot_captured_at: '2026-09-04 08:00:00.000000' }]) as T;
		}
		if (compact.startsWith('SELECT product_id, book_qty')) return [] as T;
		if (compact.startsWith('UPDATE inventory_records SET last_state_hash')) return { affectedRows: 1 } as T;
		if (compact.startsWith('SELECT RELEASE_LOCK')) return [{ released: 1 }] as T;
		return { affectedRows: 1 } as T;
	}

	async batch(sql: string, rows: unknown[][]): Promise<unknown> {
		this.batches.push({ sql: sql.replace(/\s+/g, ' ').trim(), rows });
		return { affectedRows: rows.length };
	}

	async beginTransaction(): Promise<void> { this.began = true; }
	async commit(): Promise<void> { this.committed = true; }
	async rollback(): Promise<void> { this.rolledBack = true; }
	release(): void { this.released = true; }
}

test('inventory backfill writes one atomic normalized snapshot without DELETE statements', async () => {
	const plan = buildInventorySqlBackfillPlan({
		observedAt: '2026-09-04T10:00:00Z', sourceComplete: true, sourceRecordCount: 1, items: [sourceItem()],
	});
	assert.equal(plan.readyToApply, true);
	const connection = new RecordingConnection();
	const pool: TransferSqlPool = { getConnection: async () => connection, query: async <T>() => [] as T };
	const result = await applyInventorySqlBackfill(pool, plan, plan.planHash);
	assert.deepEqual(result, { alreadyApplied: false, changedInventoryCount: 1, unchangedInventoryCount: 0 });
	assert.equal(connection.began, true);
	assert.equal(connection.committed, true);
	assert.equal(connection.rolledBack, false);
	assert.equal(connection.released, true);
	assert.equal(connection.queries.some((sql) => /\bDELETE\b/i.test(sql)), false);
	assert.ok(connection.queries.some((sql) => sql.startsWith('UPDATE inventory_count_lines line')));
	assert.ok(connection.queries.some((sql) => sql.startsWith('INSERT INTO inventory_backfill_checkpoints')));
	assert.deepEqual(connection.batches.map((entry) => entry.rows.length), [1, 2, 2]);
});

test('inventory shadow writes one record atomically without creating a backfill checkpoint', async () => {
	const plan = buildInventorySqlBackfillPlan({
		observedAt: '2026-09-04T10:00:00Z', sourceComplete: true, sourceRecordCount: 1, items: [sourceItem()],
	});
	const connection = new RecordingConnection();
	const pool: TransferSqlPool = { getConnection: async () => connection, query: async <T>() => [] as T };
	assert.deepEqual(await writeInventorySqlRecord(pool, plan.inventories[0]!), { changed: true });
	assert.equal(connection.committed, true);
	assert.equal(connection.queries.some((sql) => sql.includes('inventory_backfill_checkpoints')), false);
	assert.equal(connection.queries.some((sql) => /\bDELETE\b/i.test(sql)), false);
});

test('inventory shadow deletion is a soft tombstone in one transaction', async () => {
	class DeleteConnection extends RecordingConnection {
		override async query<T = unknown>(sql: string): Promise<T> {
			const compact = sql.replace(/\s+/g, ' ').trim();
			this.queries.push(compact);
			if (compact.startsWith('SELECT GET_LOCK')) return [{ acquired: 1 }] as T;
			if (compact.startsWith('SELECT id, deleted_at')) return [{ id: 100, deleted_at: null }] as T;
			if (compact.startsWith('UPDATE inventory_records SET deleted_at')) return { affectedRows: 1 } as T;
			if (compact.startsWith('SELECT RELEASE_LOCK')) return [{ released: 1 }] as T;
			return { affectedRows: 1 } as T;
		}
	}
	const connection = new DeleteConnection();
	const pool: TransferSqlPool = { getConnection: async () => connection, query: async <T>() => [] as T };
	assert.deepEqual(await markInventorySqlDeleted(pool, { externalId: 42, deletedAt: new Date('2026-09-05T08:00:00Z') }), { alreadyDeleted: false });
	assert.equal(connection.committed, true);
	assert.ok(connection.queries.some((sql) => sql.startsWith('UPDATE inventory_records SET deleted_at')));
	assert.equal(connection.queries.some((sql) => /^DELETE\b/i.test(sql)), false);
});

test('frozen inventory snapshots can repeat exactly but can never drift', () => {
	const source = [{ productId: 10, bookQty: 3 }, { productId: 11, bookQty: 4 }];
	assert.doesNotThrow(() => assertFrozenInventorySnapshot([...source].reverse(), source));
	assert.throws(() => assertFrozenInventorySnapshot([{ productId: 10, bookQty: 2 }, { productId: 11, bookQty: 4 }], source), /Frozen inventory snapshot changed/);
	assert.throws(() => assertFrozenInventorySnapshot([{ productId: 10, bookQty: 3 }], source), /Frozen inventory snapshot changed/);
});

test('blocked inventory plans cannot reach SQL', async () => {
	const plan = buildInventorySqlBackfillPlan({
		observedAt: '2026-09-04T10:00:00Z', sourceComplete: false, sourceRecordCount: 1, items: [sourceItem()],
	});
	const connection = new RecordingConnection();
	const pool: TransferSqlPool = { getConnection: async () => connection, query: async <T>() => [] as T };
	await assert.rejects(() => applyInventorySqlBackfill(pool, plan, plan.planHash), /blocked/);
	assert.equal(connection.queries.length, 0);
});
