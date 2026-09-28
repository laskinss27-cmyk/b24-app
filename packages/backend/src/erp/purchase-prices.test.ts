import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCoreCatalogPrices, fetchErpPurchasing, updateCoreCatalogPrices } from './stock-catalog.js';
import { fillMissingPurchasePrices } from './purchase-prices.js';
import type { ErpClient } from './client.js';

function fixture() {
	const calls: Array<{ type: string; filters: unknown[] }> = [];
	const client = {
		get: async () => ({}),
		list: async (type: string, _fields: string[], filters: unknown[] = []) => {
			calls.push({ type, filters });
			if (type === 'Item Price') return [
				{ item_code: '27112', price_list: 'Standard Buying', price_list_rate: 0 },
				{ item_code: '19842', price_list: 'Standard Buying', price_list_rate: 0.01 },
				{ item_code: '19324', price_list: 'Standard Buying', price_list_rate: 17902 },
				{ item_code: '19324', price_list: 'Standard Buying', price_list_rate: 8050 },
			];
			if (type === 'Item') return [
				{ name: '27112', last_purchase_rate: 23632, valuation_rate: 0 },
				{ name: '19842', last_purchase_rate: 0, valuation_rate: 0 },
				{ name: '19324', last_purchase_rate: 8050, valuation_rate: 8050 },
				{ name: '19824', last_purchase_rate: 0, valuation_rate: 0 },
				{ name: '10862', last_purchase_rate: 0, valuation_rate: 0 },
				{ name: '22468', last_purchase_rate: 0, valuation_rate: 0 },
			];
			if (type === 'Stock Ledger Entry') return [
				{ item_code: '19842', valuation_rate: 11976, posting_date: '2026-07-15', posting_time: '4:7:52.538155', actual_qty: 0 },
				{ item_code: '19824', valuation_rate: 11000, posting_date: '2026-07-15', posting_time: '4:7:52.538155' },
				{ item_code: '10862', valuation_rate: 7999, posting_date: '2026-07-15', posting_time: '4:7:52.538155' },
			];
			throw new Error(`unexpected read ${type}`);
		},
	} as unknown as ErpClient;
	return { client, calls };
}

test('deal costs recover receipt and migrated valuation even after stock reaches zero', async () => {
	const { client, calls } = fixture();
	const prices = await fetchErpPurchasing(client, [27112, 19842, 19324, 19824, 10862, 22468]);
	assert.equal(prices.get(27112), 23632);
	assert.equal(prices.get(19842), 11976);
	assert.equal(prices.get(19824), 11000);
	assert.equal(prices.get(10862), 7999);
	assert.equal(prices.get(19324), 17902, 'newest explicit catalog price must win over history and older duplicates');
	assert.equal(prices.get(22468), 0, 'unknown price must remain unknown');
	const ledger = calls.find((call) => call.type === 'Stock Ledger Entry')!;
	assert.ok(ledger.filters.some((filter) => JSON.stringify(filter) === JSON.stringify(['is_cancelled', '=', 0])));
	assert.ok(ledger.filters.some((filter) => JSON.stringify(filter) === JSON.stringify(['valuation_rate', '>', .01])));
});

test('catalog and deal readers resolve the same costs without writing source documents', async () => {
	const { client } = fixture();
	const catalog = await fetchCoreCatalogPrices(client);
	const deal = await fetchErpPurchasing(client, [27112, 19842, 19324, 19824, 10862, 22468]);
	for (const [id, price] of deal) assert.equal(catalog.get(id)?.purchase ?? 0, price);
	assert.equal(catalog.has(22468), false, 'do not overwrite an existing metadata fallback with invented zero');
});

test('historical fallback chooses the latest posting time including fractional seconds', async () => {
	const client = { list: async (type: string) => type === 'Item'
		? [{ name: '1', valuation_rate: 0 }]
		: [
			{ item_code: '1', valuation_rate: 10, posting_date: '2026-09-24', posting_time: '5:4:10.01' },
			{ item_code: '1', valuation_rate: 9, posting_date: '2026-09-24', posting_time: '5:4:9.99' },
			{ item_code: '1', valuation_rate: 11, posting_date: '2026-09-23', posting_time: '23:0:0' },
		] } as unknown as ErpClient;
	const prices = new Map<number, number>();
	await fillMissingPurchasePrices(client, prices, [1]);
	assert.equal(prices.get(1), 10);
});

test('purchase-only update writes no retail price, valuation or stock document', async () => {
	const writes: unknown[] = [];
	const client = {
		get: async () => ({}),
		list: async () => [{ name: 'BUY-27112' }],
		update: async (type: string, name: string, fields: unknown) => { writes.push({ type, name, fields }); return {}; },
	} as unknown as ErpClient;
	await updateCoreCatalogPrices(client, { productId: 27112, purchase: 17902 });
	assert.deepEqual(writes, [{ type: 'Item Price', name: 'BUY-27112', fields: { price_list_rate: 17902, currency: 'RUB' } }]);
});
