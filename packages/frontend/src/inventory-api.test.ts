import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown>; keepalive?: boolean }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { dealId: null, domain: 'inventory.example', memberId: null, accessToken: 'inventory-token' } } as Window,
});

const {
	claimPoint,
	createInventory,
	deleteInventory,
	listInventories,
	makeActPoint,
	previewErpDoc,
	reopenPoint,
	saveDraftPoint,
	saveErpDoc,
	submitErpDoc,
	submitPoint,
} = await import('./b24.js');

function captureResponses(responses: unknown[]): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({
			url: String(input),
			body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
			...(init?.keepalive === undefined ? {} : { keepalive: init.keepalive }),
		});
		const value = responses.shift();
		if (value === undefined) throw new Error('unexpected fetch');
		return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	return requests;
}

test('inventory listing and creation preserve fallbacks and complete payload', async () => {
	const points = [{ storeId: 7, storeName: 'Point', responsibleId: '1', responsibleName: 'Admin' }];
	const requests = captureResponses([{ ok: true }, { ok: true }]);

	assert.deepEqual(await listInventories(), []);
	await createInventory('August', points, '2026-08-31', '1', ['1', '986'], [4, 5], 'inventory-create:test-key');
	assert.deepEqual(requests, [
		{ url: '/api/inventory/list', body: { domain: 'inventory.example', accessToken: 'inventory-token' } },
		{
			url: '/api/inventory/create',
			body: {
				domain: 'inventory.example', accessToken: 'inventory-token', title: 'August', points,
				deadline: '2026-08-31', createdById: '1', notifyUserIds: ['1', '986'], sectionIds: [4, 5],
				idempotencyKey: 'inventory-create:test-key',
			},
		},
	]);
});

test('inventory point lifecycle preserves action payloads and draft keepalive metadata', async () => {
	const result = { counted: 1, total: 1, discrepancies: 1, lines: [{ productId: 42, name: 'Phone', book: 2, fact: 1, diff: -1 }] };
	const requests = captureResponses([
		{ ok: true },
		{ ok: true, draftUpdatedAt: '2026-08-06T12:00:00Z', ignored: false },
		{ ok: true },
		{ ok: true },
		{ ok: true },
	]);

	await claimPoint('inv-1', 7, '1', 'Admin');
	assert.deepEqual(await saveDraftPoint('inv-1', 7, '1', { 42: 1 }, { 42: 'missing' }, {
		userName: 'Admin', sessionId: 'session-1', sequence: 3, keepalive: true,
	}), { ok: true, draftUpdatedAt: '2026-08-06T12:00:00Z', ignored: false });
	await submitPoint('inv-1', 7, '1', 'Admin', result, { 42: 1 }, { 42: 'missing' });
	await makeActPoint('inv-1', 7, '1');
	await reopenPoint('inv-1', 7, '1');

	assert.deepEqual(requests.map((item) => item.body), [
		{ domain: 'inventory.example', accessToken: 'inventory-token', inventoryId: 'inv-1', storeId: 7, action: 'claim', userId: '1', userName: 'Admin' },
		{
			domain: 'inventory.example', accessToken: 'inventory-token', inventoryId: 'inv-1', storeId: 7,
			action: 'saveDraft', userId: '1', userName: 'Admin', draft: { 42: 1 }, comments: { 42: 'missing' },
			draftSessionId: 'session-1', draftSequence: 3,
		},
		{
			domain: 'inventory.example', accessToken: 'inventory-token', inventoryId: 'inv-1', storeId: 7,
			action: 'submit', userId: '1', userName: 'Admin', result, facts: { 42: 1 }, comments: { 42: 'missing' },
		},
		{ domain: 'inventory.example', accessToken: 'inventory-token', inventoryId: 'inv-1', storeId: 7, action: 'makeAct', userId: '1' },
		{ domain: 'inventory.example', accessToken: 'inventory-token', inventoryId: 'inv-1', storeId: 7, action: 'reopen', userId: '1' },
	]);
	assert.equal(requests[1]!.keepalive, true);
});

