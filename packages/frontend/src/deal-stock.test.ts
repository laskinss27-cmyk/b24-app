import assert from 'node:assert/strict';
import test from 'node:test';
import type { BX24Sdk } from './b24-context.js';

interface CapturedRequest { url: string; body: Record<string, unknown> }

const browserWindow = {
	__B24_CONTEXT__: { dealId: null, domain: 'stock.example', memberId: null, accessToken: 'stock-token' },
} as unknown as Window;
Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });

function makeSdk(callMethod: BX24Sdk['callMethod']): BX24Sdk {
	return {
		init(callback): void { callback(); },
		installFinish(): void {},
		callMethod,
		callBatch: (_calls, callback) => callback({}),
		getAuth: () => false,
		isAdmin: () => false,
		resizeWindow(): void {},
		fitWindow(): void {},
		openPath(): void {},
	};
}

const {
	ROW_TYPE_GOODS,
	ROW_TYPE_WORK,
	fetchProductRows,
	fetchProfitCoef,
	fetchStockAndPurchasing,
	fetchStockPreferCore,
	fetchStores,
	isWorkRow,
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

test('deal product rows preserve Bitrix mapping and row type constants', async () => {
	let received: { method: string; params: Record<string, unknown> } | null = null;
	browserWindow.BX24 = makeSdk((method, params, callback) => {
		received = { method, params };
		callback({
			data: () => [{
				ID: 9, PRODUCT_ID: 42, PRODUCT_NAME: 'Phone', TYPE: 4, PRICE: '1500', QUANTITY: '2',
				DISCOUNT_SUM: '100', MEASURE_NAME: 'pcs',
			}],
			error: () => null,
		});
	});

	assert.deepEqual(await fetchProductRows(501), [{
		id: '9', productId: 42, name: 'Phone', type: 4, price: 1500,
		quantity: 2, discountSum: 100, measure: 'pcs',
	}]);
	assert.deepEqual(received, { method: 'crm.deal.productrows.get', params: { id: 501 } });
	assert.equal(ROW_TYPE_GOODS, 1);
	assert.equal(ROW_TYPE_WORK, 7);
	assert.equal(isWorkRow(7), true);
	assert.equal(isWorkRow(4), false);
});

test('profit coefficient preserves valid option and default fallback', async () => {
	browserWindow.BX24 = makeSdk((_method, _params, callback) => {
		callback({ data: () => ({ profit_coef: '0.7' }), error: () => null });
	});
	assert.equal(await fetchProfitCoef(), 0.7);

	browserWindow.BX24 = makeSdk((_method, _params, callback) => {
		callback({ data: () => ({ profit_coef: 'invalid' }), error: () => null });
	});
	assert.equal(await fetchProfitCoef(), 0.5);
});

test('store loading preserves authenticated request and empty fallback', async () => {
	delete browserWindow.BX24;
	const requests = captureResponses([{ ok: true }]);
	assert.deepEqual(await fetchStores(), []);
	assert.deepEqual(requests[0], {
		url: '/api/catalog/stores',
		body: { domain: 'stock.example', accessToken: 'stock-token' },
	});
});

test('core stock enrichment preserves id filtering, warehouse mapping, and purchasing fallback', async () => {
	const requests = captureResponses([
		{
			ok: true,
			byProduct: {
				42: { stocks: { Main: 3, Empty: 0, Unknown: 5 }, purchasing: 800 },
				43: { stocks: { Main: 1 }, purchasing: 0 },
			},
		},
		{ ok: true, stores: [{ id: 7, title: 'Main' }, { id: 8, title: 'Empty' }] },
	]);

	assert.deepEqual(await fetchStockAndPurchasing([42, -1, 43]), {
		42: { stocks: [{ storeId: 7, amount: 3 }], purchasingPrice: 800 },
		43: { stocks: [{ storeId: 7, amount: 1 }], purchasingPrice: null },
	});
	assert.deepEqual(requests.map((item) => item), [
		{
			url: '/api/catalog/erp-stocks',
			body: { domain: 'stock.example', accessToken: 'stock-token', productIds: [42, 43] },
		},
		{
			url: '/api/catalog/stores',
			body: { domain: 'stock.example', accessToken: 'stock-token' },
		},
	]);
	assert.deepEqual(await fetchStockPreferCore([]), {});
});
