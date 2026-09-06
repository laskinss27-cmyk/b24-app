import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRepairSqlBackfillPlan } from './backfill-plan.js';
import { readRepairSqlRecords } from './reader.js';
import type { TransferSqlPool } from '../transfers/sql-store.js';

const detail = {
	kind: 'presale', status: 'pre_office', repairNo: 133,
	client: { contactId: null, name: '', phone: '' }, device: 'Монитор', model: '', serial: '', point: '',
	appearance: '', defect: 'экран', payType: 'warranty', cost: null, ourPrice: null, dealId: null, taskId: 9,
	clientRefusal: null, repairItemCode: null, repairStore: 'Офис', issueStore: null, repairDeliveryNote: null,
	productId: 42, sourceStore: 'Дунайский', comment: '', internalComment: '', photos: [],
	files: [{ id: 7, name: 'акт', url: 'https://example.test/a', type: 'pdf' }],
	createdAt: '2026-09-01T10:00:00.000Z', createdById: '1', createdByName: 'Owner',
	history: [{ at: '2026-09-01T10:00:00.000Z', status: 'pre_office', byId: '1' }],
};
const source = buildRepairSqlBackfillPlan({
	observedAt: '2026-09-06T08:00:00Z', sourceComplete: true, sourceRecordCount: 1,
	items: [{ ID: '33', NAME: 'Монитор', DETAIL_TEXT: JSON.stringify(detail) }],
}).records[0]!;

test('repair SQL reader reconstructs normalized records and verifies state hash', async () => {
	let call = 0;
	const pool = {
		async query() {
			call += 1;
			if (call === 1) return [{
				id: 33, bitrix_external_id: 33, display_name: 'Монитор', repair_kind: 'presale', repair_status: 'pre_office', repair_no: 133,
				client_contact_id: null, client_name: '', client_phone: '', device: 'Монитор', model: '', serial_no: '', acceptance_point: '',
				appearance_text: '', defect_text: 'экран', pay_type: 'warranty', service_cost: null, customer_price: null,
				deal_id: null, task_id: 9, refusal_at: null, refusal_reason: null, refusal_by_id: null, refusal_by_name: null,
				refusal_deal_cancelled: 0, refusal_task_reframed: 0, repair_item_code: null, repair_store: 'Офис', issue_store: null,
				repair_delivery_note: null, product_id: 42, source_store: 'Дунайский', service_comment: '', internal_comment: '',
				source_created_at: '2026-09-01 10:00:00.000000', created_by_id: '1', created_by_name: 'Owner',
				last_state_hash: Buffer.from(source.stateHash, 'hex'),
			}];
			if (call === 2) return [{ repair_id: 33, ordinal: 1, happened_at: '2026-09-01 10:00:00.000000', repair_status: 'pre_office', actor_id: '1', actor_name: '', note: null }];
			return [{ repair_id: 33, media_kind: 'file', ordinal: 1, bitrix_file_id: 7, display_name: 'акт', media_url: 'https://example.test/a', media_type: 'pdf' }];
		},
	} as unknown as TransferSqlPool;
	const records = await readRepairSqlRecords(pool);
	assert.deepEqual(records, [source]);
});

test('repair SQL reader rejects a corrupted stored hash', async () => {
	let call = 0;
	const pool = {
		async query() {
			call += 1;
			if (call === 1) return [{
				id: 33, bitrix_external_id: 33, display_name: 'Монитор', repair_kind: 'presale', repair_status: 'pre_office', repair_no: 133,
				client_contact_id: null, client_name: '', client_phone: '', device: 'Монитор', model: '', serial_no: '', acceptance_point: '',
				appearance_text: '', defect_text: 'экран', pay_type: 'warranty', service_cost: null, customer_price: null,
				deal_id: null, task_id: 9, refusal_at: null, refusal_reason: null, refusal_by_id: null, refusal_by_name: null,
				refusal_deal_cancelled: 0, refusal_task_reframed: 0, repair_item_code: null, repair_store: 'Офис', issue_store: null,
				repair_delivery_note: null, product_id: 42, source_store: 'Дунайский', service_comment: '', internal_comment: '',
				source_created_at: '2026-09-01 10:00:00.000000', created_by_id: '1', created_by_name: 'Owner', last_state_hash: Buffer.alloc(32),
			}];
			return [];
		},
	} as unknown as TransferSqlPool;
	await assert.rejects(() => readRepairSqlRecords(pool), /state hash mismatch/);
});
