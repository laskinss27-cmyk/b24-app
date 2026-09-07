import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client, BatchCall } from './client.js';
import type { ErpClient } from '../erp/client.js';
import { buildSalesReport } from './sales-report.js';
import { readConsumablesReportRows } from './sales-report-consumables.js';
import { buildCatalogMirrorPlan } from '../catalog-mirror/plan.js';
import { buildSqlProductBase } from '../catalog-mirror/product-base.js';
import { catalogMirrorFixture } from '../catalog-mirror/test-fixture.js';
import { fetchCoreCatalogItems } from '../erp/stock-catalog.js';

function clientFor(rows: Record<string, unknown>[]): B24Client {
	return {
		async call(method: string) {
			if (method === 'crm.deal.list') return [{ ID: 1, TITLE: 'Test' }];
			if (method === 'app.option.get') return { profit_coef: 0.5 };
			return [];
		},
		async callBatch(calls: Record<string, BatchCall>) {
			return { result: Object.fromEntries(Object.keys(calls).map((key) => [key, key === 'd1' ? rows : { product: { purchasingPrice: 100 } }])) };
		},
	} as unknown as B24Client;
}

test('sales report retains revenue but awards no profit to stock or legacy-service consumables', async () => {
	const rows = [
		{ PRODUCT_ID: 18612, TYPE: 4, PRICE: 10000, QUANTITY: 2 },
		{ PRODUCT_ID: 9254, TYPE: 7, PRICE: 9000, QUANTITY: 1 },
		{ PRODUCT_ID: 101, TYPE: 1, PRICE: 300, QUANTITY: 2 },
		{ PRODUCT_ID: 102, TYPE: 7, PRICE: 1000, QUANTITY: 1 },
	];
	const data = await buildSalesReport(clientFor(rows), { from: '2026-09-01', to: '2026-09-07' }, null);
	assert.equal(data.rows[0]!.goodsSum, 20600);
	assert.equal(data.rows[0]!.worksSum, 10000);
	assert.equal(data.rows[0]!.goodsProfit, 400);
	assert.equal(data.rows[0]!.worksProfit, 500);
	assert.equal(data.rows[0]!.goodsNoPurchase, 0);
});

function erpFixture(totalMismatch = false): ErpClient {
	return {
		async get(doctype: string) {
			assert.equal(doctype, 'Sales Order');
			return { items: [{ item_code: '18612', qty: 3, rate: totalMismatch ? 9999 : 10000 }, { item_code: '101', qty: 1, rate: 300 }],
				b24_deal_stages: JSON.stringify([{ items: [{ productId: 18612, qty: 2, price: 2000, discountPercent: 25 }] }]) };
		},
		async list(doctype: string) {
			if (doctype === 'Sales Order') return [{ name: 'SO-test' }];
			if (doctype === 'Item') return [{ name: '18612', is_stock_item: 1 }, { name: '101', is_stock_item: 1 }];
			if (doctype === 'Item Price') return [{ item_code: '101', price_list_rate: 100 }];
			throw new Error(`Unexpected read: ${doctype}`);
		},
		async create() { throw new Error('Read-only report must not create anything'); },
		async update() { throw new Error('Read-only report must not update anything'); },
	} as unknown as ErpClient;
}

test('collapsed core deal expands discounted stages before report profit is calculated', async () => {
	const rows = [{ PRODUCT_ID: 9814, TYPE: 7, PRICE: 13300, QUANTITY: 1 }];
	const data = await buildSalesReport(clientFor(rows), { from: '2026-09-01', to: '2026-09-07' }, erpFixture());
	assert.equal(data.rows[0]!.goodsSum, 13300);
	assert.equal(data.rows[0]!.goodsProfit, 200);
	assert.equal(data.rows[0]!.worksProfit, 0);
	assert.equal(data.rows[0]!.goodsNoPurchase, 0);
});

test('a stale core total cannot produce a confidently incorrect profit', async () => {
	await assert.rejects(readConsumablesReportRows(erpFixture(true), 1, [{ PRODUCT_ID: 9814, PRICE: 13300, QUANTITY: 1 }]), /не совпадает/u);
});

test('ordinary report rows do not trigger additional core queries', async () => {
	assert.equal(await readConsumablesReportRows(erpFixture(), 1, [{ PRODUCT_ID: 101, PRICE: 100, QUANTITY: 1 }]), null);
});

test('SQL selection hides only the service duplicate without mutating mirrored history or stock', () => {
	const fixture = catalogMirrorFixture();
	fixture.products.push({ ...fixture.products[0]!, itemCode: 9254, itemName: 'Расходные материалы', isStockItem: false });
	fixture.products.push({ ...fixture.products[0]!, itemCode: 18612, itemName: 'Расходные материалы' });
	const plan = buildCatalogMirrorPlan(fixture);
	const before = JSON.stringify(plan);
	const ids = buildSqlProductBase(plan).data.rows.map((row) => row.id);
	assert.deepEqual(ids.sort((a, b) => a - b), [101, 18612]);
	assert.equal(JSON.stringify(plan), before);
});

test('core fallback selection hides the same duplicate without disabling its ERP Item', async () => {
	const erp = { async get() { return {}; }, async list() { return [{ name: '9254', item_name: 'Расходные материалы', is_stock_item: 0 }, { name: '18612', item_name: 'Расходные материалы', is_stock_item: 1 }]; } } as unknown as ErpClient;
	assert.deepEqual((await fetchCoreCatalogItems(erp)).map((item) => item.productId), [18612]);
});
