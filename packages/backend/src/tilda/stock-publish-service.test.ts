import assert from 'node:assert/strict';
import test from 'node:test';
import { runTildaStockPublication, selectTildaPublicationReport } from './stock-publish-service.js';

const offers = Array.from({ length: 132 }, (_, index) => ({
	productId: 18000 + index,
	tildaUid: `uid-${index}`,
	externalId: `external-${index}`,
	sku: `sku-${index}`,
	title: `Product ${index}`,
	quantity: index < 77 ? index + 1 : index,
}));
const rollbackOffers = offers.map((offer, index) => ({ ...offer, quantity: index < 77 ? index : offer.quantity }));
const report = {
	generatedAt: '2026-08-21T15:00:00.000Z',
	publicCatalogContentHash: 'a'.repeat(64),
	fullProjectionHash: 'b'.repeat(64),
	counts: { differences: 77, publicParents: 131, publicStockRows: 150, reversibleProjectionOffers: 132 },
	projectionOffers: offers,
	rollbackOffers,
};
const baselineRows = [
	...rollbackOffers.map((offer) => ({ tildaUid: offer.tildaUid, sku: offer.sku, quantity: offer.quantity })),
	...Array.from({ length: 18 }, (_, index) => ({ tildaUid: `untouched-${index}`, sku: `untouched-sku-${index}`, quantity: index === 0 ? null : index })),
];
const publicState = (projected: boolean) => ({
	parentCount: 131,
	contentHash: 'a'.repeat(64),
	rows: baselineRows.map((row) => {
		const projection = offers.find((offer) => offer.tildaUid === row.tildaUid);
		return projected && projection ? { ...row, quantity: projection.quantity } : row;
	}),
});
const confirmation = `publish:132:77:${'b'.repeat(64)}:${'a'.repeat(64)}`;
const protocol = {
	catalog: { fileName: 'import0_1.xml', importResponses: ['success'] },
	offers: { fileName: 'offers0_1.xml', importResponses: ['progress', 'success'] },
};

test('full Tilda publication verifies every projected and untouched public row', async () => {
	let projected = false;
	let rollbackCalls = 0;
	let publicReads = 0;
	const result = await runTildaStockPublication({ report, confirmation }, {
		readPublicCatalog: async () => {
			publicReads += 1;
			return publicState(projected);
		},
		publishProjection: async (catalogXml, offersXml) => {
			assert.equal(catalogXml.match(/<Товар>/gu)?.length, 132);
			assert.equal(offersXml.match(/<Предложение>/gu)?.length, 132);
			assert.match(offersXml, /<Наименование>b24-app stock only<\/Наименование>/u);
			assert.equal(offersXml.match(/<Наименование>/gu)?.length, 1);
			assert.doesNotMatch(offersXml, /Product|Артикул|Описание|Цена/u);
			projected = true;
			return protocol;
		},
		publishRollback: async () => {
			rollbackCalls += 1;
			return protocol;
		},
		wait: async () => undefined,
	});
	assert.equal(result.status, 'verified');
	assert.equal(result.targetCount, 132);
	assert.equal(result.changedCount, 77);
	assert.equal(rollbackCalls, 0);
	assert.equal(publicReads, 4);
});

test('failed Tilda publication applies and verifies the complete numeric rollback', async () => {
	let projected = false;
	let rollbackCalls = 0;
	await assert.rejects(runTildaStockPublication({ report, confirmation }, {
		readPublicCatalog: async () => publicState(projected),
		publishProjection: async () => {
			projected = true;
			throw new Error('simulated partial failure');
		},
		publishRollback: async (_catalogXml, rollbackXml) => {
			assert.equal(rollbackXml.match(/<Предложение>/gu)?.length, 132);
			projected = false;
			rollbackCalls += 1;
			return protocol;
		},
		wait: async () => undefined,
	}), /verified rollback was applied/u);
	assert.equal(rollbackCalls, 1);
});