test('inventory deletion preserves authenticated endpoint payload', async () => {
	const requests = captureResponses([{ ok: true }]);
	await deleteInventory('inv-1');
	assert.deepEqual(requests[0], {
		url: '/api/inventory/delete',
		body: { domain: 'inventory.example', accessToken: 'inventory-token', inventoryId: 'inv-1' },
	});
});

test('ERP inventory documents preserve preview fallbacks and save-submit endpoints', async () => {
	const draft = {
		issue: { name: 'STE-I', status: 'draft', lines: 1 },
		receipt: { name: 'STE-R', status: 'draft', lines: 1 },
	};
	const submitted = {
		issue: { name: 'STE-I', status: 'submitted', lines: 1 },
		receipt: { name: 'STE-R', status: 'submitted', lines: 1 },
	};
	const requests = captureResponses([
		{ ok: true },
		{ ok: true, docs: draft, legacyDoc: null },
		{ ok: true, docs: submitted, legacyDoc: null },
	]);

	assert.deepEqual(await previewErpDoc('inv-1', 7), { lines: [], docs: {}, legacyDoc: null });
	assert.deepEqual(await saveErpDoc('inv-1', 7, true), { docs: draft, legacyDoc: null });
	assert.deepEqual(await submitErpDoc('inv-1', 7), { docs: submitted, legacyDoc: null });
	assert.deepEqual(requests, [
		{ url: '/api/inventory/erp-doc-preview', body: { domain: 'inventory.example', accessToken: 'inventory-token', inventoryId: 'inv-1', storeId: 7 } },
		{ url: '/api/inventory/erp-doc-save', body: { domain: 'inventory.example', accessToken: 'inventory-token', inventoryId: 'inv-1', storeId: 7, recreate: true } },
		{ url: '/api/inventory/erp-doc-submit', body: { domain: 'inventory.example', accessToken: 'inventory-token', inventoryId: 'inv-1', storeId: 7 } },
	]);
});

test('mobile inventory retries an expired token through the server session without exposing tokens', async () => {
	const browserWindow = window;
	const previous = browserWindow.__B24_CONTEXT__;
	browserWindow.__B24_CONTEXT__ = {
		dealId: null,
		domain: 'inventory.example',
		memberId: null,
		mobileSession: true,
	};
	try {
		const requests = captureResponses([
			{ ok: false, error: 'expired_token: The access token provided has expired.' },
			{ ok: true, draftUpdatedAt: '2026-08-18T12:00:00Z' },
		]);
		assert.deepEqual(await saveDraftPoint('inv-mobile', 7, '9', { 42: 1 }, {}, {
			userName: 'Counter', sessionId: 'mobile-session', sequence: 4,
		}), { ok: true, draftUpdatedAt: '2026-08-18T12:00:00Z' });
		assert.equal(requests.length, 2);
		assert.deepEqual(requests[0]?.body, {
			domain: 'inventory.example', mobileSession: true,
			inventoryId: 'inv-mobile', storeId: 7, action: 'saveDraft', userId: '9', userName: 'Counter',
			draft: { 42: 1 }, comments: {}, draftSessionId: 'mobile-session', draftSequence: 4,
		});
		assert.deepEqual(requests[1]?.body, { ...requests[0]?.body, mobileRefresh: true });
		assert.equal('accessToken' in (requests[0]?.body ?? {}), false);
	} finally {
		if (previous) browserWindow.__B24_CONTEXT__ = previous;
		else delete browserWindow.__B24_CONTEXT__;
	}
});

test('ERP inventory API keeps legacy reconciliation documents readable', async () => {
	const legacy = { name: 'RECO-1', status: 'submitted', lines: 2 };
	captureResponses([{ ok: true, lines: [], doc: legacy }]);
	assert.deepEqual(await previewErpDoc('inv-old', 7), { lines: [], docs: {}, legacyDoc: legacy });
});
