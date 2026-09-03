import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown> }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { dealId: null, domain: 'market.example', memberId: null, accessToken: 'market-token' } } as Window,
});

const {
	cancelMarketplaceOperation,
	createMarketplaceBundle,
	createMarketplaceReturn,
	createMarketplaceSale,
	fetchMarketplaceFormData,
	fetchMarketplaceOperations,
	fetchMarketplaceReturnSales,
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

test('marketplace form data and operations preserve fallbacks and period payload', async () => {
	const requests = captureResponses([
		{ ok: true, marketplaces: ['Ozon'], canCreate: 1 },
		{ ok: true },
	]);

	assert.deepEqual(await fetchMarketplaceFormData(), {
		marketplaces: ['Ozon'],
		stores: [],
		missingStores: [],
		canCreate: true,
	});
	assert.deepEqual(await fetchMarketplaceOperations({ from: '2026-08-01', to: '2026-08-06' }), []);
	assert.deepEqual(requests, [
		{
			url: '/api/marketplaces/form-data',
			body: { domain: 'market.example', accessToken: 'market-token' },
		},
		{
			url: '/api/marketplaces/list',
			body: { domain: 'market.example', accessToken: 'market-token', from: '2026-08-01', to: '2026-08-06' },
		},
	]);
});

test('marketplace sale preserves request and response fields', async () => {
	const input = {
		marketplace: 'Ozon',
		storeTitle: 'Marketplace',
		postingDate: '2026-08-06',
		lines: [{ productId: 42, itemName: 'Bundle', qty: 2, rate: 1500 }],
	};
	const requests = captureResponses([{ ok: true, name: 'DN-1', title: 'Sale 1' }]);

	assert.deepEqual(await createMarketplaceSale(input), { name: 'DN-1', title: 'Sale 1' });
	assert.deepEqual(requests[0], {
		url: '/api/marketplaces/sale',
		body: { domain: 'market.example', accessToken: 'market-token', ...input },
	});
});

test('marketplace cancellation sends only the document identity with current auth', async () => {
	const requests = captureResponses([{ ok: true, cancelled: true }]);

	await cancelMarketplaceOperation('MAT-STE-2026-00514');

	assert.deepEqual(requests[0], {
		url: '/api/marketplaces/cancel',
		body: { domain: 'market.example', accessToken: 'market-token', name: 'MAT-STE-2026-00514' },
	});
});

test('marketplace returns preserve options, numeric fallbacks, and payload', async () => {
	const input = {
		saleName: 'DN-1',
		lines: [{ productId: 42, qty: 1 }],
		storeTitle: 'Marketplace',
		postingDate: '2026-08-06',
	};
	const requests = captureResponses([
		{ ok: true },
		{ ok: true, name: 'RET-1', title: 'Return 1', marketplace: 'Ozon', storeTitle: 'Marketplace' },
	]);

	assert.deepEqual(await fetchMarketplaceReturnSales(), []);
	assert.deepEqual(await createMarketplaceReturn(input), {
		name: 'RET-1',
		title: 'Return 1',
		marketplace: 'Ozon',
		total: 0,
		quantity: 0,
		itemCount: 0,
		storeTitle: 'Marketplace',
	});
	assert.deepEqual(requests[1], {
		url: '/api/marketplaces/return',
		body: { domain: 'market.example', accessToken: 'market-token', ...input },
	});
});

test('marketplace bundle preserves numeric conversion and response fields', async () => {
	const input = { sourceProductId: 42, unitsPerBundle: 3, bundleQty: 2, postingDate: '2026-08-06' };
	const requests = captureResponses([{
		ok: true,
		name: 'SE-1',
		title: 'Bundle 1',
		sourceQty: '6',
		bundleProductId: 84,
		bundleItemName: 'Bundle x3',
		bundleQty: '2',
		storeTitle: 'Marketplace',
	}]);

	assert.deepEqual(await createMarketplaceBundle(input), {
		name: 'SE-1',
		title: 'Bundle 1',
		sourceQty: 6,
		bundleProductId: 84,
		bundleItemName: 'Bundle x3',
		bundleQty: 2,
		storeTitle: 'Marketplace',
	});
	assert.deepEqual(requests[0], {
		url: '/api/marketplaces/bundle',
		body: { domain: 'market.example', accessToken: 'market-token', ...input },
	});
});
