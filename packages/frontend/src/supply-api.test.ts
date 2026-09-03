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
			accessToken: 'supply-token',
		},
	} as Window,
});

const {
	createDealSupplyRequest,
	createStandaloneSupplyPurchase,
	createSupplyDocuments,
	createSupplyPurchaseOrder,
	createSupplyPurchaseTransfer,
	createSupplySupplier,
	deleteSupplyPurchaseOrder,
	fetchSupplyOrders,
	fetchSupplySuppliers,
	receiveSupplyPurchase,
	removeSupplyRequestLineRemainder,
	updateSupplyOrderNote,
	updateSupplyOrderStore,
	updateSupplyPurchaseOrder,
	updateSupplyPurchaseStage,
	updateSupplyRequestLine,
} = await import('./b24.js');
const {
	createDealReservation, createSupplyReservation, fetchDealReservations, fetchReservationsRegistry, lookupReservationDeal,
	releaseSupplyReservation, reviewReservationRequest, setSupplyReservationDeal,
} = await import('./reservation-api.js');

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

test('supply order listing rejects backend errors and request creation requires a confirmed document number', async () => {
	const requests = captureResponses([{ ok: false, error: 'supply unavailable' }, { ok: true, name: 'MAT-MR-2026-00104' }, { ok: true }]);
	const lines = [{ productId: 17, itemName: 'Товар', qty: 2, note: 'Срочно' }];

	await assert.rejects(fetchSupplyOrders(), /supply unavailable/);
	assert.equal(await createDealSupplyRequest(91, lines, {
		toStore: 'Основной склад',
		deadline: '2026-08-20',
		note: 'Для сделки',
	}), 'MAT-MR-2026-00104');
	await assert.rejects(createDealSupplyRequest(91, lines, {
		toStore: 'Основной склад',
		deadline: '2026-08-20',
	}), /сервер не подтвердил создание/);
	assert.deepEqual(requests, [
		{
			url: '/api/supply/orders',
			body: { domain: 'mobile.example', accessToken: 'supply-token' },
		},
		{
			url: '/api/supply/request',
			body: {
				domain: 'mobile.example', accessToken: 'supply-token', dealId: 91, lines,
				toStore: 'Основной склад', deadline: '2026-08-20', note: 'Для сделки',
			},
		},
		{
			url: '/api/supply/request',
			body: {
				domain: 'mobile.example', accessToken: 'supply-token', dealId: 91, lines,
				toStore: 'Основной склад', deadline: '2026-08-20',
			},
		},
	]);
});

test('supply request edits and partial document errors preserve current values and message', async () => {
	const requests = captureResponses([
		{ ok: true },
		{ ok: true },
		{ ok: true, requestQty: '3.5' },
		{
			ok: false,
			error: 'частичное выполнение',
			transfers: [{ id: 7, name: 'TR-7' }],
			purchases: ['PO-1'],
			updatedPurchases: ['PO-2'],
		},
	]);

	assert.equal(await updateSupplyOrderNote('MR-1', 'Комментарий'), '');
	assert.equal(await updateSupplyOrderStore('MR-1', 'request-key', 'Точка 2'), 'Точка 2');
	assert.equal(await updateSupplyRequestLine({
		requestName: 'MR-1',
		requestKey: 'request-key',
		rowName: 'ROW-1',
		productId: 17,
		nextProductId: 18,
		nextItemName: 'Новый товар',
		nextQty: 3,
	}), undefined);
	await assert.rejects(
		createSupplyDocuments({
			requestName: 'MR-1', requestKey: 'request-key', dealId: 91, toStore: 'Точка 2',
			lines: [{ productId: 18, itemName: 'Новый товар', qty: 3, action: 'purchase', supplier: 'Vendor' }],
		}),
		/частичное выполнение\. Уже созданы: TR-7, PO-1, PO-2 дополнен\. Список заявки обновлён\./,
	);
	assert.deepEqual(requests.map((request) => request.url), [
		'/api/supply/request-note',
		'/api/supply/request-store',
		'/api/supply/request-line',
		'/api/supply/create-documents',
	]);
	assert.deepEqual(requests[2]?.body, {
		domain: 'mobile.example',
		accessToken: 'supply-token',
		requestName: 'MR-1',
		requestKey: 'request-key',
		rowName: 'ROW-1',
		productId: 17,
		nextProductId: 18,
		nextItemName: 'Новый товар',
		nextQty: 3,
	});
});

