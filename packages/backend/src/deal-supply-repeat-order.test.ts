import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { B24Client } from './b24/client.js';
import type { Config } from './config.js';
import { ErpClient } from './erp/client.js';
import { listCoreSupplyCards, type SupplyCard } from './deal-supply-cards.js';
import { validateDealRepeatOrder } from './deal-supply-repeat-order.js';
import { registerSupplyRequestRoutes } from './routes/api-supply-request-routes.js';

const line = { productId: 101, qty: 2 };
const closed: SupplyCard = { id: 0, title: 'MR-1', stageId: 'CORE:Completed', source: 'core', productIds: [101], closed: true };

test('repeat order requires all matching requests to finish and only orders the current shortage', () => {
	const remaining = new Map([[101, 3]]), stock = new Map([[101, 1]]);
	validateDealRepeatOrder([closed], [line], remaining, stock);
	assert.throws(() => validateDealRepeatOrder([closed, { ...closed, closed: false }], [line], remaining, stock), /ещё не выполнена/);
	assert.throws(() => validateDealRepeatOrder([closed], [{ ...line, qty: 3 }], remaining, stock), /не хватает 2/);
	assert.throws(() => validateDealRepeatOrder([closed], [line], remaining, new Map([[101, 3]])), /не хватает 0/);
	assert.throws(() => validateDealRepeatOrder([closed], [line, line], remaining, stock), /превышает нехватку/);
	validateDealRepeatOrder([{ ...closed, productIds: [202], closed: false }], [line], remaining, stock);
});

class SupplyErp {
	requests: Array<Record<string, unknown>> = [{ name: 'MR-1', creation: 'created', status: 'Draft', b24_deal_id: '32100991', b24_to_store: 'Точка', items: [{ item_code: '101', qty: 2 }] }];
	receipts: Array<Record<string, unknown>> = [];
	purchases: Array<Record<string, unknown>> = [];
	stock = 0;
	beforeCreate?: () => Promise<void>;
	async get(dt: string, name: string) {
		if (dt === 'Material Request') return this.requests.find((r) => r.name === name) ?? null;
		if (dt === 'Purchase Receipt') return this.receipts.find((r) => r.name === name) ?? null;
		if (dt === 'Purchase Order') return this.purchases.find((r) => r.name === name) ?? null;
		if (dt === 'Sales Order') return { name, items: [{ item_code: '101', qty: 2 }] };
		return {};
	}
	async list(dt: string) {
		if (dt === 'Material Request') return this.requests;
		if (dt === 'Purchase Receipt') return this.receipts;
		if (dt === 'Purchase Order') return this.purchases;
		if (dt === 'Company') return [{ name: 'Test', abbr: 'TEST' }];
		if (dt === 'Sales Order') return [{ name: 'SO-1' }];
		if (dt === 'Item') return [{ name: '101', is_stock_item: 1 }];
		if (dt === 'Bin') return [{ item_code: '101', warehouse: 'Точка - TEST', actual_qty: this.stock }];
		return [];
	}
	async create(dt: string, fields: Record<string, unknown>) {
		assert.equal(dt, 'Material Request');
		await this.beforeCreate?.();
		const doc = { ...fields, name: `MR-${this.requests.length + 1}`, creation: `new-${this.requests.length}`, status: 'Draft' };
		this.requests.push(doc);
		return doc;
	}
	asClient() { return this as unknown as ErpClient; }
}

function transfer(status: string, extra: Record<string, unknown> = {}) {
	return { ID: 1, DETAIL_TEXT: JSON.stringify({ supplyRequest: 'MR-1', supplyRequestKey: 'MR-1@created', dealId: '32100991',
		fromStore: 'Источник', toStore: 'Точка', status, lines: [{ productId: 101, name: 'Товар', qty: 2 }], ...extra }) };
}

function b24(transfers: Record<string, unknown>[], fail = false): B24Client {
	return { async call() { return {}; }, async callWithMeta() { if (fail) throw new Error('read failed'); return { result: transfers }; } } as unknown as B24Client;
}

