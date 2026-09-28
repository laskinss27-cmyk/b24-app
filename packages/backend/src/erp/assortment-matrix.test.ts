import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAssortmentMatrixReport, matrixRecommendation } from './assortment-matrix.js';
import { ErpApiError, ErpClient } from './client.js';

test('матрица: 1000 товаров и длинные названия складов не превышают HTTP-лимит и не теряют движения', async (t) => {
	const erp = new ErpClient({ url: 'http://erp.test', token: 'token test' });
	const items = Array.from({ length: 1000 }, (_, i) => ({ productId: 10000 + i, category: 'Камеры', segment: 'Основной', toOrderQty: 0, comment: '' }));
	const stores = Array.from({ length: 20 }, (_, i) => `Магазин на Железноводской улице, секция ${i + 1}`);
	const warehouses = stores.map((store) => `${store} - TEST`);
	const codes = items.map((item) => String(item.productId));
	const bins = codes.flatMap((item_code) => warehouses.map((warehouse) => ({ item_code, warehouse, actual_qty: 5, reserved_qty: 1 })));
	const ledger = codes.flatMap((item_code) => warehouses.flatMap((warehouse) => [
		{ item_code, warehouse, actual_qty: -3 }, { item_code, warehouse, actual_qty: -3 },
	]));
	t.mock.method(erp, 'request', async (method: string, path: string) => {
		assert.equal(method, 'GET');
		if (Buffer.byteLength(`GET ${path} HTTP/1.1`) > 4094) throw new ErpApiError(method, path, 400, 'Request Line is too large');
		const url = new URL(path, 'http://erp.test');
		const doctype = decodeURIComponent(url.pathname.split('/')[3]!);
		const filters = JSON.parse(url.searchParams.get('filters') ?? '[]') as unknown[][];
		const included = (field: string, value: string) => {
			const filter = filters.find((f) => f[0] === field && f[1] === 'in');
			return !filter || (filter[2] as string[]).includes(value);
		};
		let data: unknown;
		if (doctype === 'Company') data = [{ name: 'Test Company', abbr: 'TEST' }];
		else if (doctype === 'Warehouse') data = warehouses.map((name) => ({ name }));
		else if (doctype === 'Item') data = codes.filter((name) => included('name', name)).map((name) => ({ name, item_name: name, is_stock_item: 1 }));
		else if (doctype === 'Purchase Order') data = [];
		else if (doctype === 'Bin') data = bins.filter((row) => included('item_code', row.item_code) && included('warehouse', row.warehouse));
		else if (doctype === 'Stock Ledger Entry') {
			for (const expected of [['posting_date', '>=', '2026-09-01'], ['posting_date', '<=', '2026-09-30'], ['voucher_type', '=', 'Delivery Note'], ['is_cancelled', '=', 0]]) {
				assert.ok(filters.some((f) => JSON.stringify(f) === JSON.stringify(expected)));
			}
			data = ledger.filter((row) => included('item_code', row.item_code) && included('warehouse', row.warehouse));
		} else assert.fail(`unexpected doctype: ${doctype}`);
		return { status: 200, json: { data } };
	});
	const report = await buildAssortmentMatrixReport(erp, { from: '2026-09-01', to: '2026-09-30', selectedStores: stores.slice(0, 10), salesScope: 'all', items });
	assert.equal(report.rows.length, 1000);
	for (const row of report.rows) {
		assert.equal(row.totalStock, 50);
		assert.equal(row.reservedQty, 10);
		assert.equal(row.soldQty, 120, 'identical-looking ledger entries must both count');
		assert.equal(row.recommendedQty, 200);
		assert.deepEqual(Object.values(row.stocks), Array(10).fill(5));
	}
});

test('матрица рекомендует запас на 60 дней и вычитает свободный остаток с заказанным', () => {
	assert.equal(matrixRecommendation({ soldQty: 90, periodDays: 90, freeQty: 20, orderedQty: 10 }), 30);
});

test('матрица округляет потребность вверх', () => {
	assert.equal(matrixRecommendation({ soldQty: 7, periodDays: 30, freeQty: 3, orderedQty: 0 }), 11);
});

test('матрица не предлагает отрицательный заказ и не выдумывает спрос без продаж', () => {
	assert.equal(matrixRecommendation({ soldQty: 5, periodDays: 30, freeQty: 20, orderedQty: 4 }), 0);
	assert.equal(matrixRecommendation({ soldQty: 0, periodDays: 30, freeQty: -2, orderedQty: 0 }), 0);
});
