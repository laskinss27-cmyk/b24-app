import type { TildaStockOffer } from './stock-projection.js';

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

export function buildTildaOffersXml(offers: TildaStockOffer[], generatedAt = new Date()): string {
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
			`        <Артикул>${xmlText(offer.sku)}</Артикул>`,
			`        <Наименование>${xmlText(offer.title)}</Наименование>`,
			`        <Количество>${offer.quantity}</Количество>`,
			'      </Предложение>',
		].join('\n'))
		.join('\n');

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<КоммерческаяИнформация ВерсияСхемы="2.07" ДатаФормирования="${commerceMlDate(generatedAt)}">`,
		'  <ПакетПредложений СодержитТолькоИзменения="true">',
		'    <Ид>b24-app-stock</Ид>',
		'    <Наименование>Остатки b24-app</Наименование>',
		'    <Предложения>',
		rows,
		'    </Предложения>',
		'  </ПакетПредложений>',
		'</КоммерческаяИнформация>',
	].filter(Boolean).join('\n');
}
