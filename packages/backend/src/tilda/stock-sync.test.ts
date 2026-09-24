import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTildaOffersXml } from './commerce-ml.js';
import { buildTildaStockPreview, type TildaProductMapping } from './stock-projection.js';

const confirmed = (patch: Partial<TildaProductMapping> = {}): TildaProductMapping => ({
	productId: 18178,
	tildaUid: '390763619852',
	externalId: 'g8uv6mzPGYZLy70XvjX0',
	sku: '111024',
	title: 'Shelly BLU Door/Window — Коричневый',
	status: 'confirmed',
	...patch,
});

test('Tilda stock preview sums sellable stores and excludes incoming and transit stock', () => {
	const preview = buildTildaStockPreview([confirmed()], new Map([
		[18178, {
			Shelly: 3,
			'Максидом Дунайский 64': 2,
			'Склад Прихода': 20,
			'Goods In Transit': 10,
		}],
	]));

	assert.equal(preview.offers[0]?.quantity, 5);
	assert.deepEqual(preview.excludedStores, ['Goods In Transit', 'Склад Прихода']);
});

test('Tilda stock preview floors fractional stock and never publishes a negative quantity', () => {
	const previews = [
		buildTildaStockPreview([confirmed()], new Map([[18178, { Shelly: 3.9 }]])),
		buildTildaStockPreview([confirmed()], new Map([[18178, { Shelly: -2 }]])),
	];

	assert.deepEqual(previews.map((preview) => preview.offers[0]?.quantity), [3, 0]);
});

test('unconfirmed mappings never enter the outgoing Tilda offer list', () => {
	const preview = buildTildaStockPreview([
		confirmed(),
		confirmed({ productId: 18124, tildaUid: '2', externalId: 'unresolved', status: 'unresolved' }),
		confirmed({ productId: 999, tildaUid: '3', externalId: 'ignored', status: 'ignored' }),
	], new Map([[18178, { Shelly: 1 }]]));

	assert.deepEqual(preview.offers.map((offer) => offer.productId), [18178]);
	assert.deepEqual(preview.skipped.map((mapping) => mapping.status), ['unresolved', 'ignored']);
});

test('confirmed mappings reject duplicate Tilda identifiers', () => {
	assert.throws(() => buildTildaStockPreview([
		confirmed(),
		confirmed({ productId: 18124, tildaUid: 'other', externalId: 'g8uv6mzPGYZLy70XvjX0' }),
	], new Map()), /duplicate Tilda external id/u);
});

test('CommerceML contains only identifiers, labels and non-negative quantities', () => {
	const xml = buildTildaOffersXml([
		{
			...confirmed(),
			quantity: 5,
			title: 'Shelly <BLU> & Door/Window',
		},
	], new Date('2026-08-20T08:00:00.000Z'));

	assert.match(xml, /<Ид>g8uv6mzPGYZLy70XvjX0<\/Ид>/u);
	assert.match(xml, /<Количество>5<\/Количество>/u);
	assert.match(xml, /Shelly &lt;BLU&gt; &amp; Door\/Window/u);
	assert.doesNotMatch(xml, /<Цена>/u);
	assert.doesNotMatch(xml, /<Описание>/u);
});

test('CommerceML rejects invalid quantities before a request can be sent', () => {
	assert.throws(() => buildTildaOffersXml([{ ...confirmed(), quantity: -1 }]), /invalid Tilda quantity/u);
	assert.throws(() => buildTildaOffersXml([{ ...confirmed(), quantity: 1.5 }]), /invalid Tilda quantity/u);
});
