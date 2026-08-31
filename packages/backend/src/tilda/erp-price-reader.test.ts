import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCompleteTildaErpPrices } from './erp-price-reader.js';

test('Tilda ERP price reader returns current positive Standard Selling RUB prices and leaves missing prices absent', async () => {
	const calls: Array<{ doctype: string; fields: string[]; filters?: unknown[] }> = [];
	const prices = await fetchCompleteTildaErpPrices({
		async list(doctype: string, fields: string[], filters?: unknown[]) {
			calls.push({ doctype, fields, ...(filters ? { filters } : {}) });
			return [
				{ item_code: '101', price_list_rate: 2150.004, currency: 'RUB', valid_from: '2026-01-01', valid_upto: null, packing_unit: 0 },
				{ item_code: '101', price_list_rate: 999, currency: 'RUB', valid_from: '2025-01-01', valid_upto: '2025-12-31', packing_unit: 0 },
			];
		},
	} as never, [101, 202], new Date('2026-08-31T00:00:00.000Z'));
	assert.deepEqual([...prices], [[101, 2150]]);
	assert.deepEqual(calls[0]?.filters, [
		['item_code', 'in', ['101', '202']],
		['price_list', '=', 'Standard Selling'],
	]);
});

test('Tilda ERP price reader fails closed for duplicates, non-RUB, zero and unsupported packing', async () => {
	const run = (rows: unknown[]) => fetchCompleteTildaErpPrices({ async list() { return rows; } } as never, [101]);
	await assert.rejects(run([
		{ item_code: '101', price_list_rate: 100, currency: 'RUB' },
		{ item_code: '101', price_list_rate: 200, currency: 'RUB' },
	]), /2 active/u);
	await assert.rejects(run([{ item_code: '101', price_list_rate: 100, currency: 'USD' }]), /uses USD/u);
	await assert.rejects(run([{ item_code: '101', price_list_rate: 0, currency: 'RUB' }]), /not positive/u);
	await assert.rejects(run([{ item_code: '101', price_list_rate: 100, currency: 'RUB', packing_unit: 5 }]), /packing unit/u);
});
