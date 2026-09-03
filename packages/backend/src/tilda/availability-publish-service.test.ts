import assert from 'node:assert/strict';
import test from 'node:test';
import { runTildaAvailabilityPublication, type TildaPreparedAvailabilityReport } from './availability-publish-service.js';

const target = {
	parentTildaUid: 'parent-0',
	externalId: 'parent-external-0',
	title: 'Shelly 1',
	availability: 'В наличии' as const,
	currentAvailability: 'Под заказ' as const,
	editionUids: ['edition-0'],
};
const report: TildaPreparedAvailabilityReport = {
	generatedAt: '2026-08-31T12:00:00.000Z',
	propertyId: '10171262',
	fullProjectionHash: 'b'.repeat(64),
	publicCatalogContentHash: 'a'.repeat(64),
	counts: { publicParents: 143, publicStockRows: 162, targets: 1, differences: 1, skippedGroups: 14 },
	targets: [target],
	anchorOffer: {
		productId: 1, tildaUid: 'edition-0', externalId: 'edition-external-0', sku: 'sku-0', title: 'Shelly 1', quantity: 19,
	},
};
const protocol = {
	catalog: { fileName: 'import0_1.xml', importResponses: ['success'] },
	offers: { fileName: 'offers0_1.xml', importResponses: ['progress', 'success'] },
};

function publicState(availability: 'В наличии' | 'Под заказ') {
	return {
		parentCount: 143,
		availabilityProtectedContentHash: 'a'.repeat(64),
		rows: [
			{ tildaUid: 'edition-0', sku: 'sku-0', quantity: 19, price: 1900 },
			...Array.from({ length: 161 }, (_, index) => ({ tildaUid: `stock-${index}`, sku: `stock-sku-${index}`, quantity: index, price: 100 })),
		],
		availabilityRows: [
			{ tildaUid: 'parent-0', externalId: 'parent-external-0', title: 'Shelly 1', availability, editionUids: ['edition-0'] },
			...Array.from({ length: 142 }, (_, index) => ({
				tildaUid: `parent-${index + 1}`, externalId: `parent-external-${index + 1}`, title: `Product ${index + 1}`,
				availability: 'Под заказ' as const, editionUids: [`stock-${index}`],
			})),
		],
	};
}

test('availability publication changes only the selected characteristic and verifies stable catalog content', async () => {
	let availability: 'В наличии' | 'Под заказ' = 'Под заказ';
	let rollbackCalls = 0;
	const result = await runTildaAvailabilityPublication({
		report,
		confirmation: `availability:1:1:${'b'.repeat(64)}:${'a'.repeat(64)}`,
	}, {
		readPublicCatalog: async () => publicState(availability),
		publishProjection: async (catalogXml, offersXml) => {
			assert.match(catalogXml, /<Наименование>Наличие<\/Наименование>[\s\S]*<Значение>В наличии<\/Значение>/u);
			assert.equal(catalogXml.match(/<Товар>/gu)?.length, 1);
			assert.match(offersXml, /<Количество>19<\/Количество>/u);
			assert.doesNotMatch(offersXml, /<Цена>/u);
			availability = 'В наличии';
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
	assert.equal(rollbackCalls, 0);
});

test('failed availability publication restores and verifies the exact previous value', async () => {
	let availability: 'В наличии' | 'Под заказ' = 'Под заказ';
	let rollbackCalls = 0;
	await assert.rejects(runTildaAvailabilityPublication({
		report,
		confirmation: `availability:1:1:${'b'.repeat(64)}:${'a'.repeat(64)}`,
	}, {
		readPublicCatalog: async () => publicState(availability),
		publishProjection: async () => {
			availability = 'В наличии';
			throw new Error('simulated partial failure');
		},
		publishRollback: async (catalogXml) => {
			assert.match(catalogXml, /<Значение>Под заказ<\/Значение>/u);
			availability = 'Под заказ';
			rollbackCalls += 1;
			return protocol;
		},
		wait: async () => undefined,
	}), /verified rollback was applied/u);
	assert.equal(rollbackCalls, 1);
});
