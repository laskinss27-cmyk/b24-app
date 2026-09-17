import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { assertDealRealizationPurchasing } from './deal-realization-purchasing.js';
import { registerDealCoreRealizationRoute } from './deal-core-realization-route.js';

function fixture() {
	const core = new Map<number, unknown>();
	const legacy = new Map<number, unknown>();
	const lastPurchase = new Map<number, unknown>();
	const services = new Set<number>();
	const docs = new Map<string, Record<string, unknown>>();
	const writes: string[] = [];
	const reads: string[] = [];
	const client = {
		async call() { return { ID: '1' }; },
		async callBatch(calls: Record<string, unknown>) {
			return { result_error: {}, result: Object.fromEntries(Object.keys(calls).map(key => {
				const id = Number(key.slice(1));return [key, { product: { type: services.has(id) ? 7 : 1, purchasingPrice: legacy.get(id) } }];
			})) };
		},
	} as unknown as B24Client;
	const erp = {
		async list(dt: string, _fields: string[], filters: Array<[string, string, unknown]> = []) {
			reads.push(dt);
			const ids = ((filters.find(f => f[1] === 'in')?.[2] ?? []) as string[]).map(Number);
			if (dt === 'Item') return ids.map(id => ({ name: String(id), item_name: `Товар ${id}`, is_stock_item: services.has(id) ? 0 : 1, last_purchase_rate: lastPurchase.get(id) }));
			if (dt === 'Item Price') return ids.filter(id => core.has(id)).map(id => ({ item_code: String(id), price_list_rate: core.get(id) }));
			if (dt === 'Company') return [{ name: 'Test', abbr: 'T' }];
			if (dt === 'Delivery Note') return [...docs.values()];
			return [];
		},
		async get(dt: string, name: string) { return dt === 'Delivery Note' ? structuredClone(docs.get(name) ?? null) : { name }; },
		async submit(_dt: string, name: string) { writes.push(`submit:${name}`); },
		async create() { throw new Error('Unexpected create'); },
		async update() { throw new Error('Unexpected update'); },
	} as unknown as ErpClient;
	const doc = (name: string, id: number) => ({ name, docstatus: 0, b24_deal_id: '42', is_return: 0,
		items: [{ name: `${name}-ROW`, item_code: String(id), item_name: `Товар ${id}`, qty: 1, rate: 100, warehouse: 'Main - T', b24_deal_segment: 'base' }] });
	return { core, legacy, lastPurchase, services, docs, writes, reads, erp, client, doc };
}

test('missing, zero, negative and non-finite prices block goods; the error includes every product but no prices', async () => {
	for (const price of [null, 0, -1, NaN, Infinity]) {
		const f = fixture();if (price !== null) f.core.set(101, price);
		f.legacy.set(101, price === null ? null : 9999);
		await assert.rejects(assertDealRealizationPurchasing(f.erp, f.client, [{ productId: 101, rate: 500 }, { productId: 202, rate: 600 }]), /Товар 101.*Товар 202.*Обратитесь в снабжение/);
		assert.deepEqual(f.writes, []);
	}
});

test('catalog prices are fresh, prefer ERP, fall back to Bitrix, and use canonical aliases', async () => {
	const f = fixture();f.legacy.set(15882, 5200);f.core.set(16832, 2000);
	await assertDealRealizationPurchasing(f.erp, f.client, [{ productId: 15882, rate: 6000 }, { productId: 16680, rate: 3000 }]);
	f.core.set(15882, 0);
	await assert.rejects(assertDealRealizationPurchasing(f.erp, f.client, [{ productId: 15882, rate: 6000 }]), /15882/);
	f.core.set(15882, 5100);
	await assertDealRealizationPurchasing(f.erp, f.client, [{ productId: 15882, rate: 6000 }]);
});

test('submitted purchase document rate allows realization when Standard Buying is missing or zero', async () => {
	const f = fixture();
	f.core.set(101, 0);
	f.lastPurchase.set(101, 7493);
	f.lastPurchase.set(202, 1601);
	await assertDealRealizationPurchasing(f.erp, f.client, [{ productId: 101, rate: 9000 }, { productId: 202, rate: 2000 }]);
});

