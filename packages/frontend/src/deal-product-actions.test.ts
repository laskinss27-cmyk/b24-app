import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
}

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: {
		__B24_CONTEXT__: {
			dealId: null,
			domain: 'mobile.example',
			memberId: null,
			accessToken: 'deal-token',
		},
	} as Window,
});

const { addProductsToDeal, createQuickSale, searchDealProducts } = await import('./b24.js');

function captureResponses(responses: unknown[]): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({
			url: String(input),
			body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
		});
		const response = responses.shift();
		if (response === undefined) throw new Error('unexpected fetch');
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as typeof fetch;
	return requests;
}

test('createQuickSale preserves auth, item data, assignee, and selected store', async () => {
	const requests = captureResponses([{ ok: true, dealId: 42 }]);
	const items = [{ productId: 17, name: 'Товар', price: 1200, quantity: 2, discountPercent: 5 }];

	assert.equal(await createQuickSale(items, { assignedById: '1858', storeId: 7 }), 42);
	assert.deepEqual(requests, [{
		url: '/api/quicksale/create',
		body: {
			domain: 'mobile.example',
			accessToken: 'deal-token',
			items,
			assignedById: '1858',
			storeId: 7,
		},
	}]);
});

test('searchDealProducts skips short queries and rejects backend errors', async () => {
	const requests = captureResponses([{ ok: false, error: 'catalog unavailable', products: [{ id: 17, name: 'Товар', price: 1200 }] }]);

	assert.deepEqual(await searchDealProducts(' x '), []);
	assert.equal(requests.length, 0);
	await assert.rejects(searchDealProducts('товар'), /catalog unavailable/);
	assert.deepEqual(requests[0], {
		url: '/api/deal/search-products',
		body: { domain: 'mobile.example', accessToken: 'deal-token', q: 'товар' },
	});
});

test('addProductsToDeal preserves stage options and the current zero fallback', async () => {
	const requests = captureResponses([{ ok: true }]);
	const items = [{ productId: 17, quantity: 2, price: 1200, name: 'Товар', isService: false }];

	assert.equal(await addProductsToDeal(91, items, {
		stage: true,
		stageId: 'stage-1',
		stageName: 'Первый этап',
		variantId: 'variant-2',
	}), 0);
	assert.deepEqual(requests[0], {
		url: '/api/deal/add-products',
		body: {
			domain: 'mobile.example',
			accessToken: 'deal-token',
			dealId: 91,
			items,
			stage: true,
			stageId: 'stage-1',
			stageName: 'Первый этап',
			variantId: 'variant-2',
		},
	});
});
