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
			accessToken: 'transfer-token',
		},
	} as Window,
});

const {
	cancelTransfer,
	cancelTransferRequest,
	collectTransfer,
	convertTransferRequest,
	createManualTransfer,
	createSupplyTtRequest,
	createTransferRequest,
	createTransfers,
	deleteTransfer,
	listTransferRequests,
	listTransfers,
	postTransfer,
	receiveTransfer,
	resolveTransferShortage,
	shipTransfer,
	updateTransferDestination,
	updateTransferLines,
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

const transfer = { id: 7, name: 'TR-7', status: 'draft', fromStore: 'Основной', toStore: 'Точка 2', lines: [] };
const request = { id: 3, name: 'REQ-3', status: 'pending', kind: 'transfer', fromStore: 'Основной', toStore: 'Точка 2', lines: [] };

test('transfer creation, listing, and manual creation preserve payloads and fallbacks', async () => {
	const requests = captureResponses([
		{ ok: true },
		{ ok: true, isSupply: 1 },
		{ ok: true, transfer },
	]);
	const lines = [{ productId: 17, name: 'Товар', qty: 2 }];
	const groups = [{ fromStore: 'Основной', lines }];

	assert.deepEqual(await createTransfers({ dealId: 91, toStore: 'Точка 2', groups }), []);
	assert.deepEqual(await listTransfers(91, { from: '2026-08-01', to: '2026-08-31' }), { transfers: [], isSupply: true });
	assert.deepEqual(await createManualTransfer({ fromStore: 'Основной', toStore: 'Точка 2', lines }), transfer);
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/transfers/create',
		'/api/transfers/list',
		'/api/transfers/create-manual',
	]);
	assert.deepEqual(requests[1]?.body, {
		domain: 'mobile.example', accessToken: 'transfer-token', dealId: 91, from: '2026-08-01', to: '2026-08-31',
	});
});

test('transfer request lifecycle preserves endpoint order and merged conversion payload', async () => {
	const requests = captureResponses([
		{ ok: true, request },
		{ ok: true, request: { ...request, kind: 'supply' } },
		{ ok: true },
		{ ok: true, request: { ...request, status: 'canceled' } },
		{ ok: true, request: { ...request, status: 'converted' }, transfer },
	]);
	const lines = [{ productId: 17, name: 'Товар', qty: 2 }];

	assert.deepEqual(await createTransferRequest({ fromStore: 'Основной', toStore: 'Точка 2', note: 'Заказ', lines }), request);
	assert.equal((await createSupplyTtRequest({ toStore: 'Точка 2', lines: [{ productId: 17, name: 'Товар', qty: 2 }] })).kind, 'supply');
	assert.deepEqual(await listTransferRequests(), { requests: [], isSupply: false });
	assert.equal((await cancelTransferRequest(3)).status, 'canceled');
	assert.deepEqual(await convertTransferRequest(3, { fromStore: 'Основной', toStore: 'Точка 2', note: 'Конвертация', lines }), {
		request: { ...request, status: 'converted' }, transfer,
	});
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/transfer-requests/create',
		'/api/transfer-requests/create-supply',
		'/api/transfer-requests/list',
		'/api/transfer-requests/cancel',
		'/api/transfer-requests/convert',
	]);
	assert.deepEqual(requests[4]?.body, {
		domain: 'mobile.example', accessToken: 'transfer-token', id: 3,
		fromStore: 'Основной', toStore: 'Точка 2', note: 'Конвертация', lines,
	});
});

test('transfer editing and warning-producing actions preserve response mapping', async () => {
	const requests = captureResponses([
		{ ok: true, transfer: { ...transfer, toStore: 'Точка 3' } },
		{ ok: true, transfer },
		{ ok: true, warning: 'Неполная сборка', transfer },
		{ ok: true, warning: 'Проверить транзит', transfer },
		{ ok: true, warning: 'Есть недовоз', transfer },
	]);
	const quantities = [{ productId: 17, qty: 1 }];

	assert.equal((await updateTransferDestination(7, 'Точка 3')).toStore, 'Точка 3');
	assert.deepEqual(await updateTransferLines(7, quantities), transfer);
	assert.equal((await collectTransfer(7, quantities)).actionWarning, 'Неполная сборка');
	assert.equal((await shipTransfer(7)).actionWarning, 'Проверить транзит');
	assert.equal((await receiveTransfer(7, [])).actionWarning, 'Есть недовоз');
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/transfers/update-destination',
		'/api/transfers/update-lines',
		'/api/transfers/collect',
		'/api/transfers/ship',
		'/api/transfers/receive',
	]);
	assert.deepEqual(requests[4]?.body, {
		domain: 'mobile.example', accessToken: 'transfer-token', id: 7, lines: [],
	});
});

test('final transfer actions preserve their endpoints and return values', async () => {
	const requests = captureResponses([
		{ ok: true, transfer: { ...transfer, status: 'posted' } },
		{ ok: true, transfer: { ...transfer, status: 'canceled' } },
		{ ok: true, transfer: { ...transfer, status: 'received' } },
		{ ok: true },
	]);

	assert.equal((await postTransfer(7)).status, 'posted');
	assert.equal((await cancelTransfer(7)).status, 'canceled');
	assert.equal((await resolveTransferShortage(7)).status, 'received');
	await deleteTransfer(7);
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/transfers/post',
		'/api/transfers/cancel',
		'/api/transfers/resolve-shortage',
		'/api/transfers/delete',
	]);
});
