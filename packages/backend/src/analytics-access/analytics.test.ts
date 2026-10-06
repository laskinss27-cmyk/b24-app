import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { ErpClient } from '../erp/client.js';
import { AnalyticsKeyStore } from './store.js';
import { analyticsReadClient, readAnalyticsCatalog, type AnalyticsCatalog } from './catalog.js';
import { registerAnalyticsReadRoutes } from './routes.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

async function fixture(t: import('node:test').TestContext) {
	const dir = await mkdtemp(join(tmpdir(), 'analytics-read-'));
	const file = join(dir, 'keys.sqlite'), store = new AnalyticsKeyStore(file);
	t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
	return { store, file, key: store.create(3712, 'Сергей Посягин — маркетплейсы') };
}

const data: AnalyticsCatalog = {
	readStartedAt: '2026-10-06T08:00:00Z', generatedAt: '2026-10-06T08:00:01Z',
	warehouses: [{ id: 'W', name: 'Склад', type: '', disabled: false }],
	products: [1,2,3].map(id => ({ id, oldId: '00'+id, article: 'A'+id, name: 'Товар', brand: '', model: '', section: '', status: '', unit: 'шт', purchasePrice: id === 3 ? null : 100,
		stocks: [{ warehouseId: 'W', physicalQuantity: id }] })),
};

test('individual keys are hashed, persisted and immediately revocable across connections', async t => {
	const f = await fixture(t), other = new AnalyticsKeyStore(f.file);
	try {
	assert.equal(other.authenticate('Bearer '+f.key.token)?.ownerId, 3712);
	assert.equal(f.store.authenticate('Bearer '+f.key.token.slice(0,-1)+'!'), null);
	assert.equal(f.store.authenticate('Basic '+f.key.token), null);
	assert.ok(!JSON.stringify(f.store.list()).includes(f.key.token));
	assert.ok(!(await readFile(f.file)).includes(Buffer.from(f.key.token)));
	assert.ok(!(await readFile(f.file+'-wal')).includes(Buffer.from(f.key.token)));
	assert.equal(other.revoke(f.key.id), true);
	assert.equal(f.store.authenticate('Bearer '+f.key.token), null);
	assert.equal(f.store.revoke(f.key.id), false);
	} finally { other.close(); }
});

test('API rejects missing/revoked credentials and writes without reading ERP', async t => {
	const f = await fixture(t), app = Fastify(); let reads = 0;
	registerAnalyticsReadRoutes(app, { store: f.store, load: async () => { reads++; return data; } });
	t.after(() => app.close());
	const url = '/api/analytics/v1/catalog';
	assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
	assert.equal((await app.inject({ method: 'GET', url: url+'?token='+encodeURIComponent(f.key.token) })).statusCode, 401);
	for (const method of ['POST','PUT','PATCH','DELETE'] as const) assert.equal((await app.inject({ method, url, headers: { authorization: 'Bearer '+f.key.token } })).statusCode, 404);
	f.store.revoke(f.key.id);
	assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer '+f.key.token } })).statusCode, 401);
	assert.equal(reads, 0);
});

test('bounded pages use one immutable snapshot, including after a newer read; expired cursors require restart', async t => {
	const f = await fixture(t), app = Fastify(); let clock = 100_000, reads = 0;
	registerAnalyticsReadRoutes(app, { store: f.store, now: () => clock, load: async () => { reads++; return structuredClone(data); } });
	t.after(() => app.close());
	const get = (q = '') => app.inject({ method: 'GET', url: '/api/analytics/v1/catalog'+q, headers: { authorization: 'Bearer '+f.key.token } });
	const a = await get('?limit=2'), first = a.json();
	assert.equal(a.headers['cache-control'], 'no-store'); assert.equal(first.total, 3);
	assert.deepEqual(first.products.map((r: {id:number}) => r.id), [1,2]);
	const second = (await get('?limit=2&cursor='+first.nextCursor)).json();
	assert.equal(second.snapshotId, first.snapshotId); assert.equal(second.products[0].purchasePrice, null); assert.equal(second.nextCursor, null);
	assert.equal(reads, 1);
	clock += 61_000;
	assert.notEqual((await get()).json().snapshotId, first.snapshotId);
	assert.equal((await get('?cursor='+first.nextCursor)).json().snapshotId, first.snapshotId);
	clock += 300_000;
	assert.equal((await get('?cursor='+first.nextCursor)).statusCode, 410);
});

