import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalogMirrorPlan } from './plan.js';
import { buildSqlProductBase } from './product-base.js';
import { catalogMirrorFixture } from './test-fixture.js';

test('SQL catalog mirror reconstructs the current catalog API contract', () => {
	const result = buildSqlProductBase(buildCatalogMirrorPlan(catalogMirrorFixture()));
	assert.deepEqual(result.stores.map((store) => store.title), ['Основной']);
	const row = result.data.rows[0]!;
	assert.equal(row.id, 101);
	assert.equal(row.iblockId, 26);
	assert.equal(row.name, 'Монитор');
	assert.equal(row.sectionId, 77);
	assert.equal(row.retail, 1200);
	assert.equal(row.purchase, 800);
	assert.equal(row.total, 3);
	assert.deepEqual(Object.values(row.stockByStore), [3]);
	assert.equal(row.content?.summary, 'Коротко');
	assert.equal(row.content?.attributes[0]?.label, 'Диагональ');
	assert.equal(row.photoPath, '/api/inventory/erp-image?p=%2Ffiles%2Fmonitor.jpg');
});

test('SQL catalog mirror preserves an empty content object and derives a section id when Bitrix has none', () => {
	const fixture = catalogMirrorFixture();
	fixture.products[0]!.bitrixSectionId = null;
	fixture.products[0]!.contentSummary = '';
	fixture.products[0]!.contentPresent = true;
	fixture.attributes = [];
	const row = buildSqlProductBase(buildCatalogMirrorPlan(fixture)).data.rows[0]!;
	assert.equal(typeof row.sectionId, 'number');
	assert.deepEqual(row.content, { version: 1, summary: '', attributes: [] });
});
