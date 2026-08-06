import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
}

const browserWindow = {
	__B24_CONTEXT__: {
		dealId: null,
		domain: 'mobile.example',
		memberId: null,
		accessToken: 'fulfillment-token',
	},
} as Window;
Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });

const { fetchDealShipped, openSupplyCard, realizeDeal, requestSupply, withRetry } = await import('./b24.js');

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

test('fetchDealShipped preserves all empty fallbacks for a partial successful response', async () => {
	const requests = captureResponses([{ ok: true }]);

	assert.deepEqual(await fetchDealShipped(91), {
		orderId: null,
		shipped: {},
		reserves: {},
		shipments: [],
		payment: null,
		sourceStoreId: null,
		supply: [],
		rows: null,
	});
	assert.deepEqual(requests[0], {
		url: '/api/deal/shipped',
		body: { domain: 'mobile.example', accessToken: 'fulfillment-token', dealId: 91 },
	});
});

test('withRetry repeats rejected work and returns the first successful value', async () => {
	let attempts = 0;
	assert.equal(await withRetry(async () => {
		attempts += 1;
		if (attempts < 3) throw new Error(`attempt-${attempts}`);
		return 'ready';
	}, 3, 50, 'retry-test'), 'ready');
	assert.equal(attempts, 3);
});

test('requestSupply and realizeDeal preserve payloads and response defaults', async () => {
	const requests = captureResponses([
		{ ok: true, cardId: 7 },
		{ ok: true, shipmentId: 11 },
	]);
	const supplyItems = [{ name: 'Товар', quantity: 2, measure: 'шт' }];
	const realizeItems = [{ rowId: 501, productId: 17, quantity: 1, rowQuantity: 2, price: 1200, name: 'Товар', storeId: 3, storeName: 'Основной' }];

	assert.deepEqual(await requestSupply(91, supplyItems, 'Точка 2'), {
		mode: 'created', cardId: 7, title: '',
	});
	assert.deepEqual(await realizeDeal(91, realizeItems), {
		orderId: 0,
		orderReused: false,
		shipmentId: 11,
		accountNumber: '',
		dupRemoved: null,
	});
	assert.deepEqual(requests, [
		{
			url: '/api/deal/supply-request',
			body: { domain: 'mobile.example', accessToken: 'fulfillment-token', dealId: 91, items: supplyItems, storeToName: 'Точка 2' },
		},
		{
			url: '/api/deal/realize',
			body: { domain: 'mobile.example', accessToken: 'fulfillment-token', dealId: 91, items: realizeItems },
		},
	]);
});

test('openSupplyCard uses the Bitrix slider path when the SDK is available', () => {
	let opened = '';
	browserWindow.BX24 = {
		openPath: (path: string) => { opened = path; },
		getAuth: () => false,
	} as NonNullable<Window['BX24']>;

	openSupplyCard(77);
	assert.equal(opened, '/crm/type/1110/details/77/');
	Reflect.deleteProperty(browserWindow, 'BX24');
});
