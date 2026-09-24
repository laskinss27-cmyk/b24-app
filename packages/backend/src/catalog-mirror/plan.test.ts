import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalogMirrorPlan } from './plan.js';
import { catalogMirrorFixture } from './test-fixture.js';

test('catalog mirror plan is deterministic, sorted and hash-addressed', () => {
	const snapshot = catalogMirrorFixture();
	const first = buildCatalogMirrorPlan(snapshot);
	const second = buildCatalogMirrorPlan({
		...snapshot,
		observedAt: '2026-09-03T16:05:00.000Z',
		prices: [...snapshot.prices].reverse(),
	});
	assert.equal(first.snapshotHash, second.snapshotHash);
	assert.match(first.snapshotHash, /^[a-f0-9]{64}$/);
	assert.ok([...first.products, ...first.attributes, ...first.prices, ...first.warehouses, ...first.stocks]
		.every((row) => /^[a-f0-9]{64}$/.test(row.sourceHash)));
	assert.deepEqual(first.prices.map((row) => row.priceKind), ['purchase', 'retail']);
});

test('catalog mirror plan fails closed for incomplete, duplicate and orphan rows', () => {
	const incomplete = catalogMirrorFixture();
	incomplete.sources.bins.complete = false;
	assert.throws(() => buildCatalogMirrorPlan(incomplete), /incomplete/);

	const duplicate = catalogMirrorFixture();
	duplicate.products.push(structuredClone(duplicate.products[0]!));
	assert.throws(() => buildCatalogMirrorPlan(duplicate), /Duplicate catalog mirror product/);

	const orphan = catalogMirrorFixture();
	orphan.stocks[0]!.warehouseName = 'Неизвестный - TEST';
	assert.throws(() => buildCatalogMirrorPlan(orphan), /stock is invalid/);
});
