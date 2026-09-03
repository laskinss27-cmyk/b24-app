import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCatalogMirrorMetadata } from './source-reader.js';
import { catalogMirrorFixture } from './test-fixture.js';

test('complete catalog source merges Bitrix identity, photo and missing price fallbacks without mutating ERP rows', () => {
	const snapshot = catalogMirrorFixture();
	snapshot.products[0] = {
		...snapshot.products[0]!,
		bitrixIblockId: 24,
		bitrixSectionId: null,
		article: '',
		imagePath: '',
		imageSource: 'none',
	};
	snapshot.prices = snapshot.prices.filter((row) => row.priceKind === 'purchase');
	const original = structuredClone(snapshot);
	const result = mergeCatalogMirrorMetadata(snapshot, {
		generatedAt: '2026-09-03T16:00:00.000Z',
		rows: [{
			id: 101,
			iblockId: 26,
			name: 'Монитор Bitrix',
			isService: false,
			article: 'B24-101',
			model: ' M1 with spacing ',
			sectionId: 77,
			sectionName: 'Мониторы',
			retail: 1500,
			purchase: 900,
			photoPath: 'https://portal.example/photo.jpg',
			total: 0,
			stockByStore: {},
		}],
	});

	assert.deepEqual(snapshot, original);
	assert.equal(result.sources.bitrix.complete, true);
	assert.equal(result.products[0]?.bitrixIblockId, 26);
	assert.equal(result.products[0]?.bitrixSectionId, 77);
	assert.equal(result.products[0]?.article, 'B24-101');
	assert.equal(result.products[0]?.model, 'M1');
	assert.equal(result.products[0]?.imageSource, 'bitrix');
	assert.equal(result.products[0]?.imagePath, 'https://portal.example/photo.jpg');
	assert.deepEqual(result.prices.map((row) => [row.priceKind, row.rate, row.sourceSystem]), [
		['purchase', 800, 'erpnext'],
		['retail', 1500, 'bitrix'],
	]);
});

test('Bitrix fallback metadata keeps the exact value returned by the current live catalog builder', () => {
	const snapshot = catalogMirrorFixture();
	snapshot.products[0]!.model = '';
	const result = mergeCatalogMirrorMetadata(snapshot, {
		generatedAt: '',
		rows: [{
			id: 101, iblockId: 24, name: 'Монитор', isService: false,
			model: 'M1 ', retail: null, purchase: null, total: 0, stockByStore: {},
		}],
	});
	assert.equal(result.products[0]?.model, 'M1 ');
});

test('complete catalog source fails closed when Bitrix metadata is empty', () => {
	assert.throws(
		() => mergeCatalogMirrorMetadata(catalogMirrorFixture(), { rows: [], generatedAt: '' }),
		/metadata is empty/,
	);
});
