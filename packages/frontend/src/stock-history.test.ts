import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown> }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: {
		__B24_CONTEXT__: { dealId: null, domain: 'mobile.example', memberId: null, accessToken: 'history-token' },
	} as Window,
});

const { fetchDocDetail, fetchItemHistory, fetchMovements, fetchReservations } = await import('./b24.js');
const { filterAndSortReservations } = await import('./reservation-view.js');

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
		kind: 'issue' as const, amendedFrom: '', editBlockedReason: '', allowAddLines: true, canEdit: true, history: [],
	};
	const pendingDeals = [{
		dealId: '91', title: 'Монтаж офиса', ownerName: 'Иван Иванов', planName: 'SO-1',
		plannedQty: 4, shippedQty: 1, pendingQty: 3, deliveryDate: '2026-09-30',
	}];
	const requests = captureResponses([{ ok: true }, { ok: true, detail }, { ok: true, pendingDeals }]);

	assert.deepEqual(await fetchMovements('issue', { from: '2026-08-01', to: '2026-08-31', productId: 17 }), []);
	assert.deepEqual(await fetchDocDetail('Stock Entry', 'STE-1'), detail);
	assert.deepEqual(await fetchItemHistory(17), { movements: [], pendingDeals });
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

test('reservation registry reads rows and can force a fresh scan', async () => {
	const row = {
		key: '91:7:10', dealId: 91, dealTitle: 'Монтаж офиса', managerName: 'Иван Иванов', rowId: '7', reserveId: '10',
		productId: 17, productName: 'Камера', storeId: 8, storeName: 'Дунайский 64', quantity: 2,
		endDate: '2026-09-30', firstSeenAt: '2026-09-20T10:00:00Z', lastSeenAt: '2026-09-22T10:00:00Z', endedAt: '',
		status: 'active' as const, requestNotification: 'sent' as const, expiryNotification: 'pending' as const,
	};
	const requests = captureResponses([{ ok: true, rows: [row], scannedAt: '2026-09-22T10:00:00Z', notificationsEnabled: true }]);

	assert.deepEqual(await fetchReservations(true), {
		rows: [row], scannedAt: '2026-09-22T10:00:00Z', notificationsEnabled: true,
	});
	assert.deepEqual(requests[0], {
		url: '/api/reservations/list',
		body: { domain: 'mobile.example', accessToken: 'history-token', refresh: true },
	});
});

test('reservation registry searches across deal, product and store and sorts urgent statuses first', () => {
	const base = {
		dealTitle: 'Монтаж офиса', managerName: 'Иван Иванов', rowId: '7', reserveId: '10', productId: 17,
		productName: 'Камера', storeId: 8, storeName: 'Дунайский 64', quantity: 2, endDate: '2026-09-30',
		firstSeenAt: '2026-09-20T10:00:00Z', lastSeenAt: '2026-09-22T10:00:00Z', endedAt: '',
		requestNotification: 'sent' as const, expiryNotification: 'pending' as const,
	};
	const rows = [
		{ ...base, key: 'active', dealId: 91, status: 'active' as const },
		{ ...base, key: 'urgent', dealId: 92, dealTitle: 'Домофон', productName: 'Панель', status: 'ending_today' as const },
	];
	assert.deepEqual(filterAndSortReservations(rows, '', 'all', 'status').map((row) => row.key), ['urgent', 'active']);
	assert.deepEqual(filterAndSortReservations(rows, 'дунайский', 'active', 'status').map((row) => row.key), ['active']);
	assert.deepEqual(filterAndSortReservations(rows, 'домофон', 'all', 'status').map((row) => row.key), ['urgent']);
});
