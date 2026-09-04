import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalogMirrorPlan } from '../catalog-mirror/plan.js';
import { catalogMirrorFixture } from '../catalog-mirror/test-fixture.js';
import { cachedSqlProductBase, readCachedSqlProductBase } from './api-catalog-browse-routes.js';

test('SQL catalog cache returns an independent copy before a deal reservation overlay mutates it', () => {
	const plan = buildCatalogMirrorPlan(catalogMirrorFixture());
	const first = cachedSqlProductBase(plan, true, 1_000);
	const storeId = Number(Object.keys(first.value.data.rows[0]!.stockByStore)[0]);
	first.value.data.rows[0]!.stockByStore[storeId] = 1;
	Object.assign(first.value.data.rows[0]!, { reservedByStore: { 1: 2 } });
	const second = cachedSqlProductBase(plan, false, 1_001);
	assert.equal(second.cached, true);
	assert.deepEqual(Object.values(second.value.data.rows[0]!.stockByStore), [3]);
	assert.equal('reservedByStore' in second.value.data.rows[0]!, false);
});

test('fresh SQL catalog cache avoids rereading all normalized mirror tables', async () => {
	const plan = buildCatalogMirrorPlan(catalogMirrorFixture());
	let reads = 0;
	const reader = async () => {
		reads += 1;
		return plan;
	};
	const first = await readCachedSqlProductBase(reader, true, 10_000);
	const second = await readCachedSqlProductBase(reader, false, 10_001);
	assert.equal(first.cached, false);
	assert.equal(second.cached, true);
	assert.equal(reads, 1);
});
