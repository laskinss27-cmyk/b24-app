import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { canCopyCatalogProduct } from '../catalog-access.js';
import { registerCatalogProductCreateRoute } from './api-catalog-product-create-route.js';


test('copy permission uses verified exact IDs, not names, departments or portal admin', () => {
 for (const ID of [78, 3606, 1858, 1]) assert.equal(canCopyCatalogProduct({ ID }), true);
 for (const user of [null, { ID: 999, NAME: 'Даниил', LAST_NAME: 'Андропов', UF_DEPARTMENT: [10], ADMIN: true }, { ID: 1246 }]) assert.equal(canCopyCatalogProduct(user), false);
});

async function fixture(t: TestContext) {
 const writes: Array<{ type: string; id?: string; fields?: Record<string, unknown> }> = [];
 const items = new Map<string, Record<string, unknown>>([
 ['100', { name: '100', item_name: 'Исходный товар', is_stock_item: 1, b24_model: 'OLD', image: '/files/photo.jpg' }],
 ['101', { name: '101', item_name: 'Исходный комплект', is_stock_item: 1, b24_bundle_source_product: '100', b24_bundle_units: 3 }],
 ['102', { name: '102', item_name: 'Услуга', is_stock_item: 0 }],
 ]);
 let uid: number | null = 78, failRead = false;
 t.mock.method(B24Client.prototype, 'call', async (method: string, args: Record<string, unknown>) => {
  if (method === 'user.current') return uid ? { ID: uid, UF_DEPARTMENT: [10] } : null;
  if (method === 'catalog.product.list') return { products: [] };
  if (method === 'catalog.product.add') { writes.push({ type: 'b24-add', fields: args.fields as Record<string, unknown> }); return { element: { id: 900 } }; }
  if (method === 'catalog.product.delete') { writes.push({ type: 'b24-delete' }); return true; }
  throw Error('Unexpected B24 ' + method);
 });
 const fake = {
 get: async (type: string, id: string) => type === 'Item' ? items.get(id) ?? null : { name: id },
 list: async (type: string) => { if (type === 'Item') { if (failRead) throw Error('read failed'); return [...items.values()]; } if (type === 'Item Price') return []; throw Error('Unexpected list ' + type); },
 create: async (type: string, fields: Record<string, unknown>) => { writes.push({ type, fields }); if (type === 'Item') items.set(String(fields.item_code), fields); return { name: fields.item_code ?? 'price' }; },
 update: async (type: string, id: string, fields: Record<string, unknown>) => { writes.push({ type, id, fields }); if (type === 'Item') Object.assign(items.get(id)!, fields); return {}; },
 delete: async (type: string, id: string) => { writes.push({ type: 'delete:' + type, id }); },
 };
 t.mock.method(ErpClient, 'fromEnv', () => fake);
 const app = Fastify(); app.decorate('config', { portalDomain: 'test.bitrix24.ru' } as typeof app.config); registerCatalogProductCreateRoute(app); t.after(() => app.close());
 const payload = { domain: 'test.bitrix24.ru', accessToken: 'token', copySourceId: 100, productType: 'Новая модель', model: 'NEW', manufacturer: 'Brand', article: 'NEW', sectionId: 1, sectionName: 'Раздел', retail: 120, purchase: 80, summary: 'Описание', attributes: [{ key: 'wifi', label: 'Wi-Fi', type: 'boolean', rawValue: 'Да', filterable: true }], similarReviewed: true };
 const send = (patch: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/catalog/create-product', payload: { ...payload, ...patch } });
 return { writes, items, fake, app, payload, send, user: (id: number | null) => { uid = id; }, failRead: () => { failRead = true; } };
}

test('copy creates an independent card and prices, strips photo/stock/external ID, leaves original unchanged', async t => {
 const x = await fixture(t), before = structuredClone(x.items.get('100'));
 const r = await x.send({ photo: { content: 'ignored' }, image: '/files/original.jpg', total: 500, stockByStore: { 1: 50 }, marketplaceOldId: 'external' });
 assert.equal(r.json().status, 'created', r.body);
 assert.equal(r.json().product.id, 900); assert.equal(r.json().product.total, 0); assert.deepEqual(r.json().product.stockByStore, {});
 assert.equal(r.json().product.photoPath, undefined); assert.deepEqual(x.items.get('100'), before);
 assert.equal(x.items.get('900')?.image, undefined); assert.equal(x.items.get('900')?.b24_marketplace_old_id, undefined);
 assert.equal(JSON.parse(String(x.items.get('900')?.b24_catalog_content)).attributes[0].rawValue, 'Да');
 assert.deepEqual(x.writes.map(w => w.type), ['b24-add', 'Item', 'Item', 'Item Price', 'Item Price']);
});
test('Mark can copy a bundle and edit units without creating Repack or any stock movement', async t => {
 const x = await fixture(t); x.user(3606);
 const r = await x.send({ copySourceId: 101, bundle: { sourceProductId: 100, units: 5 } });
 assert.equal(r.json().status, 'created', r.body); assert.equal(r.json().product.isMarketplaceBundle, true);
 assert.equal(x.items.get('900')?.b24_bundle_source_product, '100'); assert.equal(x.items.get('900')?.b24_bundle_units, 5);
 assert.equal(x.items.get('101')?.b24_bundle_units, 3); assert.equal(x.writes.some(w => w.type === 'Stock Entry'), false);
});
test('copy denied for other supply staff and forged body identity, and missing OAuth identity', async t => {
 const x = await fixture(t);
 for (const id of [999, null]) { x.user(id); assert.equal((await x.send({ userId: 78, canCopyProduct: true })).statusCode, 403); }
 assert.equal(x.writes.length, 0);
 const r = await x.app.inject({ method: 'POST', url: '/api/catalog/copy-details', payload: { ...x.payload, productId: 100, userId: 78 } }); assert.equal(r.statusCode, 403);
});
test('copy preparation reads bundle without exposing photos and never writes', async t => {
 const x = await fixture(t);
 const r = await x.app.inject({ method: 'POST', url: '/api/catalog/copy-details', payload: { ...x.payload, productId: 101 } });
 assert.deepEqual(r.json(), { ok: true, isService: false, bundle: { sourceProductId: 100, units: 3 } }); assert.equal(x.writes.length, 0);
});
test('invalid bundle, nested bundle, service component and unavailable source fail before writes', async t => {
 const x = await fixture(t);
 for (const patch of [{ copySourceId: -1 }, { copySourceId: 999 }, { copySourceId: 101 }, { bundle: { sourceProductId: 100, units: 2 } }, ...[0, 1, 2.5].map(units => ({ copySourceId: 101, bundle: { sourceProductId: 100, units } })), ...[101, 102, 999].map(sourceProductId => ({ copySourceId: 101, bundle: { sourceProductId, units: 2 } }))]) assert.equal((await x.send(patch)).statusCode, 400);
 assert.equal(x.writes.length, 0);
});
test('ERP duplicate check stops unchanged card and repeat after successful creation, even when B24 metadata is empty', async t => {
 const x = await fixture(t);
 assert.equal((await x.send({ productType: 'Исходный товар', model: 'OTHER' })).json().status, 'duplicate'); assert.equal(x.writes.length, 0);
 assert.equal((await x.send()).json().status, 'created'); const count = x.writes.length;
 assert.equal((await x.send()).json().status, 'duplicate'); assert.equal(x.writes.length, count);
});
test('ERP duplicate read failure and unknown purchase block creation', async t => {
 const x = await fixture(t);
 for (const purchase of [null, '', ' ', -1]) assert.equal((await x.send({ purchase })).statusCode, 400);
 x.failRead(); assert.equal((await x.send()).json().ok, false); assert.equal(x.writes.length, 0);
});
test('source kind cannot be changed by copied payload', async t => {
 const x = await fixture(t);
 const r = await x.send({ copySourceId: 102, isService: false }); assert.equal(r.json().status, 'created'); assert.equal(r.json().product.isService, true); assert.equal(x.items.get('900')?.is_stock_item, 0);
});
