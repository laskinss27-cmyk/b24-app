import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { registerCatalogCommercialFieldRoutes } from './api-catalog-commercial-field-routes.js';
import { registerStockDocumentCreationRoute } from './api-stock-document-creation-route.js';

test('supply can update purchase price without cancelling a receipt or changing retail', async (t) => {
	let department = 10;
	const writes: unknown[] = [];
	const events: unknown[] = [];
	t.mock.method(B24Client.prototype, 'call', async () => ({ ID: '78', NAME: 'Даниил', UF_DEPARTMENT: [department] }));
	t.mock.method(ErpClient, 'fromEnv', () => ({
		get: async () => ({}),
		list: async (type: string, fields: string[]) => type === 'Item Price'
			? fields.includes('price_list_rate') ? [{ item_code: '27112', price_list_rate: 23632 }] : [{ name: 'BUY-1' }]
			: [{ name: '27112', valuation_rate: 0, last_purchase_rate: 23632 }],
		update: async (type: string, name: string, fields: unknown) => { writes.push({ type, name, fields }); return {}; },
	}));
	const app = Fastify();
	app.decorate('config', { portalDomain: 'test.bitrix24.ru' } as typeof app.config);
	app.decorate('operationLog', { record: async (event: unknown) => { events.push(event); } } as unknown as typeof app.operationLog);
	registerCatalogCommercialFieldRoutes(app);
	t.after(() => app.close());
	const payload = { domain: 'test.bitrix24.ru', accessToken: 'test', productId: 27112, purchase: 17902 };
	const response = await app.inject({ method: 'POST', url: '/api/catalog/update-purchase-price', payload });
	assert.equal(response.json().ok, true);
	assert.deepEqual(writes, [{ type: 'Item Price', name: 'BUY-1', fields: { price_list_rate: 17902, currency: 'RUB' } }]);
	assert.equal(events.length, 1);
	for (const purchase of [null, '', -1, 0, .01, 'wrong']) {
		const invalid = await app.inject({ method: 'POST', url: '/api/catalog/update-purchase-price', payload: { ...payload, purchase } });
		assert.equal(invalid.statusCode, 400);
	}
	department = 99;
	assert.equal((await app.inject({ method: 'POST', url: '/api/catalog/update-purchase-price', payload })).statusCode, 403);
	assert.equal(writes.length, 1, 'denied and invalid requests cannot write prices');
});

test('creating a receipt draft preserves current purchase price while storing its planned cost', async (t) => {
	const writes: Array<{ type: string; fields: Record<string, unknown> }> = [];
	t.mock.method(B24Client.prototype, 'call', async () => ({ ID: '78', UF_DEPARTMENT: [10] }));
	t.mock.method(ErpClient, 'fromEnv', () => ({
		get: async () => ({}),
		list: async (type: string) => {
			if (type === 'Company') return [{ name: 'Test Company', abbr: 'TC' }];
			if (type === 'Item Price') return [{ name: 'SELL-1' }];
			throw new Error(`unexpected read ${type}`);
		},
		create: async (type: string, fields: Record<string, unknown>) => { writes.push({ type, fields }); return { name: 'PR-DRAFT' }; },
		update: async (type: string, _name: string, fields: Record<string, unknown>) => { writes.push({ type, fields }); return {}; },
	}));
	const app = Fastify();
	app.decorate('config', { portalDomain: 'test.bitrix24.ru' } as typeof app.config);
	registerStockDocumentCreationRoute(app);
	t.after(() => app.close());
	const response = await app.inject({ method: 'POST', url: '/api/stock/create', payload: {
		domain: 'test.bitrix24.ru', accessToken: 'test', kind: 'receipt', toStore: 'Receiving',
		lines: [{ productId: 1, qty: 2, purchase: 3500, retail: 5000 }],
	} });
	assert.equal(response.json().ok, true, response.body);
	assert.deepEqual(writes, [
		{ type: 'Purchase Receipt', fields: {
			company: 'Test Company', supplier: 'Б24 Снабжение', set_posting_time: 1,
			items: [{ item_code: '1', qty: 2, warehouse: 'Receiving - TC', rate: 3500 }],
		} },
		{ type: 'Item Price', fields: { price_list_rate: 5000, currency: 'RUB' } },
	]);
});
