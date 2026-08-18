import assert from 'node:assert/strict';
import test from 'node:test';
import type { BX24Sdk } from './b24-context.js';

interface CapturedRequest { url: string; body: Record<string, unknown> }

const browserWindow = {
	__B24_CONTEXT__: { dealId: null, domain: 'inventory.example', memberId: null, accessToken: 'inventory-token' },
} as unknown as Window;
Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });

const {
	buildAddedLine,
	fetchActLines,
	fetchStoreInventory,
	fetchStoreStock,
	photoFullUrl,
	searchProducts,
} = await import('./b24.js');

function captureResponses(responses: unknown[]): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
		const value = responses.shift();
		if (value === undefined) throw new Error('unexpected fetch');
		return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	return requests;
}

function makeSdk(auth: ReturnType<BX24Sdk['getAuth']>): BX24Sdk {
	return {
		init(callback): void { callback(); },
		installFinish(): void {},
		callMethod(): void {},
		callBatch: (_calls, callback) => callback({}),
		getAuth: () => auth,
		isAdmin: () => false,
		resizeWindow(): void {},
		fitWindow(): void {},
		openPath(): void {},
	};
}

test('inventory stock loading preserves shared endpoint and optional fields', async () => {
	const first = [{ productId: 42, name: 'Phone', book: 2 }];
	const requests = captureResponses([{ ok: true, lines: first }, { ok: true }]);

	assert.deepEqual(await fetchStoreInventory(7, [4]), first);
	assert.deepEqual(await fetchStoreStock(8, undefined, 'Point', 'inv-8'), []);
	assert.deepEqual(requests, [
		{
			url: '/api/inventory/stock',
			body: { domain: 'inventory.example', accessToken: 'inventory-token', storeId: 7, sectionIds: [4] },
		},
		{
			url: '/api/inventory/stock',
			body: { domain: 'inventory.example', accessToken: 'inventory-token', inventoryId: 'inv-8', storeId: 8, storeName: 'Point', sectionIds: [] },
		},
	]);
});

test('inventory product search preserves short-query skip and current ok handling', async () => {
	const requests = captureResponses([{ ok: false, products: [{ id: 42, name: 'Phone' }] }]);

	assert.deepEqual(await searchProducts(' '), []);
	assert.deepEqual(await searchProducts('Ph'), [{ id: 42, name: 'Phone' }]);
	assert.deepEqual(requests[0], {
		url: '/api/inventory/search-products',
		body: { domain: 'inventory.example', accessToken: 'inventory-token', q: 'Ph' },
	});
});

test('manually added and act lines preserve their reduced inventory shape', async () => {
	const requests = captureResponses([{ ok: true, products: [{ id: 42, name: 'Phone' }] }]);

	assert.deepEqual(await buildAddedLine(42), { productId: 42, book: 0, name: 'Phone' });
	assert.deepEqual(await fetchActLines([{
		productId: 42, name: 'Phone', book: 2, fact: 1, diff: -1, comment: 'missing',
	}]), [{ productId: 42, book: 2, name: 'Phone' }]);
	assert.deepEqual(requests[0], {
		url: '/api/inventory/search-products',
		body: { domain: 'inventory.example', accessToken: 'inventory-token', q: '42' },
	});
});

test('product photo URLs preserve proxy, SDK, mobile, and missing-auth behavior', () => {
	assert.equal(photoFullUrl('/api/catalog/photo/42'), '/api/catalog/photo/42');
	assert.equal(photoFullUrl('https://cdn.example/photo.jpg'), 'https://cdn.example/photo.jpg');

	browserWindow.BX24 = makeSdk({ domain: 'portal.example', access_token: 'sdk token' });
	assert.equal(photoFullUrl('/upload/photo.jpg?size=small'), 'https://portal.example/upload/photo.jpg?size=small&auth=sdk%20token');

	delete browserWindow.BX24;
	assert.equal(photoFullUrl('/upload/photo.jpg'), 'https://inventory.example/upload/photo.jpg?auth=inventory-token');

	delete browserWindow.__B24_CONTEXT__;
	assert.equal(photoFullUrl('/upload/photo.jpg'), null);
});