test('failed price publication restores the exact prior numeric prices and ignores only current price in the protected hash', async () => {
	const priceProjection = offers.map((offer, index) => ({ ...offer, price: index === 0 ? 2150 : 100 }));
	const priceRollback = rollbackOffers.map((offer, index) => ({ ...offer, quantity: priceProjection[index]!.quantity, price: index === 0 ? 2466 : 100 }));
	const priceReport = {
		...report,
		priceSyncEnabled: true,
		counts: {
			...report.counts,
			differences: 1,
			priceTargets: 132,
			priceDifferences: 1,
			blockedMissingPrices: 0,
			missingErpPrices: 0,
		},
		projectionOffers: priceProjection,
		rollbackOffers: priceRollback,
	};
	let projected = false;
	let rollbackCalls = 0;
	const readPublicCatalog = async () => ({
		parentCount: 131,
		contentHash: (projected ? 'd' : 'c').repeat(64),
		protectedContentHash: 'a'.repeat(64),
		rows: [
			...priceRollback.map((offer, index) => ({
				tildaUid: offer.tildaUid,
				sku: offer.sku,
				quantity: offer.quantity,
				price: projected ? priceProjection[index]!.price : offer.price,
			})),
			...Array.from({ length: 18 }, (_, index) => ({
				tildaUid: `untouched-${index}`, sku: `untouched-sku-${index}`, quantity: index, price: 50,
			})),
		],
	});
	await assert.rejects(runTildaStockPublication({
		report: priceReport,
		confirmation: `publish:132:1:${'b'.repeat(64)}:${'a'.repeat(64)}`,
	}, {
		readPublicCatalog,
		publishProjection: async () => {
			projected = true;
			throw new Error('simulated price failure');
		},
		publishRollback: async (_catalogXml, rollbackXml) => {
			assert.match(rollbackXml, /<ЦенаЗаЕдиницу>2466\.00<\/ЦенаЗаЕдиницу>/u);
			projected = false;
			rollbackCalls += 1;
			return protocol;
		},
		wait: async () => undefined,
	}), /verified rollback was applied/u);
	assert.equal(rollbackCalls, 1);
});

test('single price publication verifies the new price without changing quantity or protected card content', async () => {
	const projection = { ...offers[0]!, quantity: rollbackOffers[0]!.quantity, price: 2150 };
	const rollback = { ...rollbackOffers[0]!, price: 2466 };
	const priceReport = {
		...report,
		priceSyncEnabled: true,
		publicCatalogContentHash: 'p'.repeat(64),
		counts: {
			...report.counts,
			differences: 1,
			reversibleProjectionOffers: 1,
			priceTargets: 1,
			priceDifferences: 1,
		},
		projectionOffers: [projection],
		rollbackOffers: [rollback],
	};
	let currentPrice = rollback.price;
	let rollbackCalls = 0;
	const result = await runTildaStockPublication({
		report: priceReport,
		confirmation: `publish:1:1:${'b'.repeat(64)}:${'p'.repeat(64)}`,
	}, {
		readPublicCatalog: async () => ({
			parentCount: 131,
			contentHash: currentPrice === projection.price ? 'changed'.repeat(9).slice(0, 64) : 'original'.repeat(10).slice(0, 64),
			protectedContentHash: 'p'.repeat(64),
			rows: baselineRows.map((row) => row.tildaUid === projection.tildaUid
				? { ...row, price: currentPrice }
				: { ...row, price: 100 }),
		}),
		publishProjection: async (_catalogXml, offersXml) => {
			assert.match(offersXml, /<ЦенаЗаЕдиницу>2150\.00<\/ЦенаЗаЕдиницу>/u);
			currentPrice = projection.price;
			return protocol;
		},
		publishRollback: async () => {
			rollbackCalls += 1;
			return protocol;
		},
		wait: async () => undefined,
	});
	assert.equal(result.status, 'verified');
	assert.equal(result.changedCount, 1);
	assert.equal(result.priceTargetCount, 1);
	assert.equal(result.priceChangedCount, 1);
	assert.equal(currentPrice, 2150);
	assert.equal(rollbackCalls, 0);
});

test('single changed Tilda publication keeps the full audited catalog baseline', () => {
	const selected = selectTildaPublicationReport(report, 'uid-0');
	assert.equal(selected.projectionOffers.length, 1);
	assert.equal(selected.rollbackOffers.length, 1);
	assert.equal(selected.counts.differences, 1);
	assert.equal(selected.counts.reversibleProjectionOffers, 1);
	assert.equal(selected.counts.publicParents, 131);
	assert.equal(selected.counts.publicStockRows, 150);
});
