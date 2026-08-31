import assert from 'node:assert/strict';
import test from 'node:test';
import { runTildaStockReconciliation, type TildaStockReconciliationDependencies } from './stock-reconciliation-service.js';
import type { TildaProductMapping, TildaStockOffer } from './stock-projection.js';

const HASH = 'c'.repeat(64);
const unlimitedUids = ['124782539723', '708983630233'];

function fixture(difference = false): {
	mappings: TildaProductMapping[];
	offers: TildaStockOffer[];
	stocks: Map<number, Record<string, number>>;
	rows: Array<{ tildaUid: string; sku: string; quantity: number | null }>;
} {
	const mappings: TildaProductMapping[] = [];
	const offers: TildaStockOffer[] = [];
	const stocks = new Map<number, Record<string, number>>();
	const rows: Array<{ tildaUid: string; sku: string; quantity: number | null }> = [];
	for (let index = 0; index < 150; index += 1) {
		const confirmed = index < 134;
		const tildaUid = index < 2 ? unlimitedUids[index]! : `uid-${index}`;
		const sku = `sku-${index}`;
		const productId = index + 1;
		mappings.push({
			productId: confirmed ? productId : 0,
			tildaUid,
			externalId: `external-${index}`,
			sku,
			title: `Title ${index}`,
			status: confirmed ? 'confirmed' : 'ignored',
		});
		rows.push({ tildaUid, sku, quantity: index < 2 ? null : (difference && index === 2 ? 0 : 5) });
		if (confirmed) {
			stocks.set(productId, { Shelly: 5 });
			offers.push({ productId, tildaUid, externalId: `external-${index}`, sku, title: `Title ${index}`, quantity: 5 });
		}
	}
	return { mappings, offers, stocks, rows };
}

function dependencies(difference = false) {
	const data = fixture(difference);
	const calls = { start: 0, verified: 0, failed: 0, preparationFailed: 0, noOp: 0, published: 0 };
	let currentRows = data.rows;
	const audit = {
		async recordPreparationFailure() { calls.preparationFailed += 1; },
		async recordNoopIfChanged() { calls.noOp += 1; return true; },
		async start() { calls.start += 1; return 'run-uuid'; },
		async finishVerified() { calls.verified += 1; },
		async finishFailed() { calls.failed += 1; },
	};
	const deps: TildaStockReconciliationDependencies = {
		readMappings: async () => data.mappings,
		fetchStocks: async () => data.stocks,
		readPublicCatalog: async () => ({ parentCount: 131, rows: currentRows, contentHash: HASH }),
		publishProjection: async () => {
			calls.published += 1;
			currentRows = data.rows.map((row) => row.tildaUid === 'uid-2' ? { ...row, quantity: 5 } : row);
			return { catalog: { fileName: 'import.xml', importResponses: ['success'] }, offers: { fileName: 'offers.xml', importResponses: ['success'] } };
		},
		publishRollback: async () => ({ catalog: { fileName: 'import.xml', importResponses: ['success'] }, offers: { fileName: 'offers.xml', importResponses: ['success'] } }),
		audit,
		wait: async () => {},
		now: () => new Date('2026-08-21T00:00:00.000Z'),
	};
	return { deps, calls };
}

test('reconciliation is idempotent and does not call Tilda when stocks match', async () => {
	const { deps, calls } = dependencies(false);
	const result = await runTildaStockReconciliation('scheduled', deps);
	assert.equal(result.status, 'no_op');
	assert.equal('priceTargetCount' in result, false);
	assert.deepEqual(calls, { start: 0, verified: 0, failed: 0, preparationFailed: 0, noOp: 1, published: 0 });
});

test('reconciliation publishes a difference and records verified audit', async () => {
	const { deps, calls } = dependencies(true);
	const result = await runTildaStockReconciliation('manual', deps);
	assert.equal(result.status, 'verified');
	assert.equal(result.changedCount, 1);
	assert.equal(result.targetCount, 132);
	assert.equal('priceTargetCount' in result, false);
	assert.deepEqual(calls, { start: 1, verified: 1, failed: 0, preparationFailed: 0, noOp: 0, published: 1 });
});

test('reconciliation fails closed before publication when baseline shape changes', async () => {
	const { deps, calls } = dependencies(false);
	deps.readMappings = async () => [];
	await assert.rejects(runTildaStockReconciliation('scheduled', deps), /audited baseline/u);
	assert.equal(calls.preparationFailed, 1);
	assert.equal(calls.published, 0);
});

test('price opt-in publishes reversible Standard Selling differences while preserving stock targets', async () => {
	const data = fixture(false);
	let currentRows = data.rows.map((row) => ({ ...row, price: 100 }));
	const calls = { published: 0, verified: 0 };
	const deps: TildaStockReconciliationDependencies = {
		readMappings: async () => data.mappings,
		fetchStocks: async () => data.stocks,
		fetchPrices: async () => new Map(data.offers.map((offer, index) => [offer.productId, index === 2 ? 90 : 100])),
		readPublicCatalog: async () => ({
			parentCount: 131,
			rows: currentRows,
			contentHash: 'd'.repeat(64),
			protectedContentHash: HASH,
		}),
		publishProjection: async (_catalogXml, offersXml) => {
			calls.published += 1;
			assert.match(offersXml, /<ЦенаЗаЕдиницу>90\.00<\/ЦенаЗаЕдиницу>/u);
			currentRows = currentRows.map((row) => row.tildaUid === 'uid-2' ? { ...row, price: 90 } : row);
			return { catalog: { fileName: 'import.xml', importResponses: ['success'] }, offers: { fileName: 'offers.xml', importResponses: ['success'] } };
		},
		publishRollback: async () => ({ catalog: { fileName: 'import.xml', importResponses: ['success'] }, offers: { fileName: 'offers.xml', importResponses: ['success'] } }),
		audit: {
			async recordPreparationFailure() {},
			async recordNoopIfChanged() { return true; },
			async start() { return 'run-uuid'; },
			async finishVerified() { calls.verified += 1; },
			async finishFailed() {},
		},
		wait: async () => {},
		now: () => new Date('2026-08-31T00:00:00.000Z'),
	};
	const result = await runTildaStockReconciliation('manual', deps);
	assert.equal(result.status, 'verified');
	assert.equal(result.changedCount, 1);
	assert.equal(result.priceChangedCount, 1);
	assert.equal(result.priceTargetCount, 132);
	assert.deepEqual(calls, { published: 1, verified: 1 });
});
