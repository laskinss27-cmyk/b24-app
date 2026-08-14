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
	updateSupplyOrderNote,
	updateSupplyOrderStore,
	updateSupplyPurchaseOrder,
	updateSupplyPurchaseStage,
	updateSupplyRequestLine,
} = await import('./b24.js');

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

test('supply order listing rejects backend errors and request creation preserves its payload', async () => {
	const requests = captureResponses([{ ok: false, error: 'supply unavailable' }, { ok: true }]);
	const lines = [{ productId: 17, itemName: 'Товар', qty: 2, note: 'Срочно' }];

	await assert.rejects(fetchSupplyOrders(), /supply unavailable/);
	assert.equal(await createDealSupplyRequest(91, lines, {
		toStore: 'Основной склад',
		deadline: '2026-08-20',
		note: 'Для сделки',
	}), '');
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
