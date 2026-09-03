import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCatalogMirrorBases } from './compare.js';
import { buildCatalogMirrorPlan } from './plan.js';
import { buildSqlProductBase } from './product-base.js';
import { catalogMirrorFixture } from './test-fixture.js';

test('catalog shadow comparison detects missing and user-visible differences', () => {
	const sql = buildSqlProductBase(buildCatalogMirrorPlan(catalogMirrorFixture()));
	assert.equal(compareCatalogMirrorBases(sql, sql).match, true);
	const changed = structuredClone(sql);
	changed.data.rows[0]!.retail = 999;
	assert.deepEqual(compareCatalogMirrorBases(changed, sql), {
		match: false,
		liveProducts: 1,
		sqlProducts: 1,
		liveStores: 1,
		sqlStores: 1,
		missingInSql: 0,
		extraInSql: 0,
		differentProducts: 1,
	});
	changed.data.rows = [];
	const missing = compareCatalogMirrorBases(changed, sql);
	assert.equal(missing.extraInSql, 1);
});