test('non-positive last purchase rate does not bypass missing catalog price', async () => {
	for (const value of [0, -1, NaN, Infinity]) {
		const f = fixture();
		f.core.set(101, 0);
		f.lastPurchase.set(101, value);
		await assert.rejects(assertDealRealizationPurchasing(f.erp, f.client, [{ productId: 101, rate: 9000 }]), /101/);
	}
});

test('services need no purchase price; pass-through consumables use the actual sale price', async () => {
	const f = fixture();f.services.add(9814001);
	await assertDealRealizationPurchasing(f.erp, f.client, [{ productId: 9814001, rate: 2000 }, { productId: 18612, rate: 10000 }]);
	assert.equal(f.reads.includes('Item Price'), false);
	await assert.rejects(assertDealRealizationPurchasing(f.erp, f.client, [{ productId: 18612, rate: 0 }]), /18612/);
});

test('catalog read errors fail closed instead of allowing realization', async t => {
	const f = fixture();t.mock.method(f.erp, 'list', async () => { throw new Error('ERP unavailable'); });
	await assert.rejects(assertDealRealizationPurchasing(f.erp, f.client, [{ productId: 101, rate: 100 }]), /ERP unavailable/);
	assert.deepEqual(f.writes, []);
});

test('HTTP checks all old drafts before any submit, rechecks corrected prices, ignores client service/price overrides', async t => {
	const f = fixture();f.core.set(101, 50);f.core.set(202, 0);
	f.docs.set('DN-1', f.doc('DN-1', 101));f.docs.set('DN-2', f.doc('DN-2', 202));
	t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	const app = Fastify();app.decorate('operationLog', { record: async () => undefined } as unknown as typeof app.operationLog);
	registerDealCoreRealizationRoute(app, () => f.client, async () => undefined);
	const post = (names = ['DN-1', 'DN-2']) => app.inject({ method: 'POST', url: '/api/deal/realize-core', payload: { dealId: 42, action: 'submit', names, isService: true, purchasingPrice: 999 } });
	try {
		let result = (await post()).json();assert.equal(result.ok, false);assert.match(result.error, /202.*снабжение/);assert.deepEqual(f.writes, []);
		f.core.set(202, 60);
		result = (await post()).json();assert.equal(result.ok, true, result.error);assert.deepEqual(f.writes, ['submit:DN-1', 'submit:DN-2']);
		f.writes.length = 0;f.docs.get('DN-2')!.b24_deal_id = '43';
		result = (await post()).json();assert.equal(result.ok, false);assert.deepEqual(f.writes, []);
	} finally { await app.close(); }
});

test('HTTP draft cannot disguise goods as services and does not create documents for missing prices', async t => {
	const f = fixture();t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	const app = Fastify();app.decorate('operationLog', { record: async () => undefined } as unknown as typeof app.operationLog);
	registerDealCoreRealizationRoute(app, () => f.client, async () => undefined);
	try {
		const response = await app.inject({ method: 'POST', url: '/api/deal/realize-core', payload: { action: 'draft', dealId: 42,
			groups: [{ storeTitle: 'Main', lines: [{ productId: 101, qty: 1, rate: 500, isService: true, purchasingPrice: 100 }] }] } });
		assert.equal(response.json().ok, false);assert.match(response.json().error, /Реализация запрещена.*101/);assert.deepEqual(f.writes, []);
	} finally { await app.close(); }
});

test('HTTP return drafts can still be submitted without current catalog purchase prices', async t => {
	const f = fixture();const returned = f.doc('DN-RETURN', 101);returned.is_return = 1;returned.items[0]!.qty = -1;f.docs.set(returned.name, returned);
	t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	const app = Fastify();app.decorate('operationLog', { record: async () => undefined } as unknown as typeof app.operationLog);
	registerDealCoreRealizationRoute(app, () => f.client, async () => undefined);
	try {
		const response = await app.inject({ method: 'POST', url: '/api/deal/realize-core', payload: { action: 'submit', dealId: 42, names: ['DN-RETURN'] } });
		assert.equal(response.json().ok, true, response.json().error);assert.deepEqual(f.writes, ['submit:DN-RETURN']);assert.equal(f.reads.includes('Item Price'), false);
	} finally { await app.close(); }
});
