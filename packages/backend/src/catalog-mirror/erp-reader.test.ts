import assert from 'node:assert/strict';
import test from 'node:test';
import type { ErpClient } from '../erp/client.js';
import { readErpCatalogMirrorSnapshot } from './erp-reader.js';

test('ERP catalog mirror reader uses complete official API collections and normalizes rows', async () => {
	const calls: string[] = [];
	const erp = {
		list: async (doctype: string) => {
			calls.push(doctype);
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Item') return [{
				name: '101', item_name: 'Монитор [Сток]', is_stock_item: 1, modified: '2026-09-03 15:00:00.000000',
				b24_article: 'MON-1', b24_model: 'M1', b24_brand: 'Test', b24_section: 'Мониторы',
				b24_product_status: '', b24_filter_category: 'Мониторы', description: 'Описание', image: '/files/m.jpg',
				b24_marketplace_bundle_source: '', b24_marketplace_old_id: 'old-101',
				b24_catalog_content: JSON.stringify({ version: 1, summary: 'Коротко', attributes: [{
					id: 'screen:1', key: 'screen', label: 'Диагональ', group: 'Экран', type: 'number',
					rawValue: '24', normalizedValue: '24', numberValue: 24, unit: 'дюйм', filterable: true,
				}] }),
			}];
			if (doctype === 'Item Price') return [
				{ item_code: '101', price_list: 'Standard Selling', price_list_rate: 1100, currency: 'RUB', modified: '2026-09-03 14:00:00' },
				{ item_code: '101', price_list: 'Standard Selling', price_list_rate: 1200, currency: 'RUB', modified: '2026-09-03 15:00:00' },
				{ item_code: '101', price_list: 'Standard Buying', price_list_rate: 800, currency: 'RUB', modified: '2026-09-03 15:00:00' },
			];
			if (doctype === 'Bin') return [{ item_code: '101', warehouse: 'Основной - TEST', actual_qty: 3, modified: '2026-09-03 15:00:00' }];
			if (doctype === 'Warehouse') return [
				{ name: 'Основной - TEST', warehouse_type: '', is_group: 0, disabled: 0, modified: '2026-09-03 15:00:00' },
				{ name: 'Transit - TEST', warehouse_type: 'Transit', is_group: 0, disabled: 0, modified: '2026-09-03 15:00:00' },
			];
			return [];
		},
	} as unknown as ErpClient;

	const snapshot = await readErpCatalogMirrorSnapshot(erp, new Date('2026-09-03T16:00:00.000Z'));
	assert.deepEqual(calls.sort(), ['Bin', 'Company', 'Item', 'Item Price', 'Warehouse'].sort());
	assert.equal(snapshot.products[0]?.itemName, 'Монитор');
	assert.equal(snapshot.products[0]?.productStatus, 'Сток');
	assert.equal(snapshot.attributes[0]?.numberValue, 24);
	assert.deepEqual(snapshot.prices.map((row) => [row.priceKind, row.rate]).sort(), [['purchase', 800], ['retail', 1200]]);
	assert.deepEqual(snapshot.warehouses.map((row) => row.displayTitle), ['Основной']);
	assert.equal(snapshot.stocks[0]?.actualQty, 3);
	assert.deepEqual(snapshot.sources, {
		items: { complete: true, records: 1 }, prices: { complete: true, records: 3 },
		bins: { complete: true, records: 1 }, warehouses: { complete: true, records: 2 },
		bitrix: { complete: false, records: 0 },
	});
});
