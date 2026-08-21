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

test('single changed Tilda publication keeps the full audited catalog baseline', () => {
	const selected = selectTildaPublicationReport(report, 'uid-0');
	assert.equal(selected.projectionOffers.length, 1);
	assert.equal(selected.rollbackOffers.length, 1);
	assert.equal(selected.counts.differences, 1);
	assert.equal(selected.counts.reversibleProjectionOffers, 1);
	assert.equal(selected.counts.publicParents, 131);
	assert.equal(selected.counts.publicStockRows, 150);
});
