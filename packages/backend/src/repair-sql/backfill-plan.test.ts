import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRepairSqlBackfillPlan } from './backfill-plan.js';
import { repairSqlRecordToLegacy } from './model.js';

function item(id = 101): Record<string, unknown> {
	return {
		ID: String(id),
		NAME: 'Камера · DS-2CD · Клиент',
		DETAIL_TEXT: JSON.stringify({
			kind: 'client', status: 'received_tt', repairNo: 100,
			client: { contactId: 55, name: 'Клиент', phone: '+70000000000' },
			device: 'Камера', model: 'DS-2CD', serial: 'SN', point: 'Дунайский',
			appearance: 'без повреждений', defect: 'не включается', payType: 'paid', cost: 1000, ourPrice: 1500,
			dealId: 77, taskId: null, clientRefusal: null, repairItemCode: 'REPAIR-100', repairStore: 'Дунайский',
			issueStore: null, repairDeliveryNote: null, productId: null, sourceStore: null,
			comment: '', internalComment: 'проверить блок питания',
			photos: [{ id: 1, name: 'photo.jpg', url: 'https://example.test/photo.jpg' }],
			files: [{ id: 2, name: 'act.pdf', url: 'https://example.test/act.pdf', type: 'application/pdf' }],
			createdAt: '2026-09-01T10:00:00.000Z', createdById: '1', createdByName: 'Owner',
			history: [{ at: '2026-09-01T10:00:00.000Z', status: 'received_tt', byId: '1', byName: 'Owner' }],
		}),
	};
}

test('repair backfill plan normalizes every scalar and child collection without payload JSON', () => {
	const plan = buildRepairSqlBackfillPlan({ observedAt: '2026-09-06T08:00:00Z', sourceComplete: true, sourceRecordCount: 1, items: [item()] });
	assert.equal(plan.readyToApply, true);
	assert.deepEqual(plan.counts, { records: 1, history: 1, media: 2 });
	assert.match(plan.planHash, /^[a-f0-9]{64}$/);
	assert.deepEqual(repairSqlRecordToLegacy(plan.records[0]!), {
		id: 101,
		name: 'Камера · DS-2CD · Клиент',
		...JSON.parse(String(item()['DETAIL_TEXT'])),
	});
});

test('repair plan fails closed for unknown fields and duplicate repair numbers', () => {
	const first = item(101);
	const second = item(102);
	const detail = JSON.parse(String(first['DETAIL_TEXT'])) as Record<string, unknown>;
	detail['lostPayload'] = true;
	first['DETAIL_TEXT'] = JSON.stringify(detail);
	const unknown = buildRepairSqlBackfillPlan({ observedAt: '2026-09-06T08:00:00Z', sourceComplete: true, sourceRecordCount: 2, items: [first, second] });
	assert.equal(unknown.readyToApply, false);
	assert.ok(unknown.issues.some((issue) => issue.code === 'unknown_field'));
	const duplicate = buildRepairSqlBackfillPlan({ observedAt: '2026-09-06T08:00:00Z', sourceComplete: true, sourceRecordCount: 2, items: [item(101), item(102)] });
	assert.equal(duplicate.readyToApply, false);
	assert.ok(duplicate.issues.some((issue) => issue.code === 'duplicate_repair_no'));
});

test('repair plan preserves a SQL public marker independently of Bitrix identity', () => {
	const source = item(900);
	const detail = JSON.parse(String(source['DETAIL_TEXT'])) as Record<string, unknown>;
	detail['sqlPublicId'] = 42;
	source['DETAIL_TEXT'] = JSON.stringify(detail);
	const plan = buildRepairSqlBackfillPlan({ observedAt: '2026-09-06T08:00:00Z', sourceComplete: true, sourceRecordCount: 1, items: [source] });
	assert.equal(plan.readyToApply, true);
	assert.equal(plan.records[0]?.id, 42);
	assert.equal(plan.records[0]?.bitrixExternalId, 900);
});

test('repair plan preserves embedded data photos within the MEDIUMTEXT safety limit', () => {
	const source = item();
	const detail = JSON.parse(String(source['DETAIL_TEXT'])) as Record<string, unknown>;
	const embeddedPhoto = `data:image/jpeg;base64,${'a'.repeat(234_112)}`;
	detail['photos'] = [{ id: 0, name: 'photo.jpg', url: embeddedPhoto }];
	source['DETAIL_TEXT'] = JSON.stringify(detail);
	const plan = buildRepairSqlBackfillPlan({ observedAt: '2026-09-06T08:00:00Z', sourceComplete: true, sourceRecordCount: 1, items: [source] });
	assert.equal(plan.readyToApply, true);
	assert.equal(plan.records[0]?.photos[0]?.url, embeddedPhoto);
});
