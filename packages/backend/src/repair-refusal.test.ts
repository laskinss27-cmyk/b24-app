import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from './b24/client.js';
import { syncRepairDeal } from './routes/repair-deal-sync-service.js';
import { completeRefusedRepairTask, selectFailedDealStage } from './routes/repair-refusal-effects.js';
import type { RepairData } from './routes/repair-record.js';

const refusedRepair = (): RepairData => ({
	kind: 'client', status: 'sent', repairNo: 120,
	client: { contactId: 1, name: 'Клиент', phone: '' },
	device: 'Камера', model: '', serial: '', point: 'Точка', appearance: '', defect: '',
	payType: 'paid', cost: 1000, ourPrice: 1500, dealId: 77, taskId: 88,
	clientRefusal: { at: '2026-08-12T10:00:00.000Z', reason: 'не хочет ждать', byId: '1', byName: 'Иван', dealCancelled: true, taskReframed: true },
	repairItemCode: 'REPAIR-120', repairStore: 'Goods In Transit', issueStore: null,
	repairDeliveryNote: null, productId: null, sourceStore: null,
	comment: '', internalComment: '', photos: [], files: [],
	createdAt: '2026-08-01T10:00:00.000Z', createdById: '1', createdByName: 'Иван', history: [],
});

test('repair refusal chooses the failed stage and prefers the canonical LOSE stage', () => {
	assert.equal(selectFailedDealStage([
		{ STATUS_ID: 'C6:FAIL_CUSTOM', SEMANTICS: 'F' },
		{ STATUS_ID: 'C6:LOSE', SEMANTICS: 'F' },
		{ STATUS_ID: 'C6:WON', SEMANTICS: 'S' },
	], 6), 'C6:LOSE');
	assert.throws(() => selectFailedDealStage([{ STATUS_ID: 'C6:NEW', SEMANTICS: 'P' }], 6), /не найден этап отказа/);
});

test('refused repair never synchronizes or recreates its deal', async () => {
	let calls = 0;
	const client = { call: async () => { calls++; throw new Error('must not call B24'); } } as unknown as B24Client;
	const result = await syncRepairDeal(client, refusedRepair(), {} as never);
	assert.equal(calls, 0);
	assert.deepEqual(result, {
		dealId: 77, created: false, noContact: false,
		coreSynced: true, b24Synced: true, syncWarning: null,
	});
});

test('return task is completed only after physical issue', async () => {
	const calls: Array<{ method: string; params: unknown }> = [];
	const client = { call: async (method: string, params: unknown) => { calls.push({ method, params }); } } as unknown as B24Client;
	await completeRefusedRepairTask(client, refusedRepair());
	assert.deepEqual(calls, [{ method: 'tasks.task.complete', params: { taskId: 88 } }]);
});
