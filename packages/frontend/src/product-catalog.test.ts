import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalogView, indexCatalogRows } from './catalog-product-view.js';
import { MOCK_CATALOG_ROWS, MOCK_CATALOG_STORES } from './catalog-product-mock-data.js';

function catalogView(overrides: Partial<Parameters<typeof buildCatalogView>[0]> = {}) {
	return buildCatalogView({
		indexedRows: indexCatalogRows(MOCK_CATALOG_ROWS, [], new Set(MOCK_CATALOG_STORES.map((store) => store.id)), false, 9814),
		query: '', onlyStock: true, kind: 'goods', sectionIds: [], storeIds: [],
		sortKey: 'id', sortDirection: 1, restrictStores: false, visibleStores: MOCK_CATALOG_STORES,
		...overrides,
	});
}

test('catalog combines warehouses and sections with OR within each filter and AND between filters', () => {
	const result = catalogView({ storeIds: [10, 22], sectionIds: [101, 103] });
	assert.deepEqual(result.map(({ d, qty }) => [d.id, qty]), [[1924, 6], [2050, 300]]);
	assert.equal(catalogView({ storeIds: [8, 10] }).find((row) => row.d.id === 1924)?.qty, 18);
	assert.deepEqual(catalogView({ storeIds: [10], sectionIds: [103] }), []);
});

test('catalog resets to all warehouses and sections and sorts by selected warehouse totals', () => {
	assert.deepEqual(catalogView().map(({ d, qty }) => [d.id, qty]), [[1810, 8], [1811, 9], [1924, 18], [2050, 814]]);
	assert.deepEqual(catalogView({ storeIds: [10, 22], sortKey: 'stock', sortDirection: -1 }).map(({ qty }) => qty), [300, 6, 4, 4]);
	assert.equal(catalogView({ storeIds: [10], sectionIds: [103], onlyStock: false })[0]?.qty, 0);
});

test('catalog keeps services available explicitly and preserves text search with multiple filters', () => {
	assert.deepEqual(catalogView({ kind: 'services', storeIds: [10, 22] }).map(({ d }) => d.id), [3001]);
	assert.equal(catalogView({ kind: 'all' }).length, 5);
	assert.deepEqual(catalogView({ storeIds: [10, 22], sectionIds: [101, 102], query: 'камера redline' }).map(({ d }) => d.id), [1924]);
});

test('catalog never counts warehouses outside a restricted picker even with selected IDs', () => {
	const visibleStores = MOCK_CATALOG_STORES.filter((store) => store.id === 10);
	const indexedRows = indexCatalogRows(MOCK_CATALOG_ROWS, [visibleStores[0]!.title], new Set([10]), false, 9814);
	const restricted = { visibleStores, indexedRows, restrictStores: true };
	assert.deepEqual(catalogView(restricted).map(({ d, qty }) => [d.id, qty]), [[1811, 4], [1924, 6]]);
	assert.deepEqual(catalogView({ ...restricted, storeIds: [8, 10] }).map(({ qty }) => qty), [4, 6]);
	assert.deepEqual(catalogView({ ...restricted, storeIds: [8] }), []);
});

interface CapturedRequest {
	url: string;
	method: string;
	body: Record<string, unknown>;
}

const browserWindow = {
	__B24_CONTEXT__: {
		dealId: null,
		domain: 'mobile.example',
		memberId: null,
		accessToken: 'catalog-token',
	},
} as Window;
Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });

const {
	createCatalogProduct,
	downloadCatalogComparison,
	downloadMarketplaceCatalogSelection,
	fetchProductBase,
	updateCatalogPrices,
	updateCatalogProduct,
	updateMarketplaceOldId,
} = await import('./b24.js');

function captureResponses(responses: Response[]): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({
			url: String(input),
			method: init?.method ?? 'GET',
			body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
		});
		const response = responses.shift();
		if (!response) throw new Error('unexpected fetch');
		return response;
	}) as typeof fetch;
	return requests;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

