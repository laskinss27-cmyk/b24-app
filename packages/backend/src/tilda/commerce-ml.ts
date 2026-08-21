import type { TildaStockOffer } from './stock-projection.js';

type TildaCommerceMlOffer = Pick<TildaStockOffer, 'productId' | 'externalId' | 'quantity'>;

interface TildaCommerceMlCatalogProduct {
	externalId: string;
	title: string;
}

const CATALOG_ID = 'b24-app-stock';
const COMMERCE_ML_ROOT_ATTRIBUTES = 'xmlns="urn:1C.ru:commerceml_2" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

function xmlText(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function commerceMlDate(value: Date): string {
	if (!Number.isFinite(value.getTime())) throw new Error('invalid CommerceML generation date');
	return value.toISOString().slice(0, 19);
}

export function buildTildaOffersXml(offers: TildaCommerceMlOffer[], generatedAt = new Date()): string {
	const externalIds = new Set<string>();
	for (const offer of offers) {
		if (!offer.externalId.trim()) throw new Error(`Tilda offer for #${offer.productId} has no external id`);
		if (externalIds.has(offer.externalId)) throw new Error(`duplicate CommerceML offer id: ${offer.externalId}`);
		if (!Number.isInteger(offer.quantity) || offer.quantity < 0) {
			throw new Error(`invalid Tilda quantity for #${offer.productId}: ${offer.quantity}`);
		}
		externalIds.add(offer.externalId);
	}

	const rows = [...offers]
		.sort((left, right) => left.externalId.localeCompare(right.externalId))
		.map((offer) => [
			'      <Предложение>',
			`        <Ид>${xmlText(offer.externalId)}</Ид>`,
			`        <Количество>${offer.quantity}</Количество>`,
			'      </Предложение>',
		].join('\n'))
		.join('\n');

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<КоммерческаяИнформация ${COMMERCE_ML_ROOT_ATTRIBUTES} ВерсияСхемы="2.07" ДатаФормирования="${commerceMlDate(generatedAt)}">`,
		'  <ПакетПредложений СодержитТолькоИзменения="true">',
		`    <Ид>${CATALOG_ID}</Ид>`,
		'    <Наименование>b24-app stock only</Наименование>',
		`    <ИдКаталога>${CATALOG_ID}</ИдКаталога>`,
		'    <Предложения>',
		rows,
		'    </Предложения>',
		'  </ПакетПредложений>',
		'</КоммерческаяИнформация>',
	].filter(Boolean).join('\n');
}

export function buildTildaCatalogProductsXml(products: TildaCommerceMlCatalogProduct[], generatedAt = new Date()): string {
	if (products.length === 0) throw new Error('Tilda catalog has no products');
	const seenExternalIds = new Set<string>();
	const rows = products.map((product) => {
		const externalId = String(product.externalId ?? '').trim();
		const title = String(product.title ?? '').trim();
		if (!externalId) throw new Error('Tilda catalog product has no external id');
		if (!title) throw new Error('Tilda catalog product has no title');
		if (seenExternalIds.has(externalId)) throw new Error(`duplicate Tilda catalog product id: ${externalId}`);
		seenExternalIds.add(externalId);
		return [
			'      <Товар>',
			`        <Ид>${xmlText(externalId)}</Ид>`,
			`        <Наименование>${xmlText(title)}</Наименование>`,
			'        <БазоваяЕдиница Код="796" НаименованиеПолное="Штука" МеждународноеСокращение="PCE">шт</БазоваяЕдиница>',
			'      </Товар>',
		].join('\n');
	}).sort((left, right) => left.localeCompare(right)).join('\n');
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<КоммерческаяИнформация ${COMMERCE_ML_ROOT_ATTRIBUTES} ВерсияСхемы="2.07" ДатаФормирования="${commerceMlDate(generatedAt)}">`,
		'  <Каталог СодержитТолькоИзменения="true">',
		`    <Ид>${CATALOG_ID}</Ид>`,
		'    <Наименование>b24-app stock canary</Наименование>',
		'    <Владелец>',
		'      <Ид>b24-app</Ид>',
		'      <Наименование>b24-app</Наименование>',
		'    </Владелец>',
		'    <Товары>',
		rows,
		'    </Товары>',
		'  </Каталог>',
		'</КоммерческаяИнформация>',
	].join('\n');
}

export function buildTildaCatalogCanaryXml(product: TildaCommerceMlCatalogProduct, generatedAt = new Date()): string {
	return buildTildaCatalogProductsXml([product], generatedAt);
}