test('successful supply document creation preserves empty collection fallbacks', async () => {
	captureResponses([{ ok: true }]);
	assert.deepEqual(await createSupplyDocuments({
		requestName: 'MR-1', requestKey: 'request-key', dealId: 91, toStore: 'Точка 2', lines: [],
	}), { transfers: [], purchases: [], updatedPurchases: [] });
});

test('removing a supply request line sends a remainder-only removal request', async () => {
	const requests = captureResponses([{ ok: true, requestQty: 0, removed: true }]);

	await removeSupplyRequestLineRemainder({
		requestName: 'MR-1',
		requestKey: 'request-key',
		rowName: 'ROW-1',
		productId: 17,
	});

	assert.deepEqual(requests, [{
		url: '/api/supply/request-line',
		body: {
			domain: 'mobile.example',
			accessToken: 'supply-token',
			requestName: 'MR-1',
			requestKey: 'request-key',
			rowName: 'ROW-1',
			productId: 17,
			removeRemainder: true,
		},
	}]);
});

test('supply purchase lifecycle rejects supplier errors and preserves endpoint order and transfer result', async () => {
	const transfer = { id: 7, name: 'TR-7', status: 'draft', fromStore: 'Основной', toStore: 'Точка 2', lines: [], receivedLines: [], shortageLines: [] };
	const requests = captureResponses([
		{ ok: true, name: 'PO-1' },
		{ ok: true, name: 'PO-2' },
		{ ok: true },
		{ ok: true },
		{ ok: false, error: 'suppliers unavailable' },
		{ ok: true, name: 'Vendor', created: false },
		{ ok: true, name: 'PO-1' },
		{ ok: true, name: 'PR-1' },
		{ ok: true, transfer },
	]);
	const purchaseLines = [{ productId: 17, itemName: 'Товар', qty: 2, rate: 800 }];

	assert.equal(await createSupplyPurchaseOrder('MR-1', 'request-key', 91, 'Vendor', purchaseLines), 'PO-1');
	assert.equal(await createStandaloneSupplyPurchase('Vendor', '2026-08-20', purchaseLines), 'PO-2');
	assert.equal(await updateSupplyPurchaseOrder('PO-1', 'Vendor', purchaseLines), '');
	await deleteSupplyPurchaseOrder('PO-3');
	await assert.rejects(fetchSupplySuppliers(), /suppliers unavailable/);
	assert.deepEqual(await createSupplySupplier('Vendor'), { name: 'Vendor', suppliers: ['Vendor'], created: false });
	assert.equal(await updateSupplyPurchaseStage('PO-1', 'ordered', '2026-08-20'), 'PO-1');
	assert.equal(await receiveSupplyPurchase('MR-1', 'request-key', 91, 'PO-1', [{ productId: 17, qty: 2, rate: 800 }]), 'PR-1');
	assert.deepEqual(await createSupplyPurchaseTransfer('MR-1', 'request-key', 91, 'PO-1', [{ productId: 17, qty: 2 }]), transfer);

	assert.deepEqual(requests.map((request) => request.url), [
		'/api/supply/purchase-order',
		'/api/supply/purchase-order/standalone',
		'/api/supply/purchase-order/update',
		'/api/supply/purchase-order/delete',
		'/api/supply/suppliers',
		'/api/supply/supplier/create',
		'/api/supply/purchase-stage',
		'/api/supply/purchase-receive',
		'/api/supply/purchase-transfer',
	]);
	assert.equal(requests[6]?.body['expectedAt'], '2026-08-20');
});