test('deal cards use the same delivery coverage as supply: received, partial, corrections, stale request key and purchase receipts', async () => {
	const erp = new SupplyErp();
	const states: Array<[Record<string, unknown>[], boolean]> = [
		[[transfer('received')], true], [[transfer('posted')], true], [[transfer('in_transit')], false],
		[[transfer('shortage', { receivedLines: [{ productId: 101, qty: 1 }] })], false],
		[[transfer('received', { correctionOf: 99 })], false],
		[[transfer('received', { supplyRequestKey: 'MR-1@old' })], false],
	];
	for (const [transfers, expected] of states) {
		assert.equal((await listCoreSupplyCards(32100991, b24(transfers), erp.asClient()))[0]?.closed, expected);
	}
	erp.receipts = [{ name: 'PR-1', b24_supply_request: 'MR-1', b24_supply_request_key: 'MR-1@created', docstatus: 1,
		items: [{ item_code: '101', qty: 2, warehouse: 'Точка - TEST' }] }];
	// An orphan receipt must still have a request allocation; no purchase lines means no coverage.
	assert.equal((await listCoreSupplyCards(32100991, b24([]), erp.asClient()))[0]?.closed, false);
	erp.purchases = [{ name: 'PO-1', b24_supply_request: 'MR-1', b24_supply_request_key: 'MR-1@created',
		b24_supply_stage: 'ordered', items: [{ item_code: '101', qty: 2 }] }];
	erp.receipts[0]!['b24_purchase_order'] = 'PO-1';
	assert.equal((await listCoreSupplyCards(32100991, b24([]), erp.asClient()))[0]?.closed, true);
	erp.receipts[0]!['docstatus'] = 0;
	assert.equal((await listCoreSupplyCards(32100991, b24([]), erp.asClient()))[0]?.closed, false);
	erp.receipts[0]!['docstatus'] = 1;
	erp.receipts[0]!['items'] = [{ item_code: '101', qty: 2, warehouse: 'Другой склад - TEST' }];
	assert.equal((await listCoreSupplyCards(32100991, b24([]), erp.asClient()))[0]?.closed, false);
	await assert.rejects(listCoreSupplyCards(32100991, b24([], true), erp.asClient()), /реестр перемещений/);
});

test('server creates a fresh request after delivery, blocks next duplicate and simultaneous submission', async (t) => {
	const erp = new SupplyErp();
	t.mock.method(ErpClient, 'fromEnv', () => erp.asClient());
	t.mock.method(B24Client.prototype, 'call', async () => ({}));
	t.mock.method(B24Client.prototype, 'callWithMeta', async () => ({ result: [transfer('received')] }));
	const app = Fastify();
	app.decorate('config', { portalDomain: 'portal.example' } as Config);
	registerSupplyRequestRoutes(app, new Set());
	const payload = { domain: 'portal.example', accessToken: 'test', dealId: 32100991, note: 'Товар ушёл, требуется снова',
		toStore: 'Точка', deadline: '2099-10-01', lines: [line] };
	try {
		const original = JSON.stringify(erp.requests[0]);
		let release!: () => void;
		let arrived!: () => void;
		const creating = new Promise<void>((resolve) => { arrived = resolve; });
		erp.beforeCreate = async () => { arrived(); await new Promise<void>((resolve) => { release = resolve; }); };
		const first = app.inject({ method: 'POST', url: '/api/supply/request', payload });
		await creating;
		const simultaneous = await app.inject({ method: 'POST', url: '/api/supply/request', payload });
		assert.equal(simultaneous.statusCode, 409);
		release();
		assert.equal((await first).json().ok, true);
		assert.equal(erp.requests.length, 2);
		assert.equal(JSON.stringify(erp.requests[0]), original);
		const duplicate = await app.inject({ method: 'POST', url: '/api/supply/request', payload });
		assert.equal(duplicate.json().ok, false);
		assert.match(duplicate.json().error, /ещё не выполнена/);
		assert.equal(erp.requests.length, 2);
		t.mock.method(B24Client.prototype, 'callWithMeta', async () => { throw new Error('read failed'); });
		const unavailable = await app.inject({ method: 'POST', url: '/api/supply/request', payload });
		assert.equal(unavailable.json().ok, false);
		assert.match(unavailable.json().error, /реестр перемещений/);
		assert.equal(erp.requests.length, 2);
	} finally { await app.close(); }
});
