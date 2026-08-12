import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { diagnoseAdminDealDocuments, searchAdminDealDocuments } from './deal-document-diagnostics.js';

function fakeErp(documents: Record<string, Array<Record<string, unknown>>>): ErpClient {
	return {
		async list(type: string, _fields: string[], filters?: unknown[]) {
			const rows = documents[type] ?? [];
			const filter = filters?.[0] as [string, string, unknown] | undefined;
			if (!filter) return rows.map(({ items: _items, ...row }) => row);
			if (filter[0] === 'b24_deal_id' && filter[1] === '=') return rows.filter((row) => String(row.b24_deal_id) === String(filter[2])).map(({ items: _items, ...row }) => row);
			if (filter[0] === 'name' && filter[1] === 'like') {
				const needle = String(filter[2]).replaceAll('%', '').toLowerCase();
				return rows.filter((row) => String(row.name).toLowerCase().includes(needle)).map(({ items: _items, ...row }) => row);
			}
			return rows.map(({ items: _items, ...row }) => row);
		},
		async get(type: string, name: string) {
			return (documents[type] ?? []).find((row) => row.name === name) ?? null;
		},
	} as unknown as ErpClient;
}

const erp = fakeErp({
	'Sales Order': [{
		name: 'SAL-ORD-2026-00303', b24_deal_id: '37868', docstatus: 0, status: 'Draft', modified: '2026-08-12 08:07:32', creation: '2026-08-12 08:07:00', grand_total: 3100,
		items: [{ name: 'SO-ROW-1', item_code: '18448', item_name: 'Камера', qty: 1, delivered_qty: 0, rate: 3100, amount: 3100 }],
	}],
	'Delivery Note': [{
		name: 'MAT-DN-2026-00451', b24_deal_id: '37868', docstatus: 0, status: 'Draft', modified: '2026-08-12 08:10:03', creation: '2026-08-12 08:10:03', posting_date: '2026-08-12', grand_total: 3100,
		items: [{ name: 'DN-ROW-1', item_code: '18448', item_name: 'Камера', qty: 1, rate: 3100, amount: 3100, warehouse: 'Максидом - УД' }],
	}],
});

test('deal document search finds a deal by its ERP document number', async () => {
	assert.deepEqual(await searchAdminDealDocuments(erp, 'MAT-DN-2026-00451'), [{
		dealId: 37868,
		planCount: 0,
		realizationCount: 1,
		draftCount: 1,
		lastDocument: 'MAT-DN-2026-00451',
		lastModified: '2026-08-12 08:10:03',
	}]);
});

test('deal document summary never marks the editable Sales Order plan as an actionable draft', async () => {
	assert.deepEqual(await searchAdminDealDocuments(erp, 'SAL-ORD-2026-00303'), [{
		dealId: 37868,
		planCount: 1,
		realizationCount: 0,
		draftCount: 0,
		lastDocument: 'SAL-ORD-2026-00303',
		lastModified: '2026-08-12 08:07:32',
	}]);
});

test('deal document diagnostics explains an unsubmitted realization without changing it', async () => {
	const client = {
		async call(method: string) {
			assert.equal(method, 'crm.deal.get');
			return { ID: '37868', TITLE: 'Камера', CATEGORY_ID: '6', STAGE_ID: 'C6:PREPARATION', CLOSED: 'N', STAGE_SEMANTIC_ID: 'P', OPPORTUNITY: '3100', UF_CRM_ALL_REALIZED: 'НЕТ' };
		},
	} as unknown as B24Client;
	const result = await diagnoseAdminDealDocuments(client, erp, 37868);
	assert.equal(result.calculatedFulfillment, 'НЕТ');
	assert.deepEqual(result.shortages, [{ productId: 18448, itemName: 'Камера', required: 1, realized: 0 }]);
	assert.equal(result.documents[1]?.docstatus, 0);
	assert.ok(result.issues.some((issue) => issue.code === 'realization_drafts' && issue.details.includes('MAT-DN-2026-00451')));
});
