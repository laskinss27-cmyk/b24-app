import assert from 'node:assert/strict';
import test from 'node:test';
import type { ErpClient } from './client.js';
import { itemPendingDeals } from './stock-movements.js';

test('pending deal positions subtract submitted shipments and add submitted returns back', async () => {
	const docs = new Map<string, Record<string, unknown>>([
		['Sales Order:SO-1', { name: 'SO-1', delivery_date: '2026-10-10', items: [{ item_code: '44', qty: 5 }, { item_code: '99', qty: 1 }] }],
		['Sales Order:SO-2', { name: 'SO-2', delivery_date: '2026-10-12', items: [{ item_code: '44', qty: 2 }] }],
		['Sales Order:SO-3', { name: 'SO-3', delivery_date: '2026-10-01', items: [{ item_code: '44', qty: 1 }] }],
		['Delivery Note:DN-1', { name: 'DN-1', docstatus: 1, items: [{ item_code: '44', qty: 3 }] }],
		['Delivery Note:RET-1', { name: 'RET-1', docstatus: 1, is_return: 1, items: [{ item_code: '44', qty: -1 }] }],
		['Delivery Note:DN-2', { name: 'DN-2', docstatus: 1, items: [{ item_code: '44', qty: 2 }] }],
	]);
	const erp = {
		async list(doctype: string) {
			if (doctype === 'Sales Order') return [
				{ name: 'SO-1', b24_deal_id: '101', delivery_date: '2026-10-10' },
				{ name: 'SO-2', b24_deal_id: '102', delivery_date: '2026-10-12' },
				{ name: 'SO-3', b24_deal_id: '103', delivery_date: '2026-10-01' },
			];
			if (doctype === 'Delivery Note') return [
				{ name: 'DN-1', b24_deal_id: '101' },
				{ name: 'RET-1', b24_deal_id: '101' },
				{ name: 'DN-2', b24_deal_id: '102' },
			];
			return [];
		},
		async get(doctype: string, name: string) { return docs.get(`${doctype}:${name}`) ?? null; },
	} as unknown as ErpClient;

	assert.deepEqual(await itemPendingDeals(erp, 44), [
		{ dealId: '103', planName: 'SO-3', plannedQty: 1, shippedQty: 0, pendingQty: 1, deliveryDate: '2026-10-01' },
		{ dealId: '101', planName: 'SO-1', plannedQty: 5, shippedQty: 2, pendingQty: 3, deliveryDate: '2026-10-10' },
	]);
});
