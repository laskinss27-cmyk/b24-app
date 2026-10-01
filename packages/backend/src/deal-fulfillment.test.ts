import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDealFulfillment, refreshServiceFulfillmentOnPlanLoad } from './deal-fulfillment.js';
import type { B24Client } from './b24/client.js';
import type { ErpClient } from './erp/client.js';
import type { PlanItem, ErpRealization } from './erp/operations.js';

const service: PlanItem = { productId: 9916, itemName: 'Проектирование', qty: 1, rate: 154000,
	priceListRate: 154000, discountPercent: 0, delivered: 0, isService: true, lineKey: 'service' };
const goods: PlanItem = { ...service, productId: 42, itemName: 'Камера', qty: 2, isService: false, lineKey: 'goods' };
const sale = (qty: number, submitted = true): ErpRealization => ({ name: 'DN', dealId: '32686', postingDate: '2026-10-01',
	submitted, isReturn: qty < 0, returnAgainst: qty < 0 ? 'DN' : '', grandTotal: 0,
	items: [{ productId: 42, itemName: 'Камера', qty, rate: 10, storeTitle: 'Склад', rowName: 'row', sourceRow: '', segmentId: 'base' }] });

test('service-only deal does not need any realization to satisfy the goods requirement', () => {
	assert.equal(calculateDealFulfillment([service], []), 'ДА');
	assert.equal(calculateDealFulfillment([], []), 'НЕТ');
});

test('unrealized services never hide a goods shortage or require posting after goods are shipped', () => {
	assert.equal(calculateDealFulfillment([goods, service], []), 'НЕТ');
	assert.equal(calculateDealFulfillment([goods, service], [sale(1)]), 'НЕТ');
	assert.equal(calculateDealFulfillment([goods, service], [sale(2, false)]), 'НЕТ');
	assert.equal(calculateDealFulfillment([goods, service], [sale(2)]), 'ДА');
	assert.equal(calculateDealFulfillment([goods, service], [sale(2), sale(-2)]), 'НЕТ');
});

test('duplicate goods lines still require the complete combined quantity', () => {
	assert.equal(calculateDealFulfillment([goods, { ...goods, lineKey: 'other-price' }, service], [sale(2)]), 'НЕТ');
	assert.equal(calculateDealFulfillment([goods, { ...goods, lineKey: 'other-price' }, service], [sale(4)]), 'ДА');
});

test('opening an old service deal refreshes only the open flag; shortage, return, closed or changed composition is skipped', async () => {
	for (const scenario of [
		{ plan: [service], qty: 0, closed: 'N', changed: false, expected: true },
		{ plan: [service, goods], qty: 2, closed: 'N', changed: false, expected: true },
		{ plan: [service, goods], qty: 1, closed: 'N', changed: false, expected: false },
		{ plan: [service, goods], qty: 0, closed: 'N', changed: false, expected: false },
		{ plan: [service], qty: 0, closed: 'Y', changed: false, expected: false },
		{ plan: [service], qty: 0, closed: 'N', changed: true, expected: false },
	]) {
		const updates: unknown[] = [];
		const client = { async call(method: string, params: unknown) {
			if (method === 'crm.deal.get') return { CLOSED: scenario.closed, UF_CRM_ALL_REALIZED: 'НЕТ' };
			if (method === 'crm.deal.update') { updates.push(params); return true; }
			throw new Error(method);
		} } as unknown as B24Client;
		const erp = { async list(type: string) {
			if (type === 'Delivery Note') return [{ name: 'DN' }];
			if (type === 'Sales Order') return [{ name: 'SO' }];
			if (type === 'Item') return [{ name: '9916', is_stock_item: 0 }, { name: '42', is_stock_item: 1 }];
			throw new Error(type);
		}, async get(type: string) {
			if (type === 'Delivery Note') return { name: 'DN', b24_deal_id: '32686', docstatus: 1, items: [{ item_code: '42', qty: scenario.qty }] };
			if (type === 'Sales Order') return { items: scenario.plan.map((item) => ({ name: item.lineKey, item_code: String(item.productId), qty: item.qty + (scenario.changed ? 1 : 0), rate: item.rate })) };
			throw new Error(type);
		}, async update() { throw new Error('Opening a plan must not write ERP documents'); } } as unknown as ErpClient;
		assert.equal(await refreshServiceFulfillmentOnPlanLoad(client, erp, 32686, scenario.plan), scenario.expected);
		assert.deepEqual(updates, scenario.expected ? [{ id: 32686, fields: { UF_CRM_ALL_REALIZED: 'ДА' } }] : []);
	}
});
