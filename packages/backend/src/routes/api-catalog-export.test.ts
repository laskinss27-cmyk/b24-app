import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import ExcelJS from 'exceljs';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { registerAccessPolicyHook } from '../access-policy-hook.js';
import { registerCatalogExportRoutes } from './api-catalog-export-routes.js';
import { registerCatalogCommercialFieldRoutes } from './api-catalog-commercial-field-routes.js';
import { registerCatalogProductUpdateRoute } from './api-catalog-product-update-route.js';
import { registerCatalogProductCreateRoute } from './api-catalog-product-create-route.js';

async function fixture(t: TestContext) {
	let user = { ID: '3712', UF_DEPARTMENT: [310] };
	let failIdentity = false;
	let erpReads = 0;
	t.mock.method(B24Client.prototype, 'call', async (method: string) => {
		assert.equal(method, 'user.current');
		if (failIdentity) throw new Error('identity unavailable');
		return user;
	});
	t.mock.method(ErpClient, 'fromEnv', () => ({
		get: async () => ({}),
		list: async (type: string) => {
			erpReads++;
			if (type === 'Company') return [{ name: 'Test', abbr: 'T' }];
			if (type === 'Item') return [
				{ name: '101', item_name: 'Private name', b24_article: '001-A', is_stock_item: 1, last_purchase_rate: 700 },
				{ name: '102', item_name: 'No price', b24_article: '=1+1', is_stock_item: 1 },
				{ name: '103', item_name: 'Service', b24_article: 'SERVICE', is_stock_item: 0 },
			];
			if (type === 'Item Price') return [
				{ item_code: '101', price_list: 'Standard Buying', price_list_rate: 700 },
				{ item_code: '101', price_list: 'Standard Selling', price_list_rate: 1200 },
			];
			if (['Warehouse', 'Bin', 'Purchase Receipt', 'Stock Ledger Entry'].includes(type)) return [];
			throw new Error(`unexpected ERP read: ${type}`);
		},
		create: async () => { throw new Error('export must not create'); },
		update: async () => { throw new Error('export must not update'); },
	}));
	const app = Fastify();
	app.decorate('config', { portalDomain: 'test.bitrix24.ru' } as typeof app.config);
	registerAccessPolicyHook(app);
	registerCatalogExportRoutes(app);
	registerCatalogCommercialFieldRoutes(app);
	registerCatalogProductUpdateRoute(app);
	registerCatalogProductCreateRoute(app);
	t.after(() => app.close());
	const call = (extra = {}, url = '/api/catalog/export-marketplace-selection') => app.inject({
		method: 'POST', url, payload: { domain: 'test.bitrix24.ru', accessToken: 'test', marketplaceMode: true, productIds: [101, 102, 103], ...extra },
	});
	return { call, actor: (id: string, departments = [310]) => { user = { ID: id, UF_DEPARTMENT: departments }; },
		fail: () => { failIdentity = true; }, reads: () => erpReads };
}

test('approved identity receives only article and purchase in a real XLSX, preserving selection and missing prices', async (t) => {
	const f = await fixture(t);
	const response = await f.call({ productIds: [102, 101, 101, 103, 999], fullExport: true, articlePurchaseOnly: false });
	assert.equal(response.statusCode, 200, response.body);
	assert.match(response.headers['content-type'] ?? '', /spreadsheetml/);
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(response.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0]);
	assert.equal(workbook.worksheets.length, 1);
	const sheet = workbook.worksheets[0]!;
	assert.equal(sheet.columnCount, 2);
	assert.equal(sheet.rowCount, 3);
	assert.deepEqual(sheet.getRow(1).values, [, 'Артикул', 'Закупка, ₽']);
	assert.equal(sheet.getCell('A2').value, '=1+1');
	assert.equal(sheet.getCell('B2').value, null);
	assert.equal(sheet.getCell('A3').value, '001-A');
	assert.equal(sheet.getCell('B3').value, 700);
	assert.ok(!JSON.stringify(workbook.model).includes('Private name'));
});

test('export permission cannot be spoofed and identity failures do not read ERP', async (t) => {
	const f = await fixture(t);
	assert.equal((await f.call({ marketplaceMode: false })).statusCode, 403);
	f.actor('9999');
	const denied = await f.call({ userId: '3712', ID: '3712', articlePurchaseOnly: true });
	assert.equal(denied.statusCode, 403);
	assert.match(denied.json().error, /Нет доступа/);
	f.actor('3712'); f.fail();
	assert.equal((await f.call()).statusCode, 503);
	assert.equal(f.reads(), 0);
});

test('narrow export does not grant card creation, editing, price editing or catalog comparison', async (t) => {
	const f = await fixture(t);
	for (const route of ['/api/catalog/create-product', '/api/catalog/update-product', '/api/catalog/update-prices', '/api/catalog/update-purchase-price', '/api/catalog/export-comparison']) {
		assert.equal((await f.call({ productId: 101, purchase: 1, retail: 1 }, route)).statusCode, 403, route);
	}
	assert.equal(f.reads(), 0);
});

test('existing supply export retains the full catalog workbook', async (t) => {
	const f = await fixture(t); f.actor('78', [10]);
	const response = await f.call();
	assert.equal(response.statusCode, 200, response.body);
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(response.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0]);
	const sheet = workbook.getWorksheet('Товары')!;
	assert.equal(sheet.getCell('K5').value, 'Закупка, ₽');
	assert.ok(sheet.columnCount > 2);
});
