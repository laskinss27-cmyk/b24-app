import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { calculateDealFulfillment } from './deal-fulfillment.js';
import { newDealReturnRequestData, normalizeDealReturnRequestLines, parseDealReturnRequestItem } from './deal-return-request-model.js';
import type { ErpRealization } from './erp/operations.js';
import { registerDealCoreRealizationRoute } from './routes/deal-core-realization-route.js';
import { ErpClient } from './erp/client.js';
import { SUPPLY_DEPARTMENT_ID } from '@b24-app/shared';
import { buildRepairsContext } from './handlers/placement-context.js';

const realization = (name: string, qty: number, isReturn = false): ErpRealization => ({
	name,
	dealId: '77',
	postingDate: '2026-09-20',
	submitted: true,
	isReturn,
	returnAgainst: isReturn ? 'DN-1' : '',
	grandTotal: 0,
	items: [{ productId: 42, itemName: 'Брелок', qty, storeTitle: 'Склад', rate: 0, rowName: '', sourceRow: '', segmentId: 'base' }],
});

const plan = [{ productId: 42, itemName: 'Брелок', qty: 2, rate: 0, priceListRate: 0, discountPercent: 0, delivered: 0, isService: false, lineKey: '42' }];

test('full submitted return changes fulfillment to НЕТ without deleting the fixed plan', () => {
	assert.equal(calculateDealFulfillment(plan, [realization('DN-1', 2)]), 'ДА');
	assert.equal(calculateDealFulfillment(plan, [realization('DN-1', 2), realization('RET-1', -2, true)]), 'НЕТ');
});

test('legacy empty plan after a full return is also НЕТ', () => {
	assert.equal(calculateDealFulfillment([], [realization('DN-1', 2), realization('RET-1', -2, true)]), 'НЕТ');
});

test('return request model normalizes lines and preserves closed result', () => {
	const lines = normalizeDealReturnRequestLines([
		{ productId: 42, name: 'Брелок', qty: 2, store: 'Склад' },
		{ productId: 0, qty: 1, store: 'Склад' },
	]);
	assert.deepEqual(lines, [{ productId: 42, name: 'Брелок', qty: 2, store: 'Склад' }]);
	const data = newDealReturnRequestData({ dealId: 77, dealTitle: 'Сделка', lines, note: 'Полный возврат', createdAt: 'now', createdById: '5', createdByName: 'Менеджер' });
	const parsed = parseDealReturnRequestItem({ ID: 9, NAME: 'Возврат', DETAIL_TEXT: JSON.stringify({ ...data, status: 'approved', returnDocuments: ['RET-1'] }) });
	assert.equal(parsed?.status, 'approved');
	assert.deepEqual(parsed?.returnDocuments, ['RET-1']);
});

test('return approval deep link opens the dedicated authenticated screen', () => {
	const context = buildRepairsContext({
		DOMAIN: 'portal.example',
		PLACEMENT: 'REST_APP_URI',
		PLACEMENT_OPTIONS: JSON.stringify({ returnRequest: 19, returnDecision: 'approve' }),
	});
	assert.equal(context.view, 'returnApproval');
	assert.equal(context.returnRequestId, 19);
	assert.equal(context.returnDecision, 'approve');
});

test('legacy direct return endpoint is blocked before any ERP mutation', async () => {
	const app = Fastify();
	registerDealCoreRealizationRoute(app, (() => ({ call: async () => ({}) })) as never, async () => undefined);
	const response = await app.inject({ method: 'POST', url: '/api/deal/realize-core', payload: { domain: 'portal', accessToken: 'token', dealId: 77, action: 'return', note: 'x', lines: [{ productId: 42, qty: 2, store: 'Склад' }] } });
	assert.equal(response.statusCode, 403);
	assert.match(String(response.json().error), /прямой возврат запрещён/);
	await app.close();
});

test('submitted realization cancellation requires supply access, deal ownership and no linked return', async () => {
	const originalFromEnv = ErpClient.fromEnv;
	const canceled: string[] = [];
	const logged: Array<{ operation: string; actor?: { id: string; name: string } }> = [];
	let supply = false;
	let linkedReturn = false;
	let dealId = '77';
	let itemCode = '42';
	const erp = {
		get: async () => ({ name: 'DN-1', b24_deal_id: dealId, is_return: 0, docstatus: 1, items: [{ item_code: itemCode }] }),
		list: async () => linkedReturn ? [{ name: 'RET-1' }] : [],
		cancel: async (_doctype: string, name: string) => { canceled.push(name); },
	} as unknown as ErpClient;
	ErpClient.fromEnv = () => erp;
	const app = Fastify();
	app.decorate('operationLog', { record: async (event: { operation: string; actor?: { id: string; name: string } }) => { logged.push(event); } } as never);
	registerDealCoreRealizationRoute(app, (() => ({ call: async (method: string) => method === 'user.current' ? { ID: '999', UF_DEPARTMENT: supply ? [SUPPLY_DEPARTMENT_ID] : [] } : { ID: 77 } })) as never, async () => undefined);
	const request = () => app.inject({ method: 'POST', url: '/api/deal/realize-core', payload: { domain: 'portal', accessToken: 'token', dealId: 77, action: 'cancel', names: ['DN-1'] } });
	try {
		assert.equal((await request()).statusCode, 403);
		supply = true;
		dealId = '78';
		assert.match(String((await request()).json().error), /не принадлежит сделке/);
		dealId = '77';
		itemCode = 'REPAIR-42';
		assert.match(String((await request()).json().error), /не является товарной реализацией/);
		itemCode = '42';
		linkedReturn = true;
		assert.match(String((await request()).json().error), /есть возврат/);
		assert.deepEqual(canceled, []);
		linkedReturn = false;
		assert.equal((await request()).json().canceled, 'DN-1');
		assert.deepEqual(canceled, ['DN-1']);
		assert.ok(logged.some((event) => event.operation === 'cancel' && event.actor?.id === '999'));
	} finally {
		ErpClient.fromEnv = originalFromEnv;
		await app.close();
	}
});
