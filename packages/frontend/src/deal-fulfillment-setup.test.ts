import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown> }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { dealId: null, domain: 'setup.example', memberId: null, accessToken: 'setup-token' } } as Window,
});

const { setupDealFulfillment } = await import('./b24.js');

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

test('fulfillment setup preserves default date, optional deal, and numeric fallbacks', async () => {
	const requests = captureResponses([
		{ ok: true },
		{ ok: true, checked: 5, changed: 3, failed: 1 },
	]);

	assert.deepEqual(await setupDealFulfillment(), { checked: 0, changed: 0, failed: 0 });
	assert.deepEqual(await setupDealFulfillment('2026-08-01', 501), { checked: 5, changed: 3, failed: 1 });
	assert.deepEqual(requests, [
		{
			url: '/api/deal/fulfillment-setup',
			body: { domain: 'setup.example', accessToken: 'setup-token', from: '2026-07-20' },
		},
		{
			url: '/api/deal/fulfillment-setup',
			body: { domain: 'setup.example', accessToken: 'setup-token', from: '2026-08-01', dealId: 501 },
		},
	]);
});
