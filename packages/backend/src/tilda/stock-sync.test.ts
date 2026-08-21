import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTildaCatalogCanaryXml, buildTildaCatalogProductsXml, buildTildaOffersXml } from './commerce-ml.js';
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

test('CommerceML contains only external identifiers and non-negative quantities', () => {
	const xml = buildTildaOffersXml([
		{
			...confirmed(),
			quantity: 5,
		},
	], new Date('2026-08-20T08:00:00.000Z'));

	assert.match(xml, /<КоммерческаяИнформация xmlns="urn:1C\.ru:commerceml_2" xmlns:xs="http:\/\/www\.w3\.org\/2001\/XMLSchema" xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/u);
	assert.match(xml, /<Ид>g8uv6mzPGYZLy70XvjX0<\/Ид>/u);
	assert.match(xml, /<Количество>5<\/Количество>/u);
	assert.match(xml, /<ПакетПредложений СодержитТолькоИзменения="true">/u);
	assert.doesNotMatch(xml, /ИзмененияПакетаПредложений/u);
	assert.match(xml, /<Наименование>b24-app stock only<\/Наименование>/u);
	assert.equal(xml.match(/<Наименование>/gu)?.length, 1);
	assert.doesNotMatch(xml, /Shelly|111024|Артикул/u);
	assert.doesNotMatch(xml, /<Цена>/u);
	assert.doesNotMatch(xml, /<Описание>/u);
});

test('CommerceML rejects invalid quantities before a request can be sent', () => {
	assert.throws(() => buildTildaOffersXml([{ ...confirmed(), quantity: -1 }]), /invalid Tilda quantity/u);
	assert.throws(() => buildTildaOffersXml([{ ...confirmed(), quantity: 1.5 }]), /invalid Tilda quantity/u);
});

test('CommerceML canary catalog contains exactly one existing product with only mandatory identity fields', () => {
	const xml = buildTildaCatalogCanaryXml({
		externalId: 'a86C3Xdfs0l5Ud7GHXUT',
		title: 'Shelly Pro Dual Cover/Shutter PM',
	}, new Date('2026-08-20T08:00:00.000Z'));
	assert.match(xml, /<Каталог СодержитТолькоИзменения="true">/u);
	assert.equal(xml.match(/<Товар>/gu)?.length, 1);
	assert.match(xml, /<Ид>a86C3Xdfs0l5Ud7GHXUT<\/Ид>/u);
	assert.match(xml, /<Наименование>Shelly Pro Dual Cover\/Shutter PM<\/Наименование>/u);
	assert.match(xml, /<БазоваяЕдиница[^>]*>шт<\/БазоваяЕдиница>/u);
	assert.doesNotMatch(xml, /Артикул|Описание|Цена|Картинк|Групп|Характеристик|URL|SEO/iu);
});

test('CommerceML canary catalog rejects missing identity before upload', () => {
	assert.throws(() => buildTildaCatalogCanaryXml({ externalId: '', title: 'Existing product' }), /external id/u);
	assert.throws(() => buildTildaCatalogCanaryXml({ externalId: 'existing', title: ' ' }), /title/u);
});

test('CommerceML publication catalog lists every target without card-content fields', () => {
	const xml = buildTildaCatalogProductsXml([
		{ externalId: 'second', title: 'Second' },
		{ externalId: 'first', title: 'First' },
	]);
	assert.equal(xml.match(/<Товар>/gu)?.length, 2);
	assert.match(xml, /<Ид>first<\/Ид>[\s\S]*<Ид>second<\/Ид>/u);
	assert.doesNotMatch(xml, /Артикул|Описание|Цена|Картинк|Групп|Характеристик|URL|SEO/iu);
	assert.throws(() => buildTildaCatalogProductsXml([]), /no products/u);
	assert.throws(() => buildTildaCatalogProductsXml([{ externalId: 'same', title: 'One' }, { externalId: 'same', title: 'Two' }]), /duplicate/u);
});