test('reservation API preserves deal lines, expiry and supply decision payloads', async () => {
	const requests = captureResponses([
		{ ok: true, enabled: true, canWrite: true, requests: [] },
		{ ok: true, request: { id: '1', requestKey: 'request-1', lines: [] } },
		{ ok: true },
	]);
	await fetchDealReservations(91);
	await createDealReservation({
		dealId: 91, requestedExpiresAt: '2026-09-08T12:00:00.000Z', comment: 'Срочный объект', requestKey: 'request-1',
		lines: [{ sourceLineKey: 'line-1', productId: 42, itemName: 'Камера', storeTitle: 'Склад', quantity: 2 }],
	});
	await reviewReservationRequest({ requestId: '1', decision: 'approve', approvedExpiresAt: '2026-09-07T12:00:00.000Z', idempotencyKey: 'decision-1' });
	assert.deepEqual(requests, [
		{ url: '/api/reservations/deal', body: { domain: 'mobile.example', accessToken: 'supply-token', dealId: 91 } },
		{ url: '/api/reservations/request', body: { domain: 'mobile.example', accessToken: 'supply-token', dealId: 91, requestedExpiresAt: '2026-09-08T12:00:00.000Z', comment: 'Срочный объект', requestKey: 'request-1', lines: [{ sourceLineKey: 'line-1', productId: 42, itemName: 'Камера', storeTitle: 'Склад', quantity: 2 }] } },
		{ url: '/api/reservations/supply/review', body: { domain: 'mobile.example', accessToken: 'supply-token', requestId: '1', decision: 'approve', approvedExpiresAt: '2026-09-07T12:00:00.000Z', idempotencyKey: 'decision-1' } },
	]);
});

test('reservation registry uses the read-only employee endpoint', async () => {
	const requests = captureResponses([{ ok: true, enabled: true, canWrite: false, requests: [] }]);
	assert.deepEqual(await fetchReservationsRegistry(), { ok: true, enabled: true, canWrite: false, requests: [] });
	assert.deepEqual(requests, [
		{ url: '/api/reservations/list', body: { domain: 'mobile.example', accessToken: 'supply-token' } },
	]);
});

test('supply reservation API preserves optional deal linkage and later relinking', async () => {
	const requests = captureResponses([
		{ ok: true, deal: { id: 91, title: 'Сделка', managerId: '7', managerName: 'Менеджер' } },
		{ ok: true, request: { id: '2', requestKey: 'manual-1', lines: [] }, warnings: ['У сделки уже есть резерв'] },
		{ ok: true, warnings: [] },
		{ ok: true },
	]);
	assert.equal((await lookupReservationDeal(91)).title, 'Сделка');
	assert.deepEqual(await createSupplyReservation({
		dealId: null, expiresAt: '2026-09-09T12:00:00.000Z', purpose: 'Витрина', comment: 'До пятницы', requestKey: 'manual-1',
		lines: [{ productId: 42, itemName: 'Камера', storeTitle: 'Склад', quantity: 1 }],
	}), { request: { id: '2', requestKey: 'manual-1', lines: [] }, warnings: ['У сделки уже есть резерв'] });
	assert.deepEqual(await setSupplyReservationDeal('5', 91, 'link-1'), []);
	await releaseSupplyReservation('5', 'Больше не нужен', 'release-1');
	assert.deepEqual(requests.map((request) => request.url), [
		'/api/reservations/supply/deal-lookup', '/api/reservations/supply/create',
		'/api/reservations/supply/set-deal', '/api/reservations/supply/release',
	]);
	assert.equal(requests[1]?.body['dealId'], null);
	assert.equal(requests[1]?.body['comment'], 'До пятницы');
	assert.equal(requests[2]?.body['dealId'], 91);
});
