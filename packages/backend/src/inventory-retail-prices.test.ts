import assert from 'node:assert/strict';
import test from 'node:test';
import { inventoryMoneyTotals } from '@b24-app/shared';
import type { ErpClient } from './erp/client.js';
import { priceInventoryResult } from './inventory-retail-prices.js';
import type { SubmittedInventoryResult } from './inventory-stock-snapshot.js';
import { parseInventoryBitrixItem } from './inventory-sql/model.js';
import { inventorySqlRecordToBitrixItem } from './inventory-sql/read-shadow.js';

const result: SubmittedInventoryResult = { total: 4, counted: 4, discrepancies: 4, lines: [
	{ productId: 1, name: 'Монитор', book: 10, fact: 8, diff: -2 },
	{ productId: 2, name: 'Кабель', book: 1, fact: 1.5, diff: 0.5 },
	{ productId: 3, name: 'Нет цены', book: 0, fact: 1, diff: 1 },
	{ productId: 4, name: 'Нулевая цена', book: 1, fact: 0, diff: -1 },
] };

test('retail prices are fetched from Standard Selling in RUB, frozen on copied results and zero is retained', async () => {
	let price = 5000;
	const erp = { async list(doctype: string, _fields: string[], filters: unknown[]) {
		assert.equal(doctype, 'Item Price'); assert.deepEqual(filters[0], ['price_list', '=', 'Standard Selling']);
		return [{ item_code: '1', price_list_rate: price, currency: 'RUB' }, { item_code: '2', price_list_rate: 100, currency: 'RUB' }, { item_code: '4', price_list_rate: 0, currency: 'RUB' }];
	} } as unknown as ErpClient;
	const priced = await priceInventoryResult(erp, result);
	assert.equal(priced.lines[0]!.retailPrice, 5000);
	assert.equal(priced.lines[3]!.retailPrice, 0);
	assert.equal(result.lines[0]!.retailPrice, undefined);
	price = 7000;
	assert.equal(inventoryMoneyTotals(priced.lines).shortage, 10000);
	assert.equal(inventoryMoneyTotals(priced.lines).surplus, null);
	assert.equal(inventoryMoneyTotals(priced.lines).missingSurplus, 1);
});

test('missing, negative, foreign-currency and conflicting retail prices are not replaced with zero', async () => {
	const erp = { async list() { return [
		{ item_code: '1', price_list_rate: 10, currency: 'RUB' }, { item_code: '1', price_list_rate: 20, currency: 'RUB' },
		{ item_code: '2', price_list_rate: 5, currency: 'USD' }, { item_code: '3', price_list_rate: null, currency: 'RUB' },
		{ item_code: '4', price_list_rate: -1, currency: 'RUB' },
	]; } } as unknown as ErpClient;
	assert.ok((await priceInventoryResult(erp, result)).lines.every((line) => line.retailPrice === undefined));
});

test('SQL normalization and Bitrix reconstruction preserve frozen retail prices and old hashes', () => {
	for (const price of [undefined, 0, 123.45]) {
		const item = { ID: '42', NAME: 'Ревизия', DETAIL_TEXT: JSON.stringify({ status: 'active', points: [{ storeId: -1, storeName: 'Склад', status: 'submitted',
			result: { total: 1, counted: 1, discrepancies: 1, lines: [{ ...result.lines[0], ...(price === undefined ? {} : { retailPrice: price }) }] },
		}] }) };
		const parsed = parseInventoryBitrixItem(item);
		assert.deepEqual(parsed.issues, []);
		assert.equal(parsed.inventory!.points[0]!.resultLines[0]!.retailPrice, price);
		const restored = inventorySqlRecordToBitrixItem(parsed.inventory!);
		const again = parseInventoryBitrixItem(restored);
		assert.equal(again.inventory!.stateHash, parsed.inventory!.stateHash);
		assert.deepEqual(again.issues, []);
	}
});
