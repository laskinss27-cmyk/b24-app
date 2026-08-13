import assert from 'node:assert/strict';
import test from 'node:test';
import type { ErpClient } from '../erp/client.js';
import { normalizeRestoreComment, restoreUnlinkedDealDocument } from './deal-document-link-restorer.js';
import type { DealDocumentStructureLink } from './deal-document-structure.js';

function candidate(overrides: Partial<DealDocumentStructureLink> = {}): DealDocumentStructureLink {
	return {
		fromType: 'Приход от поставщика', fromName: 'MAT-PRE-1', relation: 'создан по заказу поставщику',
		targetType: 'Purchase Order', targetName: 'PUR-ORD-1', status: 'wrong_deal', targetDealId: null,
		targetDocstatus: 0, details: 'Документ существует, но не привязан к сделке.', ...overrides,
	};
}

function fakeErp(initial: Record<string, unknown>): { erp: ErpClient; updates: Array<Record<string, unknown>> } {
	let document = { ...initial };
	const updates: Array<Record<string, unknown>> = [];
	return {
		erp: {
			async get() { return { ...document }; },
			async update(_type: string, _name: string, fields: Record<string, unknown>) {
				updates.push(fields);
				document = { ...document, ...fields };
				return { ...document };
			},
		} as unknown as ErpClient,
		updates,
	};
}

test('restores only a verified unlinked draft and confirms the written deal id', async () => {
	const { erp, updates } = fakeErp({ name: 'PUR-ORD-1', docstatus: 0, b24_deal_id: '' });
	const result = await restoreUnlinkedDealDocument(erp, {
		dealId: 42, targetType: 'Purchase Order', targetName: 'PUR-ORD-1', comment: 'Восстанавливаю оборванную связь прихода.',
	}, [candidate()]);
	assert.deepEqual(updates, [{ b24_deal_id: '42' }]);
	assert.deepEqual(result, { dealId: 42, targetType: 'Purchase Order', targetName: 'PUR-ORD-1', changed: true });
});

test('refuses a document already linked to another deal', async () => {
	const { erp, updates } = fakeErp({ name: 'PUR-ORD-1', docstatus: 0, b24_deal_id: '99' });
	await assert.rejects(restoreUnlinkedDealDocument(erp, {
		dealId: 42, targetType: 'Purchase Order', targetName: 'PUR-ORD-1', comment: 'Проверенная попытка восстановления.',
	}, [candidate()]), /другой сделке #99/);
	assert.deepEqual(updates, []);
});

test('refuses a submitted document even if its deal field is empty', async () => {
	const { erp, updates } = fakeErp({ name: 'PUR-ORD-1', docstatus: 1, b24_deal_id: '' });
	await assert.rejects(restoreUnlinkedDealDocument(erp, {
		dealId: 42, targetType: 'Purchase Order', targetName: 'PUR-ORD-1', comment: 'Проверенная попытка восстановления.',
	}, [candidate()]), /только у черновика/);
	assert.deepEqual(updates, []);
});

test('requires a meaningful administrative comment', () => {
	assert.throws(() => normalizeRestoreComment('  '), /Укажите комментарий/);
	assert.equal(normalizeRestoreComment('  Восстановление после проверки  '), 'Восстановление после проверки');
});
