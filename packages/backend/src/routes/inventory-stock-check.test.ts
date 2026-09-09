import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInventoryStock } from './inventory-stock-check.js';
import { prepareConfirmedInventoryRecount } from '../inventory-confirmed-recount.js';
import { frozenInventoryDifferences, inventoryCountQuantities, inventorySnapshotQuantities } from '../inventory-stock-snapshot.js';
import { prepareInventoryExport } from '../inventory-export.js';
import type { ErpClient } from '../erp/client.js';
import { parseInventoryBitrixItem } from '../inventory-sql/model.js';
import { inventorySqlRecordToBitrixItem } from '../inventory-sql/read-shadow.js';
import Fastify from 'fastify';
import { ErpClient as LiveErpClient } from '../erp/client.js';
import { B24Client } from '../b24/client.js';
import { registerInventoryReconciliationRoutes } from './api-inventory-reconciliation-routes.js';

const warehouse = 'Измайловский - УД';
function fixture() {
	const point: Record<string, unknown> = { status: 'reconciled', storeId: -7, storeName: 'Измайловский', stockSnapshot: { version: 1, capturedAt: '2026-09-04T07:37:41Z', lines: [[7890, 1], [16944, 1347], [15322, 91], [7888, 3], [999, 2]] }, draft: { 7890: 0, 16944: 1652, 15322: 50, 7888: 3 }, result: { total: 8, counted: 8, discrepancies: 3, lines: [{ productId: 7890, name: 'Монитор', book: 1, fact: 0, diff: -1 }, { productId: 16944, name: 'Кабель', book: 1347, fact: 1652, diff: 305 }, { productId: 15322, name: 'Разъём', book: 91, fact: 50, diff: -41 }] }, erpDocs: { issue: { name: 'I', status: 'draft' }, receipt: { name: 'R', status: 'draft' } } };
	const bins = [{ name: 'B1', item_code: '7890', actual_qty: 0 }, { name: 'B2', item_code: '16944', actual_qty: 47 }, { name: 'B3', item_code: '15322', actual_qty: 41 }];
	const docs: Record<string, Record<string, unknown>> = { I: { docstatus: 0, posting_date: '2026-09-09', posting_time: '11:55:19.1' }, R: { docstatus: 0 } };
	const ledger: Record<string, unknown>[] = [];
	const calls: string[] = [];
	const erp = { async list(type: string) { return type === 'Company' ? [{ name: 'C', abbr: 'УД' }] : []; }, async get(_type: string, id: string) { return docs[id]; }, async request(method: string, path: string) {
		calls.push(method); const type = decodeURIComponent(path.split('?')[0]!.split('/').at(-1)!);const offset = Number(new URLSearchParams(path.split('?')[1]).get('limit_start'));
		return { json: { data: (type === 'Bin' ? bins : ledger).slice(offset, offset + 500) } };
	} } as unknown as ErpClient;
	const lines = () => frozenInventoryDifferences(point)!.map(row => ({ ...row, bookErp: row.book }));
	return { point, bins, docs, ledger, erp, calls, lines };
}
test('all shortages and changed zero-difference rows are visible; no writes', async () => {
	const f = fixture(); f.bins[2]!.actual_qty = 0;
	const check = await checkInventoryStock(f.erp, f.point, f.lines());
	assert.equal(check.warehouse, warehouse); assert.equal(check.shortages.length, 2);
	assert.match(check.message!, /7890/); assert.match(check.message!, /15322/);
	assert.equal(check.changed.find(r => r.productId === 7888)?.projected, 0);
	assert.equal(check.rows.find(r => r.productId === 16944)?.projected, 352);
	assert.equal(check.rows.find(r => r.productId === 999)?.fact, null);
	assert(f.calls.every(call => call === 'GET'));
});
test('historical shortage blocks even when current quantity is sufficient; submitted issue is not subtracted twice', async () => {
	const f = fixture();f.bins[0]!.actual_qty = 5;
	f.ledger.push({ name: 'L', item_code: '7890', posting_date: '2026-09-09', posting_time: '12:01:00', actual_qty: 5, qty_after_transaction: 5 });
	assert.equal((await checkInventoryStock(f.erp, f.point, f.lines())).shortages[0]?.productId, 7890);
	f.docs.I!.docstatus = 1;
	const resumed = await checkInventoryStock(f.erp, f.point, f.lines());assert.equal(resumed.shortages.length, 0);assert.equal(resumed.rows.find(r => r.productId === 7890)?.projected, 5);
});
test('pagination reads all rows; malformed responses and nonfinite quantities fail closed', async () => {
	const f = fixture();f.bins.push(...Array.from({ length: 600 }, (_, i) => ({ name: `extra-${i}`, item_code: String(50000 + i), actual_qty: 1 })));
	await checkInventoryStock(f.erp, f.point, f.lines());assert(f.calls.length >= 3);
	f.bins[0]!.actual_qty = NaN;await assert.rejects(checkInventoryStock(f.erp, f.point, f.lines()), /некорректное количество/);
});
test('confirmed current facts get a separate persisted result basis; snapshot and facts never change', () => {
	const f = fixture(), original = structuredClone(f.point);
	const stock = new Map([[7890, 0], [16944, 47], [15322, 41], [7888, 0], [999, 2]]);
	const next = prepareConfirmedInventoryRecount(f.point, stock, [7890, 16944, 15322, 7888], '2026-09-09T15:00:00Z');
	assert.deepEqual(next.stockSnapshot, original.stockSnapshot);assert.deepEqual(next.draft, original.draft);assert.deepEqual(f.point, original);
	assert.equal(inventorySnapshotQuantities(next)?.get(16944), 1347);assert.equal(inventoryCountQuantities(next)?.get(16944), 47);assert.equal(inventoryCountQuantities(next)?.get(7890), 0);
	const lines = frozenInventoryDifferences(next)!;assert.equal(lines.find(r => r.productId === 16944)?.diff, 1605);assert(!lines.some(r => r.productId === 7890));assert.equal(lines.find(r => r.productId === 7888)?.diff, 3);
	assert.deepEqual({ ...(next.result as object), lines: undefined }, { total: 5, counted: 4, discrepancies: 3, lines: undefined });
	const exported = prepareInventoryExport({ ID: '1', DETAIL_TEXT: JSON.stringify({ points: [next] }) });assert.equal(exported.points[0]?.lines.find(r => r.productId === 16944)?.diff, 1605);
	const sqlPoint = { ...next, erpDocs: { issue: { name: 'I', status: 'draft', lines: 1 }, receipt: { name: 'R', status: 'draft', lines: 2 } } };
	const parsed = parseInventoryBitrixItem({ ID: '1', NAME: 'Ревизия', DETAIL_TEXT: JSON.stringify({ points: [sqlPoint] }) });
	assert.deepEqual(parsed.issues, []);assert(parsed.inventory);
	const roundTrip = JSON.parse(String(inventorySqlRecordToBitrixItem(parsed.inventory).DETAIL_TEXT)).points[0];
	assert.equal(inventoryCountQuantities(roundTrip)?.get(16944), 47);assert.equal(inventoryCountQuantities(roundTrip)?.get(7890), 0);
	assert.throws(() => prepareConfirmedInventoryRecount(f.point, stock, [7890], '2026-09-09T15:00:00Z'), /новое движение/);
	(next.draft as Record<number, number>)[16944] = 1600;assert.throws(() => inventoryCountQuantities(next), /изменён/);
});
test('HTTP submission returns the whole shortage list before submitting any document', async t => {
	const f = fixture();f.bins[2]!.actual_qty = 0;
	Object.assign(f.docs.I!, { stock_entry_type: 'Material Issue', items: [{ item_code: '7890', qty: 1, s_warehouse: warehouse }, { item_code: '15322', qty: 41, s_warehouse: warehouse }] });
	Object.assign(f.docs.R!, { stock_entry_type: 'Material Receipt', items: [{ item_code: '16944', qty: 305, t_warehouse: warehouse }] });
	let submits = 0;Object.assign(f.erp, { async submit() { submits++; } });
	t.mock.method(LiveErpClient, 'fromEnv', () => f.erp);
	t.mock.method(B24Client.prototype, 'callWithMeta', async () => ({ result: [{ ID: '1', NAME: 'Ревизия', DETAIL_TEXT: JSON.stringify({ points: [f.point] }) }] }));
	const app = Fastify();app.decorate('config', { portalDomain: 'test.example', inventorySqlRead: 'off' } as typeof app.config);registerInventoryReconciliationRoutes(app);t.after(() => app.close());
	const response = await app.inject({ method: 'POST', url: '/api/inventory/erp-doc-submit', payload: { domain: 'test.example', accessToken: 'test', inventoryId: '1', storeId: -7 } });
	assert.equal(response.json().ok, false);assert.equal(response.json().stockCheck.shortages.length, 2);assert.equal(submits, 0);
});
