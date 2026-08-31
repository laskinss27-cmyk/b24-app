import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTildaAvailabilityProjection } from './availability-projection.js';
import type { TildaPublicAvailabilityRow } from './public-catalog.js';
import type { TildaProductMapping, TildaStockOffer } from './stock-projection.js';

const mapping = (patch: Partial<TildaProductMapping>): TildaProductMapping => ({
	productId: 1,
	tildaUid: 'edition-1',
	externalId: 'edition-external-1',
	sku: 'sku-1',
	title: 'Product',
	status: 'confirmed',
	rowKind: 'parent',
	parentTildaUid: null,
	...patch,
});

const offer = (patch: Partial<TildaStockOffer>): TildaStockOffer => ({
	productId: 1,
	tildaUid: 'edition-1',
	externalId: 'edition-external-1',
	sku: 'sku-1',
	title: 'Product',
	quantity: 0,
	...patch,
});

const publicRow = (patch: Partial<TildaPublicAvailabilityRow>): TildaPublicAvailabilityRow => ({
	tildaUid: 'edition-1',
	externalId: 'parent-external-1',
	title: 'Product',
	availability: 'В наличии',
	editionUids: ['edition-1'],
	...patch,
});

test('availability projection derives a direct product from its Shelly quantity', () => {
	const projection = buildTildaAvailabilityProjection(
		[mapping({})],
		[offer({ quantity: 0 })],
		[publicRow({ availability: 'В наличии' })],
	);
	assert.equal(projection.targets[0]?.availability, 'Под заказ');
	assert.equal(projection.differences.length, 1);
});

test('availability projection marks a variant parent in stock when any edition is positive', () => {
	const mappings = [
		mapping({ tildaUid: 'edition-a', rowKind: 'variant', parentTildaUid: 'parent', productId: 1 }),
		mapping({ tildaUid: 'edition-b', rowKind: 'variant', parentTildaUid: 'parent', productId: 2 }),
	];
	const projection = buildTildaAvailabilityProjection(mappings, [
		offer({ tildaUid: 'edition-a', quantity: 0, productId: 1 }),
		offer({ tildaUid: 'edition-b', quantity: 4, productId: 2 }),
	], [publicRow({ tildaUid: 'parent', editionUids: ['edition-b', 'edition-a'], availability: 'Под заказ' })]);
	assert.equal(projection.targets[0]?.availability, 'В наличии');
	assert.deepEqual(projection.targets[0]?.editionUids, ['edition-a', 'edition-b']);
});

test('availability projection ignores groups absent from ERP and never converts them to zero', () => {
	const projection = buildTildaAvailabilityProjection(
		[mapping({ status: 'ignored', productId: 0 })],
		[],
		[publicRow({})],
	);
	assert.equal(projection.targets.length, 0);
	assert.deepEqual(projection.skipped, [{ parentTildaUid: 'edition-1', reason: 'mapping_not_confirmed', statuses: ['ignored'] }]);
});

test('availability projection fails closed for incomplete ERP reads or changed variant topology', () => {
	const variant = mapping({ tildaUid: 'edition-a', rowKind: 'variant', parentTildaUid: 'parent' });
	assert.throws(() => buildTildaAvailabilityProjection(
		[variant], [], [publicRow({ tildaUid: 'parent', editionUids: ['edition-a'] })],
	), /no complete Shelly stock projection/u);
	assert.throws(() => buildTildaAvailabilityProjection(
		[variant], [offer({ tildaUid: 'edition-a' })], [publicRow({ tildaUid: 'parent', editionUids: ['edition-a', 'edition-b'] })],
	), /changed edition topology/u);
});
