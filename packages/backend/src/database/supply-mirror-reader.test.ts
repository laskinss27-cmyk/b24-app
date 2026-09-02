import assert from 'node:assert/strict';
import test from 'node:test';
import { newTransferData } from '../transfers/model.js';
import { supplyMirrorCanonicalJson, supplyMirrorSourceHash } from './supply-backfill-plan.js';
import { readLatestSupplyMirrorSnapshot, type SupplyMirrorReadPool } from './supply-mirror-reader.js';

const OBSERVED_AT = '2026-08-21 09:03:35.037000';
const HASH = 'a'.repeat(64);

class FakePool implements SupplyMirrorReadPool {
	readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
	checkpointRows: Record<string, unknown>[] = [{
		plan_hash: HASH,
		observed_at: OBSERVED_AT,
		applied_at: '2026-08-21 09:08:45.000000',
		erpnext_records: 2,
		bitrix_transfer_records: 0,
		bitrix_transfer_request_records: 0,
		document_count: 2,
		line_count: 2,
		link_count: 1,
		allocation_count: 1,
		warning_count: 0,
	}];
	transferPayloadRows: Record<string, unknown>[] = [];

	async query<T>(sql: string, values?: unknown[]): Promise<T> {
		this.calls.push({ sql, ...(values ? { values } : {}) });
		if (sql.includes('FROM supply_mirror_checkpoints')) return this.checkpointRows as T;
		if (sql.includes('FROM workflow_documents\n')) return [
			{
				external_system: 'erpnext', document_type: 'purchase_receipt', external_id: 'PR-1',
				external_revision_key: null, external_status: 'completed', external_docstatus: 1,
				bitrix_deal_id: null, source_created_at: '2026-08-21 08:00:00.000000',
				source_modified_at: null, observed_at: OBSERVED_AT, source_hash: 'c'.repeat(64),
			},
			{
				external_system: 'erpnext', document_type: 'purchase_order', external_id: 'PO-1',
				external_revision_key: 'REQ-1', external_status: 'ordered', external_docstatus: 1,
				bitrix_deal_id: 42, source_created_at: null,
				source_modified_at: '2026-08-21 08:30:00.000000', observed_at: OBSERVED_AT, source_hash: 'b'.repeat(64),
			},
		] as T;
		if (sql.includes('FROM supply_transfer_payloads')) return this.transferPayloadRows as T;
		if (sql.includes('FROM workflow_document_lines')) return [
			{
				external_system: 'erpnext', document_type: 'purchase_order', external_id: 'PO-1',
				external_line_key: 'po-line', line_ordinal: 0, erp_item_code: 'SKU-1',
				planned_qty: '2.000000000', request_qty: null, actual_qty: null,
				source_warehouse: null, target_warehouse: 'Stores', source_modified_at: null,
				observed_at: OBSERVED_AT, source_hash: 'd'.repeat(64),
			},
			{
				external_system: 'erpnext', document_type: 'purchase_receipt', external_id: 'PR-1',
				external_line_key: 'pr-line', line_ordinal: 0, erp_item_code: 'SKU-1',
				planned_qty: null, request_qty: null, actual_qty: '2.000000000',
				source_warehouse: null, target_warehouse: 'Stores', source_modified_at: null,
				observed_at: OBSERVED_AT, source_hash: 'e'.repeat(64),
			},
		] as T;
		if (sql.includes('FROM workflow_document_links')) return [{
			from_external_system: 'erpnext', from_document_type: 'purchase_order', from_external_id: 'PO-1',
			to_external_system: 'erpnext', to_document_type: 'purchase_receipt', to_external_id: 'PR-1',
			relation_type: 'received_against_order', evidence_kind: 'native_erp_link', evidence_source: 'purchase_order',
			observed_at: OBSERVED_AT, source_hash: 'f'.repeat(64),
		}] as T;
		if (sql.includes('FROM workflow_line_allocations')) return [{
			source_external_system: 'erpnext', source_document_type: 'purchase_order', source_external_id: 'PO-1',
			source_external_line_key: 'po-line', source_line_ordinal: 0,
			target_external_system: 'erpnext', target_document_type: 'purchase_receipt', target_external_id: 'PR-1',
			target_external_line_key: 'pr-line', target_line_ordinal: 0,
			allocation_type: 'received', quantity: '2.000000000', evidence_kind: 'native_erp_link',
			evidence_source: 'purchase_order', observed_at: OBSERVED_AT, source_hash: '1'.repeat(64),
		}] as T;
		throw new Error(`Unexpected query: ${sql}`);
	}
}