test('fetchProductBase preserves request flags and fills absent optional response fields', async () => {
	const requests = captureResponses([jsonResponse({
		ok: true,
		rows: [{ id: 17, iblockId: 24, name: 'Товар', isService: false, retail: null, purchase: null, total: 0, stockByStore: {} }],
	})]);

	const result = await fetchProductBase(true, true);
	assert.equal(requests[0]?.url, '/api/catalog/browse');
	assert.equal(requests[0]?.method, 'POST');
	assert.deepEqual(requests[0]?.body, {
		domain: 'mobile.example',
		accessToken: 'catalog-token',
		force: true,
		marketplaceMode: true,
	});
	assert.deepEqual(result, {
		rows: [{ id: 17, iblockId: 24, name: 'Товар', isService: false, retail: null, purchase: null, total: 0, stockByStore: {} }],
		stores: [],
		generatedAt: '',
		cached: false,
		canEditCard: false,
		canEditPrices: false,
		canEditMarketplaceOldId: false,
	});
});

test('catalog mutations preserve payload merging and current response fallbacks', async () => {
	const requests = captureResponses([
		jsonResponse({ ok: true }),
		jsonResponse({ ok: true, marketplaceOldId: '' }),
		jsonResponse({ ok: true, product: { name: 'Сохранённый товар' } }),
		jsonResponse({ ok: true, status: 'review', name: 'Новый товар', candidates: [] }),
	]);

	assert.deepEqual(await updateCatalogPrices(17, 1200, 800), { retail: 1200, purchase: 800 });
	assert.equal(await updateMarketplaceOldId(17, 'legacy-17'), '');
	assert.deepEqual(await updateCatalogProduct({
		productId: 17,
		iblockId: 24,
		name: 'Сохранённый товар',
		isService: false,
		article: 'A-17',
		model: 'M17',
		manufacturer: 'Vendor',
		sectionId: 4,
		sectionName: 'Раздел',
		status: 'active',
		summary: 'Описание',
		attributeEdits: [],
		retail: 1200,
		purchase: 800,
	}), { name: 'Сохранённый товар' });
	assert.deepEqual(await createCatalogProduct({
		isService: false,
		productType: 'product',
		manufacturer: 'Vendor',
		model: 'M18',
		sectionId: 4,
		sectionName: 'Раздел',
		description: 'Описание',
		retail: 1300,
	}), { status: 'review', name: 'Новый товар', candidates: [] });

	assert.deepEqual(requests.map((request) => request.url), [
		'/api/catalog/update-prices',
		'/api/catalog/update-marketplace-old-id',
		'/api/catalog/update-product',
		'/api/catalog/create-product',
	]);
	assert.deepEqual(requests[0]?.body, {
		domain: 'mobile.example', accessToken: 'catalog-token', productId: 17, retail: 1200, purchase: 800,
	});
	assert.equal(requests[3]?.body['manufacturer'], 'Vendor');
});

test('catalog downloads preserve filenames, request bodies, and object URL cleanup', async () => {
	const requests = captureResponses([
		new Response(new Blob(['comparison']), {
			status: 200,
			headers: {
				'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				'Content-Disposition': 'attachment; filename="comparison.xlsx"',
			},
		}),
		new Response(new Blob(['selection']), {
			status: 200,
			headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
		}),
	]);
	const links: Array<{ href: string; download: string; clicked: boolean; removed: boolean }> = [];
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: {
			createElement: () => {
				const link = {
					href: '', download: '', clicked: false, removed: false,
					click(): void { this.clicked = true; },
					remove(): void { this.removed = true; },
				};
				links.push(link);
				return link;
			},
			body: { appendChild(): void {} },
		},
	});
	const revoked: string[] = [];
	let objectUrl = 0;
	Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => `blob:test-${++objectUrl}` });
	Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => revoked.push(url) });

	await downloadCatalogComparison();
	await downloadMarketplaceCatalogSelection({
		productIds: [17],
		storeIds: [2],
		selectedStoreLabel: 'Склад',
		selectedSectionLabel: 'Раздел',
		search: 'товар',
		onlyStock: true,
	});

	assert.deepEqual(links.map(({ href, download, clicked, removed }) => ({ href, download, clicked, removed })), [
		{ href: 'blob:test-1', download: 'comparison.xlsx', clicked: true, removed: true },
		{ href: 'blob:test-2', download: 'marketplace-products.xlsx', clicked: true, removed: true },
	]);
	assert.deepEqual(revoked, ['blob:test-1', 'blob:test-2']);
	assert.deepEqual(requests[0]?.body, { domain: 'mobile.example', accessToken: 'catalog-token' });
	assert.equal(requests[1]?.body['marketplaceMode'], true);
});
