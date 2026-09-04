import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredTransferRequest } from './request-model.js';
import { compareTransferRequestSqlParity } from './request-sql-compare.js';
import { buildTransferRequestBackfillPlan } from './request-sql-backfill.js';
import { readCurrentSqlTransferRequests } from './request-sql-reader.js';
import { normalizeTransferRequestSqlState, transferRequestSqlStateHash, writeTransferRequestSqlRevision } from './request-sql-store.js';
import type { TransferSqlConnection, TransferSqlPool } from './sql-store.js';

function request(overrides: Partial<StoredTransferRequest> = {}): StoredTransferRequest {
	return {
		id: 17, name: 'Заказ на перемещение #17', kind: 'transfer',
		fromStore: 'Склад 1', toStore: 'Склад 2',
		lines: [{ productId: 11962, name: 'Монтажная коробка', qty: 2 }], supplyLines: [],
		note: 'Проверка', status: 'pending', createdAt: '2026-09-04T08:00:00.000Z',
		createdById: '1858', createdByName: 'Владелец', convertedAt: '', convertedById: '', convertedByName: '',
		transferId: null, taskId: 900, canceledAt: '', canceledById: '', canceledByName: '', ...overrides,
	};
}

test('transfer request state is canonical and parity detects changes', () => {
	const value = request();
	const { id, name, ...data } = value;
	assert.deepEqual(normalizeTransferRequestSqlState({ externalId: id, name, data, sourceKind: 'repair' }), value);
	assert.match(transferRequestSqlStateHash(value), /^[a-f0-9]{64}$/);
	assert.equal(compareTransferRequestSqlParity([value], [value]).matches, true);
	assert.deepEqual(compareTransferRequestSqlParity([value], [request({ note: 'Другое' })]).differences, [{ kind: 'state_mismatch', externalId: 17 }]);
});

test('transfer request backfill plan is deterministic and fail-closed', () => {
	const value = request();
	const first = buildTransferRequestBackfillPlan({ observedAt: '2026-09-04T08:00:00Z', sourceComplete: true, sourceRecordCount: 1, requests: [value] });
	const second = buildTransferRequestBackfillPlan({ observedAt: '2026-09-04T09:00:00Z', sourceComplete: true, sourceRecordCount: 1, requests: [value] });
	assert.equal(first.readyToApply, true);
	assert.equal(first.planHash, second.planHash);
	assert.equal(buildTransferRequestBackfillPlan({ observedAt: '2026-09-04T08:00:00Z', sourceComplete: false, sourceRecordCount: 1, requests: [value] }).readyToApply, false);
});

test('transfer request writer stores one append-only revision and normalized lines', async () => {
	const batches: unknown[][][] = [];
	const connection: TransferSqlConnection = {
		async query<T>(sql: string): Promise<T> {
			if (sql.includes('SELECT id, last_state_hash')) return [{ id: 8, last_state_hash: null }] as T;
			if (sql.includes('SELECT id, revision_no, state_hash')) return [] as T;
			if (sql.includes('INSERT INTO stock_transfer_request_revisions')) return { insertId: 13 } as T;
			if (sql.includes('UPDATE stock_transfer_request_records')) return { affectedRows: 1 } as T;
			return { affectedRows: 1 } as T;
		},
		async batch(_sql, rows) { batches.push(rows); }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
	};
	const pool: TransferSqlPool = { async getConnection() { return connection; }, async query() { return [] as never; } };
	const value = request();
	const { id, name, ...data } = value;
	const result = await writeTransferRequestSqlRevision(pool, { externalId: id, name, data, sourceKind: 'bitrix_dual_write' });
	assert.equal(result.revisionNo, 1);
	assert.equal(result.alreadyCurrent, false);
	assert.deepEqual(batches[0], [[13, 'transfer', 1, 11962, 'Монтажная коробка', 2, '', '']]);
});

test('SQL reader reconstructs the canonical request and verifies its hash', async () => {
	const value = request();
	const stateHash = Buffer.from(transferRequestSqlStateHash(value), 'hex');
	const pool: TransferSqlPool = {
		async getConnection() { throw new Error('not used'); },
		async query<T>(sql: string): Promise<T> {
			if (sql.includes('FROM stock_transfer_request_records')) return [{
				bitrix_external_id: 17, display_name: value.name, last_state_hash: stateHash, revision_id: 13, state_hash: stateHash,
				request_kind: value.kind, request_status: value.status, from_store: value.fromStore, to_store: value.toStore,
				note: value.note, source_created_at: new Date(value.createdAt), created_by_id: value.createdById, created_by_name: value.createdByName,
				converted_at: null, converted_by_id: '', converted_by_name: '', transfer_public_id: null, task_id: 900,
				canceled_at: null, canceled_by_id: '', canceled_by_name: '',
			}] as T;
			return [{ revision_id: 13, line_kind: 'transfer', line_ordinal: 1, product_id: 11962, product_name: 'Монтажная коробка', quantity: 2, product_link: '', line_note: '' }] as T;
		},
	};
	assert.deepEqual(await readCurrentSqlTransferRequests(pool), [value]);
});
