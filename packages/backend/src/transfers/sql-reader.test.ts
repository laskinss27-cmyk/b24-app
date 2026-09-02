import assert from 'node:assert/strict';
import test from 'node:test';
import { newTransferData } from './model.js';
import { readCurrentSqlTransfer } from './sql-reader.js';
import { normalizeTransferSqlState, transferSqlStateHash, type TransferSqlPool } from './sql-store.js';

function fixture() {
	const data = newTransferData({
		fromStore: 'Склад А', toStore: 'Склад Б', lines: [{ productId: 100, name: 'Камера', qty: 2 }],
		createdAt: '2026-09-02T07:00:00.000Z', createdById: '1', createdByName: 'Менеджер',
	});
	data.status = 'accepted';
	data.collectedLines = [{ productId: 100, name: 'Камера', qty: 2 }];
	data.shippedLines = [{ productId: 100, name: 'Камера', qty: 2 }];
	data.acceptedLines = [{ productId: 100, name: 'Камера', qty: 1 }];
	data.correctionIds = [9];
	data.history.push({
		at: '2026-09-02T08:00:00.000Z', status: 'accepted', byId: '2', byName: 'Кладовщик', action: 'accepted', note: 'Недостача',
		changes: [{ productId: 100, name: 'Камера', field: 'accepted', from: 2, to: 1 }],
	});
	return normalizeTransferSqlState({ externalId: 7, name: 'Перемещение #7', data, sourceKind: 'bitrix_backfill' });
}

function poolWithHash(hash: string): TransferSqlPool {
	const binaryHash = Buffer.from(hash, 'hex');
	return {
		async getConnection() { throw new Error('unused'); },
		async query<T = unknown>(sql: string): Promise<T> {
			if (sql.includes('FROM stock_transfer_records tr')) return [{
				bitrix_external_id: 7, display_name: 'Перемещение #7', last_state_hash: binaryHash,
				revision_id: 51, revision_no: 1, state_hash: binaryHash,
				supply_request: '', supply_request_key: '', purchase_order: '', deal_id: '',
				to_store: 'Склад Б', from_store: 'Склад А', status: 'accepted', note: '', task_id: null,
				ship_entry: null, receive_entry: null, shortage_return_entry: null,
				correction_of_external_id: null, correction_kind: null,
				source_created_at: new Date('2026-09-02T07:00:00.000Z'), created_by_id: '1', created_by_name: 'Менеджер',
			}] as T;
			if (sql.includes('FROM stock_transfer_revision_lines')) return [
				{ revision_id: 51, phase: 'planned', line_ordinal: 1, product_id: 100, product_name: 'Камера', quantity: '2.000000000' },
				{ revision_id: 51, phase: 'collected', line_ordinal: 1, product_id: 100, product_name: 'Камера', quantity: '2.000000000' },
				{ revision_id: 51, phase: 'shipped', line_ordinal: 1, product_id: 100, product_name: 'Камера', quantity: '2.000000000' },
				{ revision_id: 51, phase: 'accepted', line_ordinal: 1, product_id: 100, product_name: 'Камера', quantity: '1.000000000' },
			] as T;
			if (sql.includes('FROM stock_transfer_revision_history')) return [
				{ revision_id: 51, event_ordinal: 1, event_at: new Date('2026-09-02T07:00:00.000Z'), status: 'draft', actor_id: '1', actor_name: 'Менеджер', action_name: 'created', note: '' },
				{ revision_id: 51, event_ordinal: 2, event_at: new Date('2026-09-02T08:00:00.000Z'), status: 'accepted', actor_id: '2', actor_name: 'Кладовщик', action_name: 'accepted', note: 'Недостача' },
			] as T;
			if (sql.includes('FROM stock_transfer_history_changes')) return [{
				revision_id: 51, event_ordinal: 2, change_ordinal: 1, product_id: 100, product_name: 'Камера',
				field_name: 'accepted', from_value: '2', to_value: '1',
			}] as T;
			if (sql.includes('FROM stock_transfer_revision_corrections')) return [{ revision_id: 51, correction_ordinal: 1, correction_external_id: 9 }] as T;
			return [] as T;
		},
	};
}

test('SQL transfer reader reconstructs the exact canonical transfer from normalized tables', async () => {
	const expected = fixture();
	const actual = await readCurrentSqlTransfer(poolWithHash(transferSqlStateHash(expected)), 7);
	assert.deepEqual(actual, expected);
});

test('SQL transfer reader fails closed when normalized rows do not match the stored hash', async () => {
	await assert.rejects(() => readCurrentSqlTransfer(poolWithHash('0'.repeat(64)), 7), /reconstruction hash mismatch/);
});
