import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown> }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: {
		__B24_CONTEXT__: { dealId: null, domain: 'mobile.example', memberId: null, accessToken: 'history-token' },
	} as Window,
});

const { fetchDocDetail, fetchItemHistory, fetchMovements } = await import('./b24.js');

function captureResponses(responses: unknown[]): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
		const response = responses.shift();
		if (response === undefined) throw new Error('unexpected fetch');
		return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	return requests;
}

test('stock history reads preserve endpoint payloads and empty list fallbacks', async () => {
	const detail = {
		name: 'STE-1', doctype: 'Stock Entry', date: '2026-08-06', submitted: true,
		dealId: '91', supplier: '', reason: '', note: '', items: [], ownerName: 'User',
	};
	const requests = captureResponses([{ ok: true }, { ok: true, detail }, { ok: true }]);

	assert.deepEqual(await fetchMovements('issue', { from: '2026-08-01', to: '2026-08-31', productId: 17 }), []);
	assert.deepEqual(await fetchDocDetail('Stock Entry', 'STE-1'), detail);
	assert.deepEqual(await fetchItemHistory(17), []);
	assert.deepEqual(requests, [
		{
			url: '/api/stock/movements',
			body: {
				domain: 'mobile.example', accessToken: 'history-token', kind: 'issue',
				from: '2026-08-01', to: '2026-08-31', productId: 17,
			},
		},
		{
			url: '/api/stock/doc',
			body: { domain: 'mobile.example', accessToken: 'history-token', doctype: 'Stock Entry', name: 'STE-1' },
		},
		{
			url: '/api/stock/item-history',
			body: { domain: 'mobile.example', accessToken: 'history-token', productId: 17 },
		},
	]);
});
