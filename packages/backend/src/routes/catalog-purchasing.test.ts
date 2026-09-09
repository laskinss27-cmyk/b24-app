import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { catalogPurchasingPrice, fetchDealCatalogPurchasing } from './catalog-purchasing.js';
import Fastify from 'fastify';
import { ErpClient as RuntimeErpClient } from '../erp/client.js';
import { registerCatalogErpStockRoute } from './api-catalog-erp-stock-route.js';
import { baseCache } from './api-catalog-cache.js';

function fixture(core: Array<{ item_code: string; price_list_rate: number }>, products: Record<number, Record<string, unknown>>, failure?: string, description = 'No data') {
	const erpCalls: unknown[] = [], b24Calls: number[][] = [];
	const erp = { async list(doctype: string, fields: string[], filters: unknown[]) {
		assert.equal(doctype, 'Item Price');
		erpCalls.push({ doctype, fields, filters });
		return core;
	} } as unknown as ErpClient;
	const client = { async callBatch(calls: Record<string, { method: string; params: { id: number } }>) {
		const ids = Object.values(calls).map(c => c.params.id); b24Calls.push(ids);
		assert.ok(Object.values(calls).every(c => c.method === 'catalog.product.get'));
		return {
			result: Object.fromEntries(ids.filter(id => products[id]).map(id => [`p${id}`, { product: products[id] }])),
			result_error: Object.fromEntries(ids.filter(id => !products[id]).map(id => [`p${id}`, { error: failure ?? 'NOT_FOUND', error_description: description }])),
			result_total: {}, result_next: {},
		};
	} } as unknown as Pick<B24Client, 'callBatch'>;
	return { erp, client, erpCalls, b24Calls };
}

test('card and deal share ERP then legacy precedence, including explicit zero', () => {
	assert.equal(catalogPurchasingPrice(2928, 0.01), 2928);
	assert.equal(catalogPurchasingPrice(undefined, 5200), 5200);
	assert.equal(catalogPurchasingPrice(0, 5200), 0);
	assert.equal(catalogPurchasingPrice(undefined, null), null);
});

test('HDD legacy price is available in a deal without an ERP price or stock valuation', async () => {
	const f = fixture([], { 15882: { type: 1, purchasingPrice: '5200.00000000' }, 16114: { type: 1, purchasingPrice: '15000' } });
	assert.deepEqual([...await fetchDealCatalogPurchasing(f.erp, f.client, [15882, 16114, 15882, -1])], [[15882, 5200], [16114, 15000]]);
	assert.deepEqual(f.b24Calls, [[15882, 16114]]);
	assert.equal(f.erpCalls.length, 1);
});

test('corrected ERP prices and explicit zero never read the old price', async () => {
	const f = fixture([{ item_code: '18512', price_list_rate: 2928 }, { item_code: '18612', price_list_rate: 0 }], {});
	assert.deepEqual([...await fetchDealCatalogPurchasing(f.erp, null, [18512, 18612])], [[18512, 2928], [18612, 0]]);
	assert.deepEqual(f.b24Calls, []);
});

test('uses the same fresh legacy metadata cache as the catalog, including known missing values', async () => {
	const f = fixture([], {});
	assert.deepEqual([...await fetchDealCatalogPurchasing(f.erp, f.client, [1, 2], new Map([[1, 5200], [2, null]]))], [[1, 5200]]);
	assert.deepEqual(f.b24Calls, []);
});

test('a cache miss fetches only absent products and does not override ERP price', async () => {
	const f = fixture([{ item_code: '3', price_list_rate: 300 }], { 2: { type: 1, purchasingPrice: 200 } });
	assert.deepEqual([...await fetchDealCatalogPurchasing(f.erp, f.client, [1, 2, 3], new Map([[1, 100], [3, 999]]))], [[3, 300], [1, 100], [2, 200]]);
	assert.deepEqual(f.b24Calls, [[2]]);
});

test('variant inherits its parent price only when its own price is absent', async () => {
	const f = fixture([], {
		1: { type: 4, parentId: { value: 10 }, purchasingPrice: null },
		2: { type: 4, parentId: 10, purchasingPrice: 0 },
		3: { type: 4, parentId: 10, purchasingPrice: '200' },
		10: { type: 3, purchasingPrice: '700' },
	});
	assert.deepEqual([...await fetchDealCatalogPurchasing(f.erp, f.client, [1, 2, 3])], [[1, 700], [2, 0], [3, 200]]);
	assert.deepEqual(f.b24Calls, [[1, 2, 3], [10]]);
});

test('missing and ERP-only cards remain unknown, with no valuation fallback or writes', async () => {
	const f = fixture([], { 1: { type: 1, purchasingPrice: null } });
	assert.deepEqual([...await fetchDealCatalogPurchasing(f.erp, f.client, [1, 2])], []);
});

test('authorization failures do not masquerade as missing purchase prices', async () => {
	const f = fixture([], {}, 'insufficient_scope');
	await assert.rejects(fetchDealCatalogPurchasing(f.erp, f.client, [1]), /Не удалось получить закупочную цену/);
	await assert.rejects(fetchDealCatalogPurchasing(f.erp, null, [1]), /требуется авторизация/);
});

test('Bitrix empty-code missing-product response for ERP-only engineer service is not a batch failure', async () => {
	const f = fixture([], { 15882: { type: 1, purchasingPrice: '5200' } }, '', 'product does not exist.');
	assert.deepEqual([...await fetchDealCatalogPurchasing(f.erp, f.client, [15882, 9814001])], [[15882, 5200]]);
});

test('stock endpoint uses catalog fallback, preserves aliases and respects purchase-price denial', async t => {
	const calls: string[] = [];
	const erp = { async list(doctype: string) {
		calls.push(doctype);
		if (doctype === 'Company') return [{ name: 'Test', abbr: 'T' }];
		if (doctype === 'Bin') return [{ item_code: '16832', warehouse: 'Main - T', actual_qty: 2 }];
		if (doctype === 'Item Price') return [];
		throw new Error('Unexpected read: ' + doctype);
	} } as unknown as ErpClient;
	t.mock.method(RuntimeErpClient, 'fromEnv', () => erp);
	for (const denied of [false, true]) {
		const app = Fastify();
		app.decorate('config', { portalDomain: 'example.bitrix24.ru' } as typeof app.config);
		if (denied) app.addHook('preHandler', async request => {
			request.appAccess = { decisions: { 'catalog.view_purchase_prices': 'deny' } } as typeof request.appAccess;
		});
		baseCache.set('example.bitrix24.ru', { expires: Date.now() + 60000, data: { rows: [{ id: 16832, purchase: 5200 }] as never[], generatedAt: new Date().toISOString() } });
		registerCatalogErpStockRoute(app);
		try {
			const before = calls.filter(c => c === 'Item Price').length;
			const response = await app.inject({ method: 'POST', url: '/api/catalog/erp-stocks', payload: { domain: 'example.bitrix24.ru', productIds: [16680, 16832] } });
			assert.equal(response.statusCode, 200);
			const body = response.json(); assert.equal(body.ok, true);
			assert.equal(body.byProduct[16680].purchasing, denied ? 0 : 5200);
			assert.equal(body.byProduct[16832].purchasing, denied ? 0 : 5200);
			assert.deepEqual(body.byProduct[16832].stocks, { Main: 2 });
			assert.equal(calls.filter(c => c === 'Item Price').length - before, denied ? 0 : 1);
		} finally { await app.close(); baseCache.delete('example.bitrix24.ru'); }
	}
});
