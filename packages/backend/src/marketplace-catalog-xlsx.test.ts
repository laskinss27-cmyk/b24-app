import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogExportStoreIds } from './catalog-store-ids.js';
import { createMarketplaceCatalogWorkbook, marketplaceCatalogItemType } from './marketplace-catalog-xlsx.js';

const CORE_STORE_ID = -1366325545;

test('marketplace catalog export accepts negative core warehouse ids', () => {
	assert.deepEqual(
		[...catalogExportStoreIds([CORE_STORE_ID, '-1473378028', 12, 0, 1.5, 'bad', CORE_STORE_ID])],
		[CORE_STORE_ID, -1473378028, 12],
	);
	assert.deepEqual([...catalogExportStoreIds(null)], []);
});

test('marketplace catalog export keeps bundle type and selected warehouse stocks', async () => {
	const workbook = createMarketplaceCatalogWorkbook({
		rows: [
			{
				id: 101,
				iblockId: 24,
				name: 'Обычный товар',
				isService: false,
				isMarketplaceBundle: false,
				marketplaceOldId: 'OLD-101',
				sectionName: 'Камеры',
				retail: 1000,
				purchase: 700,
				total: 8,
				stockByStore: { [CORE_STORE_ID]: 3, 12: 5 },
			},
			{
				id: 202,
				iblockId: 24,
				name: 'Комплект MODEL 2 шт',
				isService: false,
				isMarketplaceBundle: true,
				marketplaceOldId: 'KIT-202',
				sectionName: 'Комплекты',
				retail: 2500,
				purchase: 1400,
				total: 2,
				stockByStore: { [CORE_STORE_ID]: 2, 12: 0 },
			},
		],
		stores: [{ id: CORE_STORE_ID, title: 'Маркетплейс' }],
		selectedStoreLabel: 'Маркетплейс',
		selectedSectionLabel: 'Все группы',
		search: '',
		onlyStock: true,
		createdAt: new Date('2026-07-31T09:00:00Z'),
	});
	const sheet = workbook.getWorksheet('Товары');
	assert.ok(sheet);
	assert.equal(sheet.getCell('A6').value, 'Товар');
	assert.equal(sheet.getCell('A7').value, 'Комплект');
	assert.equal(sheet.getCell('B7').value, 'KIT-202');
	assert.equal(sheet.getCell('L6').value, 3);
	assert.deepEqual(sheet.getCell('M6').value, { formula: 'SUM(L6:L6)', result: 3 });
	assert.equal(marketplaceCatalogItemType({ isMarketplaceBundle: true }), 'Комплект');
	assert.equal(marketplaceCatalogItemType({ isMarketplaceBundle: false }), 'Товар');
	const saved = await workbook.xlsx.writeBuffer();
	assert.ok(saved.byteLength > 5_000);
});
