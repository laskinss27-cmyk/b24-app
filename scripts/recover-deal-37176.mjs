/** One-deal recovery, authorized 2026-09-29. Default: read-only dry run.
 * Run from the deployed application root, using its existing environment.
 * --apply creates only a draft Sales Order, verifies it, then collapses B24 rows.
 * Never submits stock documents or changes the application image/source.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dealId = 37176;
const expectedRelease = '0efe4e736fdb9a2e9d867403f05ca1e0bad18cca';
const apply = process.argv.includes('--apply');
assert(process.argv.slice(2).every(arg => arg === '--apply'), 'Only --apply is supported');
const moduleAt = name => import(pathToFileURL(resolve(process.cwd(), 'packages/backend/dist', name)).href);
const { B24Client } = await moduleAt('b24/client.js');
const { ErpClient } = await moduleAt('erp/client.js');
const { upsertDealPlan, listDealPlan, calculateDealPlanTotal } = await moduleAt('erp/operations.js');
const { setDealB24CollapsedService } = await moduleAt('deal-service.js');
const { syncDealServiceSum } = await moduleAt('deal-service-sum.js');
const { syncDealFulfillmentStatus } = await moduleAt('deal-fulfillment.js');
const erp = ErpClient.fromEnv();
assert(erp, 'ERP configuration is required');
const webhook = process.env.DEV_WEBHOOK || process.env.CATALOG_WRITE_WEBHOOK;
assert(webhook, 'B24 configuration is required');
const b24 = new B24Client({ auth: { kind: 'webhook', url: webhook } });
const expected = [
	[12392, 9814, 1, 3300], [12396, 10262, 7, 2500],
	[12400, 18416, 2, 300], [12402, 18286, 2, 1883],
	[12404, 18320, 2, 2519], [12406, 18318, 1, 7612],
	[12408, 18314, 2, 13348], [12410, 18240, 2, 16194],
];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recoveryDir = join(process.env.B24_STATE_DIR || '/app/state', 'recoveries', 'deal-37176-20260929');
const references = [
	['Material Request', 'MAT-MR-2026-00011'],
	['Stock Entry', 'MAT-STE-2026-00108'], ['Stock Entry', 'MAT-STE-2026-00236'],
	['Purchase Order', 'PUR-ORD-2026-00035'], ['Purchase Order', 'PUR-ORD-2026-00036'],
];
async function source() {
	const [deal, rows, bindings, orderResult, shipments, orders, notes, plan] = await Promise.all([
		b24.call('crm.deal.get', { id: dealId }),
		b24.call('crm.deal.productrows.get', { id: dealId }),
		b24.call('crm.orderentity.list', { filter: { ownerId: dealId, ownerTypeId: 2 }, select: ['orderId'] }),
		b24.call('sale.order.get', { id: 1298 }),
		b24.call('sale.shipment.list', { filter: { orderId: 1298 }, select: ['id', 'deducted', 'system'] }),
		erp.list('Sales Order', ['name', 'docstatus'], [['b24_deal_id', '=', String(dealId)]]),
		erp.list('Delivery Note', ['name', 'docstatus'], [['b24_deal_id', '=', String(dealId)]]),
		listDealPlan(erp, dealId),
	]);
	const order = orderResult.order;
	assert.equal(String(deal.CLOSED), 'N', 'Deal must remain open');
	assert.equal(Number(deal.OPPORTUNITY), 96900, 'Deal amount changed');
	assert.deepEqual(bindings.orderEntity.map(x => Number(x.orderId)), [1298], 'Native order bindings changed');
	assert.equal(order.payed, 'N');
	assert.equal(order.deducted, 'N');
	assert.equal(Number(order.price), 96900);
	assert.deepEqual(shipments.shipments, [], 'Native shipments require separate review');
	assert.deepEqual(notes, [], 'ERP realizations require separate review');
	assert.equal(orders.length, 0, 'A plan now exists; do not overwrite it or repeat recovery');
	assert.equal(plan.length, 0, 'Manual/core lines now exist; do not overwrite them');
	assert.deepEqual(rows.map(r => [Number(r.ID), Number(r.PRODUCT_ID), Number(r.QUANTITY), Number(r.PRICE)]).sort((a,b) => a[0]-b[0]), expected);
	for (const row of rows) {
		assert.equal(Number(row.DISCOUNT_RATE || 0), 0);
		assert.equal(Number(row.DISCOUNT_SUM || 0), 0);
		assert.equal(Number(row.RESERVE_QUANTITY || 0), 0);
		assert.equal(Number(row.TAX_RATE || 0), 0);
	}
	assert.deepEqual(order.basketItems.map(r => [Number(r.productId), Number(r.quantity), Number(r.price)]).sort((a,b) => a[0]-b[0]), expected.map(r => r.slice(1)).sort((a,b) => a[0]-b[0]));
	return { deal: Object.fromEntries(['ID','TITLE','DATE_MODIFY','STAGE_ID','CLOSED','OPPORTUNITY','IS_MANUAL_OPPORTUNITY','UF_CRM_SERVICE_SUM','UF_CRM_ALL_REALIZED'].map(k => [k, deal[k]])), rows,
		order: { id: order.id, price: order.price, payed: order.payed, deducted: order.deducted, basketItems: order.basketItems }, bindings, shipments, orders, notes };
}
async function readReferences() {
	const docs = [];
	for (const [doctype, name] of references) {
		const doc = await erp.get(doctype, name);
		assert(doc && String(doc.b24_deal_id) === String(dealId), 'Reference document no longer belongs to deal');
		docs.push({ doctype, name, modified: doc.modified, docstatus: doc.docstatus, items: doc.items });
	}
	assert.equal(docs[1].docstatus, 1); assert.equal(docs[2].docstatus, 1);
	assert.deepEqual(docs[0].items.map(i => [Number(i.item_code), Number(i.qty)]).sort((a,b) => a[0]-b[0]), expected.slice(2).map(r => [r[1],r[2]]).sort((a,b) => a[0]-b[0]));
	return docs;
}
async function verifyPlan() {
	const plan = await listDealPlan(erp, dealId);
	assert.deepEqual(plan.map(p => [p.productId,p.qty,p.rate,p.discountPercent,p.lineKey]).sort((a,b) => a[0]-b[0]),
		expected.map(([id,pid,qty,price]) => [pid === 9814 ? 9814001 : pid,qty,price,0,`recovery-37176-b24-${id}`]).sort((a,b) => a[0]-b[0]));
	assert.equal(await calculateDealPlanTotal(erp, dealId), 96900);
	assert.equal(await calculateDealPlanTotal(erp, dealId, true), 20800);
	return plan;
}

const healthResponse = await fetch(`http://127.0.0.1:${process.env.PORT || 8080}/health`);
assert(healthResponse.ok);
const health = await healthResponse.json();
assert.equal(health.gitSha, expectedRelease, 'Release changed; re-review recovery');
const before = await source();
const referenceDocs = await readReferences();
const catalog = await erp.list('Item', ['name','item_name','is_stock_item','disabled'], [['name','in',expected.map(r => String(r[1] === 9814 ? 9814001 : r[1]))]]);
assert.equal(catalog.length, 8, 'All recovery products must already exist');
assert(catalog.every(item => Number(item.disabled) === 0));
for (const item of catalog) assert.equal(Number(item.is_stock_item), ['9814001','10262'].includes(item.name) ? 0 : 1);
const lines = before.rows.map(row => ({ productId: Number(row.PRODUCT_ID) === 9814 ? 9814001 : Number(row.PRODUCT_ID),
	itemName: String(row.PRODUCT_NAME), qty: Number(row.QUANTITY), priceListRate: Number(row.PRICE), discountPercent: 0,
	isService: [9814,10262].includes(Number(row.PRODUCT_ID)), lineKey: `recovery-37176-b24-${row.ID}` }));
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', dealId, rows: lines.length, total: 96900, services: 20800,
	productionSha: health.gitSha, sourceHash: hash(before), referenceHash: hash(referenceDocs), lines }, null, 2));
if (!apply) process.exit(0);

await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
const lock = join(recoveryDir, 'lock');
await mkdir(lock); // An existing lock requires explicit inspection, never a blind retry.
try {
	const backup = { capturedAt: new Date().toISOString(), health, before, referenceDocs, catalog, lines };
	await writeFile(join(recoveryDir, 'before.json'), JSON.stringify(backup, null, 2), { flag: 'wx', mode: 0o600 });
	assert.equal(hash(JSON.parse(await readFile(join(recoveryDir, 'before.json'), 'utf8'))), hash(backup));
	assert.equal(hash(await source()), hash(before), 'Source changed during preparation');
	assert.equal(hash(await readReferences()), hash(referenceDocs), 'Reference documents changed');
	// Enforce the scope even if a deployed helper tries to create setup fields or edit catalog records.
	const request = erp.request.bind(erp);
	let created = false;
	erp.request = async (method, path, body) => {
		if (method !== 'GET') {
			assert(!created && method === 'POST' && path === '/api/resource/Sales%20Order'
				&& String(body?.b24_deal_id) === String(dealId) && Number(body?.docstatus || 0) === 0,
				`Forbidden recovery mutation: ${method} ${path}`);
			created = true;
		}
		return request(method, path, body);
	};
	const saved = await upsertDealPlan(erp, dealId, lines, new Date().toISOString().slice(0,10));
	assert(saved.name, 'Plan was not created');
	await writeFile(join(recoveryDir, 'created-plan.json'), JSON.stringify({ name: saved.name, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
	const plan = await verifyPlan();
	const savedDoc = await erp.get('Sales Order', saved.name);
	assert.equal(savedDoc.docstatus, 0, 'Recovered plan must remain a draft');
	// Only the verified, backed-up native rows may now be replaced.
	assert.equal(hash(await b24.call('crm.deal.productrows.get', { id: dealId })), hash(before.rows), 'Native rows changed before collapse');
	await setDealB24CollapsedService(b24, dealId, 96900);
	await syncDealServiceSum(b24, erp, dealId);
	await syncDealFulfillmentStatus(b24, erp, dealId);
	const native = await b24.call('crm.deal.productrows.get', { id: dealId });
	assert.equal(native.length, 1, 'Native collapse incomplete; keep recovered plan and inspect');
	assert.equal(Number(native[0].PRODUCT_ID), 9814);
	assert.equal(String(native[0].PRODUCT_NAME), 'Отгрузка подтверждена на сумму');
	assert.equal(Number(native[0].QUANTITY), 1);
	assert.equal(Number(native[0].PRICE), 96900);
	const finalDeal = await b24.call('crm.deal.get', { id: dealId });
	assert.equal(Number(finalDeal.OPPORTUNITY), 96900);
	assert.equal(String(finalDeal.UF_CRM_ALL_REALIZED), 'НЕТ');
	assert.equal(Number(String(finalDeal.UF_CRM_SERVICE_SUM).split('|')[0]), 20800);
	assert.equal(hash(await readReferences()), hash(referenceDocs), 'Related document changed; inspect concurrent activity');
	await verifyPlan();
	const after = { completedAt: new Date().toISOString(), dealId, salesOrder: saved.name, plan, native,
		total: 96900, services: 20800, referencesUnchanged: true, backupDirectory: recoveryDir };
	await writeFile(join(recoveryDir, 'after.json'), JSON.stringify(after, null, 2), { flag: 'wx', mode: 0o600 });
	console.log(JSON.stringify(after, null, 2));
} finally {
	await rmdir(lock);
}
