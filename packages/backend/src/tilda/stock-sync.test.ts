import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTildaAvailabilityCatalogXml, buildTildaCatalogCanaryXml, buildTildaCatalogProductsXml, buildTildaOffersXml } from './commerce-ml.js';
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

test('Tilda stock preview reads only the Shelly warehouse', () => {
	const preview = buildTildaStockPreview([confirmed()], new Map([
		[18178, {
			Shelly: 3,
			'Максидом Дунайский 64': 2,
			'Склад Прихода': 20,
			'Goods In Transit': 10,
		}],
	]));

	assert.equal(preview.offers[0]?.quantity, 3);
	assert.equal(preview.sourceStore, 'Shelly');
});

test('Tilda stock preview floors fractional stock and never publishes a negative quantity', () => {
	const previews = [
		buildTildaStockPreview([confirmed()], new Map([[18178, { Shelly: 3.9 }]])),
		buildTildaStockPreview([confirmed()], new Map([[18178, { Shelly: -2 }]])),
	];

	assert.deepEqual(previews.map((preview) => preview.offers[0]?.quantity), [3, 0]);
});

test('Tilda price projection uses only explicit positive ERP retail prices and leaves missing prices absent', () => {
	const preview = buildTildaStockPreview(
		[confirmed(), confirmed({ productId: 18124, tildaUid: 'other', externalId: 'other', sku: 'other' })],
		new Map([[18178, { Shelly: 3 }], [18124, { Shelly: 4 }]]),
		undefined,
		new Map([[18178, 2150]]),
	);
	assert.equal(preview.offers[0]?.price, 2150);
	assert.equal(preview.offers[1]?.price, undefined);
	assert.deepEqual(preview.missingPrices.map((row) => row.productId), [18124]);
	assert.throws(() => buildTildaStockPreview(
		[confirmed()], new Map([[18178, { Shelly: 3 }]]), undefined, new Map([[18178, 0]]),
	), /invalid ERP retail price/u);
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

test('CommerceML adds only Standard Selling RUB price fields when price sync is enabled', () => {
	const xml = buildTildaOffersXml([{ ...confirmed(), quantity: 5, price: 2150 }]);
	assert.match(xml, /<Ид>b24-app-standard-selling<\/Ид>/u);
	assert.match(xml, /<Наименование>Standard Selling<\/Наименование>/u);
	assert.match(xml, /<ЦенаЗаЕдиницу>2150\.00<\/ЦенаЗаЕдиницу>/u);
	assert.match(xml, /<Валюта>RUB<\/Валюта>/u);
	assert.match(xml, /<Единица>шт<\/Единица>/u);
	assert.match(xml, /<Коэффициент>1<\/Коэффициент>/u);
	assert.doesNotMatch(xml, /Артикул|Описание|Картинк|Групп|Характеристик|URL|SEO/iu);
	assert.throws(() => buildTildaOffersXml([{ ...confirmed(), quantity: 5, price: 0 }]), /invalid Tilda price/u);
	assert.throws(() => buildTildaOffersXml([{ ...confirmed(), quantity: 5, price: 10.001 }]), /invalid Tilda price/u);
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

test('availability CommerceML contains one explicit string property and no unrelated card fields', () => {
	const xml = buildTildaAvailabilityCatalogXml([
		{ externalId: 'parent-external', title: 'Shelly 1', availability: 'В наличии' },
	], '10171262', new Date('2026-08-31T12:00:00.000Z'));
	assert.match(xml, /<Классификатор>[\s\S]*<Ид>10171262<\/Ид>[\s\S]*<Наименование>Наличие<\/Наименование>[\s\S]*<ТипЗначений>Строка<\/ТипЗначений>/u);
	assert.match(xml, /<ИдКлассификатора>b24-app-stock<\/ИдКлассификатора>/u);
	assert.match(xml, /<ЗначенияСвойств>[\s\S]*<Ид>10171262<\/Ид>[\s\S]*<Значение>В наличии<\/Значение>/u);
	assert.doesNotMatch(xml, /Артикул|Описание|Цена|Картинк|Групп|URL|SEO/iu);
	assert.throws(() => buildTildaAvailabilityCatalogXml([
		{ externalId: 'parent-external', title: 'Shelly 1', availability: 'В наличии' },
	], ''), /property ID is required/u);
});
