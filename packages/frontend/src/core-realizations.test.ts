import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown> }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { dealId: null, domain: 'core.example', memberId: null, accessToken: 'core-token' } } as Window,
});

const {
	addProductToDeal,
	createDealReturn,
	fetchDealRealizationsCore,
	realizeCoreDraft,
	realizeCoreSubmit,
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

test('core realization list preserves the read-only empty fallback', async () => {
	const requests = captureResponses([{ ok: false, realizations: [{ name: 'DN-ignored' }] }]);

	assert.deepEqual(await fetchDealRealizationsCore(501), []);
	assert.deepEqual(requests[0], {
		url: '/api/deal/realize-core',
		body: { domain: 'core.example', accessToken: 'core-token', action: 'list', dealId: 501 },
	});
});

test('core realization draft and submit preserve actions and payloads', async () => {
	const groups = [{
		storeTitle: 'Main',
		lines: [{ productId: 42, qty: 2, rate: 1500, segmentId: 'base' }],
	}];
	const requests = captureResponses([
		{ ok: true, drafts: [{ name: 'DN-1', storeTitle: 'Main' }] },
		{ ok: true, submitted: ['DN-1'] },
	]);

	assert.deepEqual(await realizeCoreDraft(501, groups), [{ name: 'DN-1', storeTitle: 'Main' }]);
	assert.deepEqual(await realizeCoreSubmit(501, ['DN-1']), ['DN-1']);
	assert.deepEqual(requests.map((item) => item.body), [
		{ domain: 'core.example', accessToken: 'core-token', action: 'draft', dealId: 501, groups },
		{ domain: 'core.example', accessToken: 'core-token', action: 'submit', dealId: 501, names: ['DN-1'] },
	]);
});

test('deal return and product addition preserve endpoint-specific responses', async () => {
	const lines = [{ productId: 42, qty: 1, store: 'Main' }];
	const requests = captureResponses([
		{ ok: true, returns: ['RET-1'] },
		{ ok: true, row: { id: 9, name: 'Product', price: 1250, quantity: 3 } },
	]);

	assert.deepEqual(await createDealReturn(501, 'opened box', lines), ['RET-1']);
	assert.deepEqual(await addProductToDeal(501, 42, 3, 1250), { id: 9, name: 'Product', price: 1250, quantity: 3 });
	assert.deepEqual(requests, [
		{
			url: '/api/deal/realize-core',
			body: { domain: 'core.example', accessToken: 'core-token', action: 'return', dealId: 501, note: 'opened box', lines },
		},
		{
			url: '/api/deal/add-product',
			body: { domain: 'core.example', accessToken: 'core-token', dealId: 501, productId: 42, quantity: 3, price: 1250 },
		},
	]);
});
