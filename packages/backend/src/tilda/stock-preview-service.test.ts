import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareTildaStockPreview } from './stock-preview-service.js';
import type { TildaProductMapping } from './stock-projection.js';

test('Tilda stock preview service fetches only confirmed ERP items and returns a stable hash', async () => {
	const mappings: TildaProductMapping[] = [
		{ productId: 18178, tildaUid: 'uid-1', externalId: 'external-1', sku: 'old-1', title: 'Product', status: 'confirmed' },
		{ productId: 0, tildaUid: 'uid-2', externalId: 'external-2', sku: 'old-2', title: 'Missing', status: 'ignored' },
	];
	const requested: number[][] = [];
	const services = {
		async readMappings() { return mappings; },
		async fetchStocks(productIds: number[]) {
			requested.push(productIds);
			return new Map([[18178, { Shelly: 4, 'Склад Прихода': 10 }]]);
		},
	};
	const first = await prepareTildaStockPreview(services, undefined, new Date('2026-08-21T10:00:00.000Z'));
	const second = await prepareTildaStockPreview(services, undefined, new Date('2026-08-21T11:00:00.000Z'));
	assert.deepEqual(requested, [[18178], [18178]]);
	assert.equal(first.offers[0]?.quantity, 4);
	assert.equal(first.skippedCount, 1);
	assert.equal(first.priceSyncEnabled, false);
	assert.equal(first.missingPriceCount, 0);
	assert.equal(first.projectionHash, second.projectionHash);
	assert.notEqual(first.xml, second.xml);
	assert.match(first.projectionHash, /^[a-f0-9]{64}$/u);
});

test('Tilda stock preview opt-in includes stable ERP retail prices without requiring every mapped Item to have one', async () => {
	const mappings: TildaProductMapping[] = [
		{ productId: 18178, tildaUid: 'uid-1', externalId: 'external-1', sku: 'old-1', title: 'First', status: 'confirmed' },
		{ productId: 18184, tildaUid: 'uid-2', externalId: 'external-2', sku: 'old-2', title: 'Second', status: 'confirmed' },
	];
	const preview = await prepareTildaStockPreview({
		async readMappings() { return mappings; },
		async fetchStocks() { return new Map([[18178, { Shelly: 4 }], [18184, { Shelly: 2 }]]); },
		async fetchPrices() { return new Map([[18178, 2150]]); },
	}, undefined, new Date('2026-08-31T00:00:00.000Z'));
	assert.equal(preview.priceSyncEnabled, true);
	assert.equal(preview.missingPriceCount, 1);
	assert.equal(preview.offers[0]?.price, 2150);
	assert.equal(preview.offers[1]?.price, undefined);
	assert.match(preview.xml, /<ЦенаЗаЕдиницу>2150\.00<\/ЦенаЗаЕдиницу>/u);
});

test('Tilda stock preview service fails closed on an incomplete ERP response', async () => {
	const services = {
		async readMappings(): Promise<TildaProductMapping[]> {
			return [
				{ productId: 18178, tildaUid: 'uid-1', externalId: 'external-1', sku: 'old-1', title: 'First', status: 'confirmed' },
				{ productId: 18184, tildaUid: 'uid-2', externalId: 'external-2', sku: 'old-2', title: 'Second', status: 'confirmed' },
			];
		},
		async fetchStocks() {
			return new Map([[18178, { Shelly: 4 }]]);
		},
	};

	await assert.rejects(
		prepareTildaStockPreview(services),
		/ERP stock response is incomplete for confirmed Items: 18184/u,
	);
});
