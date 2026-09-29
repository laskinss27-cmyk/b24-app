import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { freezeInventoryResultPrices } from './inventory-price-snapshot.js';
import { registerInventoryReadRoutes } from './api-inventory-read-routes.js';
import { withInventoryUpdateLock } from './api-inventory-update-lock.js';

function fixture() {
	let price = 125;
	let failWrite = false;
	let writes = 0;
	let priceReads = 0;
	let stored = { ID: '42', NAME: 'Инвентаризация', DETAIL_TEXT: JSON.stringify({
		status: 'closed', metadata: 'preserved', points: [{ storeId: 7, status: 'reconciled', draft: { 1: 2 },
			erpDocs: { issue: { name: 'STE-1', status: 'submitted' } },
			result: { lines: [{ productId: 1, book: 3, fact: 2, diff: -1 },
				{ productId: 2, book: 0, fact: 1, diff: 1, purchase: 90 },
				{ productId: 3, book: 0, fact: 2, diff: 2, purchase: 0 }] } }],
	}) };
	const call = async (method: string, params: Record<string, unknown>) => {
		if (method === 'entity.add') return true;
		if (method === 'entity.item.get') {
			assert.deepEqual(params['FILTER'], { ID: '42' });
			return [structuredClone(stored)];
		}
		assert.equal(method, 'entity.item.update');
		if (failWrite) throw new Error('Хранилище недоступно');
		writes++;
		stored = { ...stored, DETAIL_TEXT: String(params['DETAIL_TEXT']) };
		return true;
	};
	const erp = { list: async (doctype: string) => {
		priceReads++;
		return doctype === 'Item Price' ? [{ item_code: '1', price_list_rate: price }] : [];
	} } as unknown as ErpClient;
	return { call, client: { call } as unknown as B24Client, erp,
		item: () => structuredClone(stored), data: () => JSON.parse(stored.DETAIL_TEXT),
		setData: (data: unknown) => { stored.DETAIL_TEXT = JSON.stringify(data); },
		setPrice: (value: number) => { price = value; }, failWrites: () => { failWrite = true; },
		writes: () => writes, reads: () => priceReads };
}

test('list saves first legacy purchase price and later catalog changes do not revalue history', async (t) => {
	const f = fixture();
	t.mock.method(B24Client.prototype, 'call', f.call);
	t.mock.method(B24Client.prototype, 'callWithMeta', async () => ({ result: [f.item()] }));
	t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	const before = f.data();
	const app = Fastify();
	app.decorate('config', { portalDomain: 'test.example' } as typeof app.config);
	registerInventoryReadRoutes(app);
	t.after(() => app.close());
	const read = async () => (await app.inject({ method: 'POST', url: '/api/inventory/list', payload: { domain: 'test.example', accessToken: 'test' } })).json();
	const first = await read();
	assert.equal(first.ok, true);
	assert.equal(first.inventories[0].points[0].result.lines[0].purchase, 125);
	assert.equal(f.data().points[0].result.lines[0].purchase, 125);
	assert.ok(f.data().points[0].result.lines[0].purchaseFixedAt);
	f.setPrice(999);
	const second = await read();
	assert.equal(second.inventories[0].points[0].result.lines[0].purchase, 125);
	assert.equal(f.writes(), 1);
	assert.equal(f.reads(), 2); // Item Price + Item only once, no subsequent ERP reads.
	const after = f.data();
	delete after.points[0].result.lines[0].purchase;
	delete after.points[0].result.lines[0].purchaseFixedAt;
	assert.deepEqual(after, before, 'only missing price and its timestamp may change');
});

test('concurrent first reads preserve a newer inventory update and write prices once', async () => {
	const f = fixture();
	const stale = f.item();
	const update = withInventoryUpdateLock('42', async () => {
		const data = f.data();
		data.points[0].draft = { 1: 5 };
		data.points.push({ storeId: 8, status: 'in_progress', draft: { 10: 3 } });
		f.setData(data);
	});
	const [one, two] = await Promise.all([
		freezeInventoryResultPrices(f.client, f.erp, stale),
		freezeInventoryResultPrices(f.client, f.erp, stale),
	]);
	await update;
	assert.deepEqual(f.data().points[0].draft, { 1: 5 });
	assert.equal(f.data().points.length, 2);
	assert.equal(one.DETAIL_TEXT, two.DETAIL_TEXT);
	assert.equal(f.writes(), 1);
});

test('storage failure is an error, never an apparently fixed transient price', async (t) => {
	const f = fixture();
	f.failWrites();
	t.mock.method(B24Client.prototype, 'call', f.call);
	t.mock.method(B24Client.prototype, 'callWithMeta', async () => ({ result: [f.item()] }));
	t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	const app = Fastify();
	app.decorate('config', { portalDomain: 'test.example' } as typeof app.config);
	registerInventoryReadRoutes(app);
	t.after(() => app.close());
	const response = await app.inject({ method: 'POST', url: '/api/inventory/list', payload: { domain: 'test.example', accessToken: 'test' } });
	assert.equal(response.json().ok, false);
	assert.equal(response.json().inventories, undefined);
	assert.equal(f.data().points[0].result.lines[0].purchase, undefined);
});

test('saved zero is preserved, null is missing, and unknown cost is not invented as zero', async () => {
	const f = fixture();
	const data = f.data();
	data.points[0].result.lines[0].purchase = null;
	data.points[0].result.lines.push({ productId: 4, book: 1, fact: 0, diff: -1 });
	f.setData(data);
	await freezeInventoryResultPrices(f.client, f.erp, f.item());
	const lines = f.data().points[0].result.lines;
	assert.equal(lines[0].purchase, 125);
	assert.equal(lines[1].purchase, 90);
	assert.equal(lines[2].purchase, 0);
	assert.equal(lines[3].purchase, undefined);
	assert.equal(lines[3].purchaseFixedAt, undefined);
});

test('fully valued results remain available without reading catalog or writing inventory', async () => {
	const f = fixture();
	const data = f.data();
	data.points[0].result.lines[0].purchase = 7;
	f.setData(data);
	const item = f.item();
	assert.equal(await freezeInventoryResultPrices(f.client, f.erp, item), item);
	assert.equal(f.reads(), 0);
	assert.equal(f.writes(), 0);
});
