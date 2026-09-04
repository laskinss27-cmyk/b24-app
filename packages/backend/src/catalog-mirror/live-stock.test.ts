import assert from 'node:assert/strict';
import test from 'node:test';
import { coreStoreId } from '../erp/operations.js';
import type { CatalogProductBase } from './live-stock.js';
import { applyLiveCatalogStock, liveCatalogStockFromBase } from './live-stock.js';

function base(): CatalogProductBase {
	return {
		data: {
			generatedAt: 'snapshot',
			rows: [{
				id: 101,
				iblockId: 24,
				name: 'Монитор',
				isService: false,
				isMarketplaceBundle: false,
				marketplaceOldId: '',
				retail: 1_200,
				purchase: 800,
				total: 3,
				stockByStore: { [coreStoreId('Старый склад')]: 3 },
			}],
		},
		stores: [{ id: coreStoreId('Старый склад'), title: 'Старый склад', active: true }],
	};
}

test('live ERP stock replaces SQL snapshot stock and keeps catalog metadata intact', () => {
	const snapshot = base();
	const result = applyLiveCatalogStock(snapshot, {
		stocks: new Map([[101, { 'Дунайский': 2, 'Новый склад': 1 }]]),
		storeTitles: ['Новый склад', 'Дунайский'],
		generatedAt: 'live',
	});

	assert.equal(result.data.generatedAt, 'live');
	assert.deepEqual(result.stores.map((store) => store.title), ['Дунайский', 'Новый склад']);
	assert.equal(result.data.rows[0]?.retail, 1_200);
	assert.equal(result.data.rows[0]?.purchase, 800);
	assert.equal(result.data.rows[0]?.total, 3);
	assert.deepEqual(result.data.rows[0]?.stockByStore, {
		[coreStoreId('Дунайский')]: 2,
		[coreStoreId('Новый склад')]: 1,
	});
	assert.equal(snapshot.data.generatedAt, 'snapshot');
	assert.deepEqual(Object.values(snapshot.data.rows[0]!.stockByStore), [3]);
});

test('shadow stock projection reproduces the exact live base quantities', () => {
	const live = base();
	const sql = base();
	sql.data.rows[0]!.stockByStore = {};
	sql.data.rows[0]!.total = 0;
	const result = applyLiveCatalogStock(sql, liveCatalogStockFromBase(live));
	assert.deepEqual(result, live);
});
