import assert from 'node:assert/strict';
import test from 'node:test';
import type { BX24Sdk } from './b24-context.js';

interface CapturedRequest { url: string; body: Record<string, unknown> }

const browserWindow = {
	__B24_CONTEXT__: { dealId: null, domain: 'reports.example', memberId: null, accessToken: 'reports-token' },
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

const { fetchDealCategories, fetchRealizations, fetchSalesReport, fetchUsers } = await import('./b24.js');

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

test('report user and category filters preserve Bitrix requests and mapping', async () => {
	const methods: Array<{ method: string; params: Record<string, unknown> }> = [];
	browserWindow.BX24 = makeSdk((method, params, callback) => {
		methods.push({ method, params });
		const data = method === 'user.get'
			? [{ ID: 7, LAST_NAME: 'Ivanov', NAME: 'Ivan' }, { ID: 8 }]
			: { categories: [{ id: 3, name: 'Retail' }, { id: 1 }] };
		callback({ data: () => data, error: () => null });
	});

	assert.deepEqual(await fetchUsers(), [{ id: '7', name: 'Ivanov Ivan' }, { id: '8', name: '8' }]);
	assert.deepEqual(await fetchDealCategories(), [
		{ id: 0, name: 'Объекты' },
		{ id: 1, name: 'Воронка 1' },
		{ id: 3, name: 'Retail' },
	]);
	assert.deepEqual(methods, [
		{ method: 'user.get', params: { FILTER: { ACTIVE: true }, SORT: 'LAST_NAME', ORDER: 'ASC' } },
		{ method: 'crm.category.list', params: { entityTypeId: 2 } },
	]);
});

test('sales report preserves authenticated filters and coefficient fallback', async () => {
	delete browserWindow.BX24;
	const requests = captureResponses([{ ok: true }]);

	assert.deepEqual(await fetchSalesReport('2026-08-01', '2026-08-06', [0, 3]), { rows: [], coef: 0.5 });
	assert.deepEqual(requests[0], {
		url: '/api/reports/sales',
		body: {
			domain: 'reports.example', accessToken: 'reports-token',
			from: '2026-08-01', to: '2026-08-06', categoryIds: [0, 3],
		},
	});
});

test('realization report preserves default and explicit option payloads', async () => {
	const requests = captureResponses([
		{ ok: true },
		{ ok: true, rows: [], generatedAt: '2026-08-06T12:00:00Z', truncated: 1 },
	]);

	assert.deepEqual(await fetchRealizations(), { rows: [], generatedAt: '', truncated: false });
	assert.deepEqual(await fetchRealizations({ from: '2026-08-01', to: '2026-08-06', force: true }), {
		rows: [], generatedAt: '2026-08-06T12:00:00Z', truncated: true,
	});
	assert.deepEqual(requests, [
		{
			url: '/api/realizations/list',
			body: { domain: 'reports.example', accessToken: 'reports-token', force: false },
		},
		{
			url: '/api/realizations/list',
			body: {
				domain: 'reports.example', accessToken: 'reports-token', force: true,
				from: '2026-08-01', to: '2026-08-06',
			},
		},
	]);
});
