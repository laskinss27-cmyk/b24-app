import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransferSqlPool } from '../transfers/sql-store.js';
import { inventorySqlStateHash, type InventorySqlRecordState } from './model.js';
import { readInventorySqlRecords } from './reader.js';

function fixtureState(): InventorySqlRecordState {
	return {
		bitrixExternalId: 42,
		displayName: 'Активная ревизия',
		status: 'active',
		deadline: '2026-09-05',
		createdById: '1',
		sourceCreatedAt: '2026-09-04T08:00:00.000Z',
		stockSnapshotAt: '2026-09-04T08:00:00.000Z',
		sectionIds: [7],
		points: [{
			ordinal: 1, storeId: -100, storeName: 'Склад', status: 'in_progress', responsibleId: '2', responsibleName: 'Менеджер',
			startedAt: null, submittedAt: null, actAt: null, snapshotVersion: 1, snapshotCapturedAt: '2026-09-04T08:00:00.000Z', snapshotMigratedAt: null,
			draftUpdatedAt: null, draftUpdatedById: '', draftUpdatedByName: '', draftSessionId: 's1', draftSequence: 2,
			resultTotal: null, resultCounted: null, resultDiscrepancies: null,
			resultBookAt: null,
			snapshotLines: [{ productId: 10, bookQty: 3 }],
			countLines: [{ productId: 11, factQty: null, comment: 'пока не считал' }],
			resultLines: [], erpDocuments: [],
		}],
	};
}

test('SQL reader reconstructs an active inventory and verifies its deterministic state hash', async () => {
	const state = fixtureState();
	let call = 0;
	const rows: Array<Array<Record<string, unknown>>> = [
		[{ id: 100, public_id: 42, bitrix_external_id: 42, display_name: state.displayName, inventory_status: 'active', deadline: '2026-09-05', created_by_id: '1', source_created_at: new Date(state.sourceCreatedAt!), stock_snapshot_at: new Date(state.stockSnapshotAt!), last_state_hash: Buffer.from(inventorySqlStateHash(state), 'hex') }],
		[{ inventory_id: 100, section_id: 7, section_ordinal: 1 }],
		[{ id: 200, inventory_id: 100, point_ordinal: 1, store_id: -100, store_name: 'Склад', point_status: 'in_progress', responsible_id: '2', responsible_name: 'Менеджер', started_at: null, submitted_at: null, act_at: null, snapshot_version: 1, snapshot_captured_at: new Date('2026-09-04T08:00:00Z'), snapshot_migrated_at: null, draft_updated_at: null, draft_updated_by_id: '', draft_updated_by_name: '', draft_session_id: 's1', draft_sequence: 2, result_total: null, result_counted: null, result_discrepancies: null, result_book_at: null }],
		[{ point_id: 200, product_id: 10, book_qty: '3.000000000' }],
		[{ point_id: 200, product_id: 11, fact_qty: null, line_comment: 'пока не считал' }],
		[],
		[],
	];
	const pool = { query: async () => rows[call++]!, getConnection: async () => { throw new Error('not used'); } } as unknown as TransferSqlPool;
	const loaded = await readInventorySqlRecords(pool);
	assert.equal(call, 7);
	assert.deepEqual(loaded, [{ ...state, stateHash: inventorySqlStateHash(state) }]);
});

test('SQL reader fails closed when normalized rows do not match the stored state hash', async () => {
	const state = fixtureState();
	let call = 0;
	const rows: Array<Array<Record<string, unknown>>> = [
		[{ id: 100, public_id: 42, bitrix_external_id: 42, display_name: state.displayName, inventory_status: 'active', deadline: '2026-09-05', created_by_id: '1', source_created_at: new Date(state.sourceCreatedAt!), stock_snapshot_at: new Date(state.stockSnapshotAt!), last_state_hash: Buffer.alloc(32) }],
		[{ inventory_id: 100, section_id: 7, section_ordinal: 1 }],
		[{ id: 200, inventory_id: 100, point_ordinal: 1, store_id: -100, store_name: 'Склад', point_status: 'in_progress', responsible_id: '2', responsible_name: 'Менеджер', started_at: null, submitted_at: null, act_at: null, snapshot_version: 1, snapshot_captured_at: new Date('2026-09-04T08:00:00Z'), snapshot_migrated_at: null, draft_updated_at: null, draft_updated_by_id: '', draft_updated_by_name: '', draft_session_id: 's1', draft_sequence: 2, result_total: null, result_counted: null, result_discrepancies: null, result_book_at: null }],
		[{ point_id: 200, product_id: 10, book_qty: 3 }],
		[{ point_id: 200, product_id: 11, fact_qty: null, line_comment: 'пока не считал' }], [], [],
	];
	const pool = { query: async () => rows[call++]!, getConnection: async () => { throw new Error('not used'); } } as unknown as TransferSqlPool;
	await assert.rejects(() => readInventorySqlRecords(pool), /state hash mismatch/);
});
