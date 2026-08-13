import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import type { AdminDealDocumentDiagnostic } from './deal-document-diagnostics.js';
import { fulfillmentSyncBlocker, normalizeFulfillmentSyncComment, synchronizeAdminDealFulfillment } from './deal-fulfillment-synchronizer.js';

function diagnostic(overrides: Partial<AdminDealDocumentDiagnostic> = {}): AdminDealDocumentDiagnostic {
	return {
		deal: { id: 42, found: true, title: 'Сделка', categoryId: 1, stageId: 'NEW', closed: false, semantic: 'P', opportunity: 0, fulfillmentField: 'НЕТ', error: null },
		documents: [], applicationDocuments: { contracts: [], supplyCards: [], transfers: [], errors: [] },
		structure: { status: 'ok', checkedLinkCount: 0, brokenLinkCount: 0, links: [] }, calculatedFulfillment: 'ДА', shortages: [], issues: [], ...overrides,
	};
}

test('synchronizes only the technical field and confirms it by rereading the deal', async () => {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	let stored = 'НЕТ';
	const client = { async call(method: string, params: Record<string, unknown>) {
		calls.push({ method, params });
		if (method === 'crm.deal.update') { stored = String((params.fields as Record<string, unknown>).UF_CRM_ALL_REALIZED); return true; }
		if (method === 'crm.deal.get') return { UF_CRM_ALL_REALIZED: stored };
		throw new Error(`unexpected ${method}`);
	} } as unknown as B24Client;
	const result = await synchronizeAdminDealFulfillment(client, {} as ErpClient, {
		dealId: 42, expectedCurrent: 'НЕТ', expectedValue: 'ДА', comment: 'Проверил документы реализации.',
	}, diagnostic(), async () => ({ current: 'НЕТ', value: 'ДА' }));
	assert.deepEqual(result, { previous: 'НЕТ', value: 'ДА', changed: true });
	assert.deepEqual(calls, [
		{ method: 'crm.deal.update', params: { id: 42, fields: { UF_CRM_ALL_REALIZED: 'ДА' } } },
		{ method: 'crm.deal.get', params: { id: 42 } },
	]);
});

test('refuses to write when documents changed after diagnostics', async () => {
	const client = { async call() { throw new Error('write must not happen'); } } as unknown as B24Client;
	await assert.rejects(synchronizeAdminDealFulfillment(client, {} as ErpClient, {
		dealId: 42, expectedCurrent: 'НЕТ', expectedValue: 'ДА', comment: 'Проверил документы реализации.',
	}, diagnostic(), async () => ({ current: 'НЕТ', value: 'НЕТ' })), /Состояние сделки или документов изменилось/);
});

test('blocks synchronization while the deal plan is missing or ambiguous', () => {
	assert.match(fulfillmentSyncBlocker(diagnostic({ issues: [{ code: 'missing_plan', severity: 'warning', title: '', details: '' }] })) ?? '', /плана/);
	assert.match(fulfillmentSyncBlocker(diagnostic({ issues: [{ code: 'multiple_plans', severity: 'warning', title: '', details: '' }] })) ?? '', /плана/);
});

test('requires an administrative comment', () => {
	assert.throws(() => normalizeFulfillmentSyncComment(''), /Укажите комментарий/);
	assert.equal(normalizeFulfillmentSyncComment('  Проверено вручную  '), 'Проверено вручную');
});
