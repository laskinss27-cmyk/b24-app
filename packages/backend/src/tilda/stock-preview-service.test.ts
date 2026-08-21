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
	assert.equal(first.projectionHash, second.projectionHash);
	assert.notEqual(first.xml, second.xml);
	assert.match(first.projectionHash, /^[a-f0-9]{64}$/u);
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