test('unknown query parameters, arbitrary doctypes and excessive limits cannot broaden the export', async t => {
	const f = await fixture(t), app = Fastify(); let reads = 0;
	registerAnalyticsReadRoutes(app, { store: f.store, load: async () => { reads++; return data; } });
	t.after(() => app.close());
	for (const q of ['limit=0','limit=501','limit=x','fields=*','doctype=User','ownerId=1','cursor=../../secrets']) {
		assert.equal((await app.inject({ method: 'GET', url: '/api/analytics/v1/catalog?'+q, headers: { authorization: 'Bearer '+f.key.token } })).statusCode, 400);
	}
	assert.equal(reads, 0);
});

test('concurrent requests share the source read, failures are explicit and temporarily backed off', async t => {
	const f = await fixture(t), app = Fastify(); let reads = 0, clock = 100_000, fail = false;
	registerAnalyticsReadRoutes(app, { store: f.store, now: () => clock, load: async () => { reads++; await new Promise(r => setTimeout(r, 15)); if (fail) throw new Error('ERP credential must not escape'); return data; } });
	t.after(() => app.close());
	const get = () => app.inject({ method: 'GET', url: '/api/analytics/v1/catalog', headers: { authorization: 'Bearer '+f.key.token } });
	await Promise.all([get(),get(),get()]); assert.equal(reads, 1);
	fail = true; clock += 61_000;
	const unavailable = await get(); assert.equal(unavailable.statusCode, 503); assert.ok(!unavailable.body.includes('credential'));
	assert.equal((await get()).statusCode, 503); assert.equal(reads, 2);
	clock += 11_000; fail = false; assert.equal((await get()).statusCode, 200);
});

test('per-key rate limit protects ERP and resets independently', async t => {
	const f = await fixture(t), app = Fastify(); let clock = 100_000, reads = 0;
	registerAnalyticsReadRoutes(app, { store: f.store, now: () => clock, load: async () => { reads++; return data; } });
	t.after(() => app.close());
	const get = () => app.inject({ method: 'GET', url: '/api/analytics/v1/catalog', headers: { authorization: 'Bearer '+f.key.token } });
	for (let i=0;i<60;i++) assert.equal((await get()).statusCode, 200);
	const limited = await get(); assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '60'); assert.equal(reads, 1);
	clock += 60_000; assert.equal((await get()).statusCode, 200);
});

test('catalog read exports only approved fields, keeps physical negative stock and uses current purchase resolver', async () => {
	let writes = 0;
	const source = {
		async list(type: string, fields: string[], filters: unknown[]) {
			if (type === 'Item' && fields.includes('item_name')) {
				assert.ok(filters.some(f => JSON.stringify(f) === JSON.stringify(['is_stock_item','=',1])));
				return [{ name: '10', item_name: 'Камера', b24_marketplace_old_id: '0010', stock_uom: 'шт', secret: 'never-export' }];
			}
			if (type === 'Bin') return [{ item_code: '10', warehouse: 'W', actual_qty: -2 }];
			if (type === 'Warehouse') return [{ name: 'W', warehouse_name: 'Склад', warehouse_type: 'Transit', disabled: 0 }];
			if (type === 'Item Price') return [{ item_code: '10', price_list: 'Standard Buying', price_list_rate: 100, modified: '2026-09-01' }];
			if (type === 'Purchase Receipt') return [{ item_code: '10', docstatus: 1, is_return: 0, qty: 1, base_rate: 240, conversion_factor: 2, posting_date: '2026-10-01', posting_time: '10:00:00', modified: '2026-10-01' }];
			if (type === 'Item') return [{ name: '10', valuation_rate: 30 }];
			throw new Error('Unexpected read '+type);
		},
		async create() { writes++; }, async update() { writes++; },
	} as unknown as ErpClient;
	const result = await readAnalyticsCatalog(source);
	assert.equal(result.products[0]?.purchasePrice, 120); assert.equal(result.products[0]?.oldId, '0010');
	assert.equal(result.products[0]?.stocks[0]?.physicalQuantity, -2); assert.ok(!JSON.stringify(result).includes('secret'));
	assert.throws(() => analyticsReadClient(source).create('X', {}), /list reads only/);
	assert.equal(writes, 0);
});

test('stock source failure is never exported as zero stock', async () => {
	const erp = { async list(type: string) { if (type === 'Bin') throw new Error('Stock down'); return []; } } as unknown as ErpClient;
	await assert.rejects(readAnalyticsCatalog(erp), /Stock down/);
});

test('analytics key does not authorize existing ERP write routes or modify Bitrix roles', async t => {
	const f = await fixture(t);
	const app = await buildApp({ config: { ...loadConfig(), nodeEnv: 'test' } });
	t.after(() => app.close());
	for (const url of ['/api/catalog/update-product','/api/catalog/update-purchase-price','/api/deal/realize-core']) {
		const r = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer '+f.key.token }, payload: { action: 'submit', dealId: 1, productId: 10 } });
		assert.equal(r.statusCode, 403, r.body);
	}
});
