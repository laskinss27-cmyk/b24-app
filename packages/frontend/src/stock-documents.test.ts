import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown> }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { dealId: null, domain: 'mobile.example', memberId: null, accessToken: 'documents-token' } } as Window,
});

const { createIssueDoc, createReceiptDoc, createStockProduct, fetchStockFormData, searchStockItems, submitStockDoc } = await import('./b24.js');

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

test('stock form data preserves empty and boolean fallbacks', async () => {
	const requests = captureResponses([{ ok: true, canCreate: 1 }]);
	assert.deepEqual(await fetchStockFormData(), { stores: [], suppliers: [], canCreate: true, isSupply: false });
	assert.deepEqual(requests[0], {
		url: '/api/stock/form-data',
		body: { domain: 'mobile.example', accessToken: 'documents-token' },
	});
});

test('stock product creation and search preserve current response handling', async () => {
	const requests = captureResponses([
		{ ok: true, productId: 17 },
		{ ok: false, items: [{ productId: 17, name: 'Товар', article: '', brand: '' }] },
	]);

	assert.deepEqual(await createStockProduct('Товар'), { productId: 17, name: 'Товар', article: '', brand: '' });
	assert.deepEqual(await searchStockItems('  '), []);
	assert.deepEqual(await searchStockItems('товар'), [{ productId: 17, name: 'Товар', article: '', brand: '' }]);
	assert.deepEqual(requests.map((item) => item.url), ['/api/stock/create-product', '/api/stock/search-items']);
});

test('receipt, issue, and submit operations preserve shared endpoints and kind fields', async () => {
	const requests = captureResponses([{ ok: true, name: 'PR-1' }, { ok: true, name: 'SE-1' }, { ok: true }]);
	const receipt = { toStore: 'Основной', supplier: 'Vendor', lines: [{ productId: 17, qty: 2, purchase: 800, retail: 1200 }] };
	const issue = { fromStore: 'Основной', reason: 'Порча', lines: [{ productId: 17, qty: 1 }] };

	assert.equal(await createReceiptDoc(receipt), 'PR-1');
	assert.equal(await createIssueDoc(issue), 'SE-1');
	await submitStockDoc('receipt', 'PR-1');
	assert.deepEqual(requests, [
		{
			url: '/api/stock/create',
			body: { domain: 'mobile.example', accessToken: 'documents-token', kind: 'receipt', ...receipt },
		},
		{
			url: '/api/stock/create',
			body: { domain: 'mobile.example', accessToken: 'documents-token', kind: 'issue', ...issue },
		},
		{
			url: '/api/stock/submit',
			body: { domain: 'mobile.example', accessToken: 'documents-token', kind: 'receipt', name: 'PR-1' },
		},
	]);
});