test('read-only mirror reader loads only rows from the latest checkpoint observation', async () => {
	const pool = new FakePool();
	const snapshot = await readLatestSupplyMirrorSnapshot(pool);
	assert.ok(snapshot);
	assert.equal(snapshot.checkpoint.planHash, HASH);
	assert.deepEqual(snapshot.checkpoint.sourceRecords, {
		erpnext: 2,
		bitrixTransfers: 0,
		bitrixTransferRequests: 0,
	});
	assert.deepEqual(snapshot.documents.map((row) => row.identity), [
		'erpnext:purchase_order:PO-1',
		'erpnext:purchase_receipt:PR-1',
	]);
	assert.equal(snapshot.lines[0]?.plannedQty, 2);
	assert.equal(snapshot.links[0]?.identity, 'erpnext:purchase_order:PO-1->erpnext:purchase_receipt:PR-1:received_against_order');
	assert.equal(snapshot.allocations[0]?.identity, 'erpnext:purchase_order:PO-1:key:po-line->erpnext:purchase_receipt:PR-1:key:pr-line:received');
	assert.equal(pool.calls.length, 6);
	for (const call of pool.calls.slice(1)) {
		assert.deepEqual(call.values, call.sql.includes('FROM supply_transfer_payloads') ? [OBSERVED_AT, OBSERVED_AT] : [OBSERVED_AT]);
	}
});

test('read-only mirror reader returns null without querying graph tables when no checkpoint exists', async () => {
	const pool = new FakePool();
	pool.checkpointRows = [];
	assert.equal(await readLatestSupplyMirrorSnapshot(pool), null);
	assert.equal(pool.calls.length, 1);
});

test('read-only mirror reader fails closed for a malformed stored hash', async () => {
	const pool = new FakePool();
	pool.checkpointRows[0]!['plan_hash'] = 'not-a-hash';
	await assert.rejects(() => readLatestSupplyMirrorSnapshot(pool), /Invalid SQL supply mirror hash plan_hash/);
	assert.equal(pool.calls.length, 1);
});

test('read-only mirror reader reconstructs and verifies a complete transfer payload', async () => {
	const pool = new FakePool();
	const data = newTransferData({
		fromStore: 'Склад А',
		toStore: 'Склад Б',
		lines: [{ productId: 100, name: 'Товар', qty: 2 }],
		note: 'Комментарий',
		createdAt: '2026-08-21T08:00:00.000Z',
		createdById: '1858',
		createdByName: 'Владелец',
	});
	pool.transferPayloadRows = [{
		external_id: '7',
		display_name: 'Перемещение #7',
		payload: supplyMirrorCanonicalJson(data),
		observed_at: OBSERVED_AT,
		source_hash: supplyMirrorSourceHash({ name: 'Перемещение #7', data }),
	}];
	const snapshot = await readLatestSupplyMirrorSnapshot(pool);
	assert.deepEqual(snapshot?.transferPayloads[0], {
		identity: 'bitrix:transfer:7',
		documentIdentity: 'bitrix:transfer:7',
		externalId: 7,
		name: 'Перемещение #7',
		data,
		observedAt: OBSERVED_AT,
		sourceHash: supplyMirrorSourceHash({ name: 'Перемещение #7', data }),
	});

	pool.transferPayloadRows[0]!['payload'] = supplyMirrorCanonicalJson({ ...data, note: 'Подмена' });
	await assert.rejects(() => readLatestSupplyMirrorSnapshot(pool), /payload hash mismatch/);
});
