import assert from 'node:assert/strict';
import test from 'node:test';
import { runTildaStockCanary, type TildaPreparedStockReport } from './stock-canary-service.js';
import type { TildaStockOffer } from './stock-projection.js';

const offer: TildaStockOffer = {
	productId: 18304,
	tildaUid: '400979429632',
	externalId: 'a86C3Xdfs0l5Ud7GHXUT',
	sku: '111081',
	title: 'Shelly Pro Dual Cover/Shutter PM',
	quantity: 18,
};
const report: TildaPreparedStockReport = {
	generatedAt: '2026-08-21T14:50:47.846Z',
	publicCatalogContentHash: 'a'.repeat(64),
	projectionOffers: [offer],
	rollbackOffers: [{ ...offer }],
};
const publicCatalog = {
	parentCount: 131,
	rows: [
		{ tildaUid: offer.tildaUid, sku: offer.sku, quantity: 18 },
		...Array.from({ length: 149 }, (_, index) => ({ tildaUid: `filler-${index}`, sku: `filler-${index}`, quantity: 0 })),
	],
	contentHash: 'a'.repeat(64),
};

test('stock canary publishes one stock-only offer and verifies card content hash', async () => {
	let sentCatalogXml = '';
	let sentOffersXml = '';
	const result = await runTildaStockCanary({
		report,
		tildaUid: offer.tildaUid,
		confirmation: `canary:${offer.tildaUid}:18:${'a'.repeat(64)}`,
	}, {
		readPublicCatalog: async () => publicCatalog,
		publishExchange: async (catalogXml, offersXml) => {
			sentCatalogXml = catalogXml;
			sentOffersXml = offersXml;
			return {
				catalog: { fileName: 'import0_1.xml', importResponses: ['success'] },
				offers: { fileName: 'offers0_1.xml', importResponses: ['success'] },
			};
		},
	});
	assert.equal(result.status, 'verified');
	assert.match(sentCatalogXml, /<Ид>a86C3Xdfs0l5Ud7GHXUT<\/Ид>/u);
	assert.match(sentCatalogXml, /<Наименование>Shelly Pro Dual Cover\/Shutter PM<\/Наименование>/u);
	assert.doesNotMatch(sentCatalogXml, /111081|Артикул|Описание|Цена|Картинк|Групп|Характеристик|URL|SEO/iu);
	assert.match(sentOffersXml, /<Ид>a86C3Xdfs0l5Ud7GHXUT<\/Ид>[\s\S]*<Количество>18<\/Количество>/u);
	assert.match(sentOffersXml, /<Наименование>b24-app stock only<\/Наименование>/u);
	assert.equal(sentOffersXml.match(/<Наименование>/gu)?.length, 1);
	assert.doesNotMatch(sentOffersXml, /111081|Shelly|Артикул|Описание|Цена/u);
});

test('stock canary fails before publishing when content changed', async () => {
	let publishCount = 0;
	await assert.rejects(runTildaStockCanary({
		report,
		tildaUid: offer.tildaUid,
		confirmation: `canary:${offer.tildaUid}:18:${'a'.repeat(64)}`,
	}, {
		readPublicCatalog: async () => ({ ...publicCatalog, contentHash: 'b'.repeat(64) }),
		publishExchange: async () => {
			publishCount += 1;
			return {
				catalog: { fileName: 'import0_1.xml', importResponses: ['success'] },
				offers: { fileName: 'offers0_1.xml', importResponses: ['success'] },
			};
		},
	}), /content changed/u);
	assert.equal(publishCount, 0);
});
