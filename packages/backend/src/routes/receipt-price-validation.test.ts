import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { assertReceiptPrices } from '../erp/receipt-price-validation.js';
import { registerStockDocumentCreationRoute } from './api-stock-document-creation-route.js';
import { registerStockDocumentSubmitRoute } from './api-stock-document-submit-route.js';

test('receipt prices reject missing, zero, negative and non-finite values and identify every item', () => {
	for (const rate of [undefined, null, '', ' ', 0, -1, NaN, Infinity, 'abc']) {
		assert.throws(() => assertReceiptPrices([{ rate, itemCode: 123, itemName: 'HDD 2 ТБ' }]), /Заполните закупочную цену больше 0 ₽.*HDD 2 ТБ.*123/);
	}
	assert.doesNotThrow(() => assertReceiptPrices([{ rate: 0.01 }, { rate: '5200' }]));
	assert.throws(() => assertReceiptPrices([{ rate: 0, itemCode: 1 }, { rate: 12, itemCode: 2 }, { rate: null, itemCode: 3 }]), /Товар #1; 3. Товар #3/);
});

test('HTTP receipt guard blocks creation and old drafts before writes; valid prices and inventory receipts still work', async t => {
	let items: Array<Record<string, unknown>> = [];
	let reads = 0;
	let submits = 0;
	const erp = {
		async get() { reads++; return { items, stock_entry_type: 'Material Receipt' }; },
		async submit() { submits++; },
		async create() { throw new Error('Unexpected write'); },
	} as unknown as ErpClient;
	t.mock.method(ErpClient, 'fromEnv', () => erp);
	t.mock.method(B24Client.prototype, 'call', async () => ({ ID: '2000', UF_DEPARTMENT: [10] }));
	const app = Fastify();
	app.decorate('config', { portalDomain: 'example.bitrix24.ru' } as typeof app.config);
	registerStockDocumentCreationRoute(app);
	registerStockDocumentSubmitRoute(app);
	const auth = { domain: 'example.bitrix24.ru', accessToken: 'test-only' };
	try {
		for (const purchase of [undefined, null, '', 0, -1, 'abc']) {
			const res = await app.inject({ method: 'POST', url: '/api/stock/create', payload: { ...auth, kind: 'receipt', toStore: 'Main', supplier: 'New supplier', lines: [{ productId: 123, qty: 1, purchase }] } });
			assert.equal(res.json().ok, false);
			assert.match(res.json().error, /Заполните закупочную цену больше 0 ₽.*123/);
		}
		assert.equal(reads, 0);
		for (const rate of [undefined, null, '', 0, -1, 'abc']) {
			items = [{ item_code: '123', item_name: 'HDD 2 ТБ', qty: 1, rate, valuation_rate: 5200, allow_zero_valuation_rate: 1 }];
			const res = await app.inject({ method: 'POST', url: '/api/stock/submit', payload: { ...auth, kind: 'receipt', name: 'PR-old' } });
			assert.equal(res.json().ok, false);
			assert.match(res.json().error, /HDD 2 ТБ/);
		}
		assert.equal(submits, 0);
		items = [];
		const empty = await app.inject({ method: 'POST', url: '/api/stock/submit', payload: { ...auth, kind: 'receipt', name: 'PR-empty' } });
		assert.equal(empty.json().ok, false);
		assert.equal(submits, 0);
		items = [{ item_code: '123', rate: 5200 }];
		const valid = await app.inject({ method: 'POST', url: '/api/stock/submit', payload: { ...auth, kind: 'receipt', name: 'PR-valid' } });
		assert.equal(valid.json().ok, true);
		items = [{ item_code: '123', basic_rate: 0 }];
		const inventory = await app.inject({ method: 'POST', url: '/api/stock/submit', payload: { ...auth, kind: 'receipt', doctype: 'Stock Entry', name: 'STE-inventory' } });
		assert.equal(inventory.json().ok, true);
		assert.equal(submits, 2);
	} finally { await app.close(); }
});

test('price validation does not bypass posting permissions', async t => {
	const erp = { async get() { throw new Error('Must not read'); }, async submit() { throw new Error('Must not submit'); } } as unknown as ErpClient;
	t.mock.method(ErpClient, 'fromEnv', () => erp);
	t.mock.method(B24Client.prototype, 'call', async () => ({ ID: '2001', UF_DEPARTMENT: [12] }));
	const app = Fastify();
	app.decorate('config', { portalDomain: 'example.bitrix24.ru' } as typeof app.config);
	registerStockDocumentSubmitRoute(app);
	try {
		const res = await app.inject({ method: 'POST', url: '/api/stock/submit', payload: { domain: 'example.bitrix24.ru', accessToken: 'test-only', kind: 'receipt', name: 'PR-old' } });
		assert.equal(res.statusCode, 403);
	} finally { await app.close(); }
});
