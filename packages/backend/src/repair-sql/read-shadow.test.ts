import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseRuntime } from '../database/runtime.js';
import { buildRepairSqlBackfillPlan } from './backfill-plan.js';
import { resolveRepairSqlRead } from './read-shadow.js';
import { loadConfig } from '../config.js';

const item = {
	ID: '101', NAME: 'Камера', DETAIL_TEXT: JSON.stringify({
		kind: 'client', status: 'received_tt', repairNo: 100, client: { contactId: null, name: 'Иван', phone: '' },
		device: 'Камера', model: '', serial: '', point: 'Дунайский', appearance: '', defect: '', payType: 'warranty',
		cost: null, ourPrice: null, dealId: null, taskId: null, clientRefusal: null, repairItemCode: null,
		repairStore: null, issueStore: null, repairDeliveryNote: null, productId: null, sourceStore: null,
		comment: '', internalComment: '', photos: [], files: [], createdAt: '2026-09-01T10:00:00Z',
		createdById: '1', createdByName: 'Owner', history: [],
	}),
};

test('repair verified read substitutes SQL only after exact parity', async () => {
	const plan = buildRepairSqlBackfillPlan({ observedAt: '2026-09-06T08:00:00Z', sourceComplete: true, sourceRecordCount: 1, items: [item] });
	const database = { mode: 'readiness', async readRepairRecords() { return plan.records; } } as DatabaseRuntime;
	const result = await resolveRepairSqlRead('verified', database, [item], '2026-09-06T08:00:00Z');
	assert.equal(result.report.status, 'match');
	assert.equal(result.report.responseSource, 'sql');
	assert.equal(result.items.length, 1);
});

test('repair shadow mismatch fails open to the complete Bitrix response', async () => {
	const database = { mode: 'readiness', async readRepairRecords() { return []; } } as unknown as DatabaseRuntime;
	const result = await resolveRepairSqlRead('shadow', database, [item], '2026-09-06T08:00:00Z');
	assert.equal(result.report.status, 'mismatch');
	assert.equal(result.report.responseSource, 'bitrix');
	assert.equal(result.items[0], item);
});

test('repair SQL read gate is disabled by default and accepts guarded stages', () => {
	assert.equal(loadConfig({}).repairSqlRead, 'off');
	assert.equal(loadConfig({ B24_APP_REPAIR_SQL_READ: 'shadow' }).repairSqlRead, 'shadow');
	assert.equal(loadConfig({ B24_APP_REPAIR_SQL_READ: 'verified' }).repairSqlRead, 'verified');
	assert.equal(loadConfig({ B24_APP_REPAIR_SQL_READ: 'primary' }).repairSqlRead, 'primary');
});
