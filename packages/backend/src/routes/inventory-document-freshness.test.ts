import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ErpClient } from '../erp/client.js';
import { B24Client } from '../b24/client.js';
import { checkInventoryDocuments } from './inventory-document-freshness.js';
import { registerInventoryReconciliationRoutes } from './api-inventory-reconciliation-routes.js';

const wh = 'Измайловский - УД';
const line = { productId: 16944, name: 'Кабель', book: 1347, fact: 1652, diff: 305 };
const record = (name: string) => ({ name, status: 'draft', lines: 1 });
const document = (kind: string, qty: number, code = '16944') => ({ docstatus: 0, stock_entry_type: kind === 'issue' ? 'Material Issue' : 'Material Receipt', items: [{ item_code: code, qty, [kind === 'issue' ? 's_warehouse' : 't_warehouse']: wh }] });
function fixture() {
	const docs: Record<string, Record<string, unknown>> = { I: document('issue', 1042), R: document('receipt', 1, '2') };
	const point: Record<string, unknown> = { storeId: -7, storeName: 'Измайловский', status: 'reconciled', stockSnapshot: { version: 1, capturedAt: '2026-09-01', lines: [[16944, 1347]] }, result: { discrepancies: 1, lines: [line] }, erpDocs: { issue: record('I'), receipt: record('R') } };
	const writes: string[] = [];
	const erp = { async list(type: string) { return type === 'Company' ? [{ name: 'Company', abbr: 'УД' }] : []; }, async get(_type: string, name: string) { return docs[name] ?? null; }, async submit(_type: string, name: string) { writes.push('submit:' + name); }, async delete(_type: string, name: string) { writes.push('delete:' + name); delete docs[name]; } } as unknown as ErpClient;
	return { docs, point, writes, erp };
}
test('old deficit 1042 cannot be posted for updated surplus 305; missing or extra kind and warehouse mismatch block', async () => {
	const f = fixture();
	assert.deepEqual(await checkInventoryDocuments(f.erp, f.point, [line]), { blocked: true, canRecreate: true, message: 'Складские черновики устарели или не соответствуют отчёту. Проведение заблокировано. Нажмите «Пересоздать по обновлённому отчёту», проверьте новые документы и затем проведите их.' });
	f.point.erpDocs = { receipt: record('R') }; f.docs.R = document('receipt', 305);
	assert.equal((await checkInventoryDocuments(f.erp, f.point, [line])).blocked, false);
	f.docs.R = document('receipt', 306);
	assert.equal((await checkInventoryDocuments(f.erp, f.point, [line])).blocked, true);
	f.docs.R = { ...document('receipt', 305), items: [{ item_code: '16944', qty: 305, t_warehouse: 'Другой склад' }] };
	assert.equal((await checkInventoryDocuments(f.erp, f.point, [line])).blocked, true);
	f.docs.R = document('receipt', 305);
	assert.equal((await checkInventoryDocuments(f.erp, f.point, [])).blocked, true);
	f.point.status = 'in_progress';
	assert.equal((await checkInventoryDocuments(f.erp, f.point, [line])).blocked, true);
	assert.deepEqual(f.writes, []);
});
test('matching partly submitted documents can resume, but changed report cannot recreate them', async () => {
	const f = fixture();f.docs.I = { ...document('issue', 2, '2'), docstatus: 1 };f.docs.R = document('receipt', 305);
	const lines = [line, { productId: 2, fact: 1, diff: -2 }];
	const check = await checkInventoryDocuments(f.erp, f.point, lines);
	assert.equal(check.blocked, false); assert.equal(check.canRecreate, false);
	assert.match((await checkInventoryDocuments(f.erp, f.point, [line])).message!, /часть уже проведена/);
	assert.deepEqual(f.writes, []);
});
test('legacy reconciliation compares absolute facts and handles missing documents', async () => {
	const f = fixture(); delete f.point.erpDocs; f.point.erpDoc = record('L');
	f.docs.L = { docstatus: 0, items: [{ item_code: '16944', qty: 1652, warehouse: wh }] };
	assert.equal((await checkInventoryDocuments(f.erp, f.point, [line])).blocked, false);
	delete f.docs.L;
	assert.equal((await checkInventoryDocuments(f.erp, f.point, [line])).blocked, true);
});
test('HTTP checks entire set before writes, blocks reopened point and safely clears zero-difference drafts', async t => {
	const f = fixture();t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	let stored = { ID: '1', NAME: 'Ревизия', DETAIL_TEXT: JSON.stringify({ points: [f.point] }) };
	t.mock.method(B24Client.prototype, 'callWithMeta', async () => ({ result: [stored] }));
	t.mock.method(B24Client.prototype, 'call', async (_method: string, data: Record<string, unknown>) => { if (data.DETAIL_TEXT) stored = { ...stored, DETAIL_TEXT: String(data.DETAIL_TEXT) }; return true; });
	const app = Fastify();app.decorate('config', { portalDomain: 'test.example', inventorySqlRead: 'off' } as typeof app.config);registerInventoryReconciliationRoutes(app);t.after(() => app.close());
	const request = (action: string, recreate = false) => app.inject({ method: 'POST', url: '/api/inventory/erp-doc-' + action, payload: { domain: 'test.example', accessToken: 'test', inventoryId: '1', storeId: -7, recreate } });
	assert.equal((await request('preview')).json().documentCheck.blocked, true);
	assert.match((await request('submit')).json().error, /устарели/);assert.deepEqual(f.writes, []);
	f.point.status = 'in_progress'; stored.DETAIL_TEXT = JSON.stringify({ points: [f.point] });
	assert.match((await request('submit')).json().error, /ещё не сверена/);assert.deepEqual(f.writes, []);
	f.point.status = 'reconciled'; f.point.result = { discrepancies: 0, lines: [] };stored.DETAIL_TEXT = JSON.stringify({ points: [f.point] });
	const cleared = (await request('save', true)).json();assert.equal(cleared.ok, true);assert.equal(cleared.lines, 0);
	assert.deepEqual(f.writes, ['delete:I', 'delete:R']);assert.equal(JSON.parse(stored.DETAIL_TEXT).points[0].erpDocs, undefined);
});

test('recreation replaces old issue with receipt 305 and new documents pass the server check', async t => {
	const f = fixture();
	const get = f.erp.get.bind(f.erp);
	t.mock.method(f.erp, 'get', async (type: string, name: string) => type === 'Custom Field' ? { name } : get(type, name));
	Object.assign(f.erp, { async create(type: string, data: Record<string, unknown>) {
		assert.equal(type, 'Stock Entry'); f.writes.push('create:NEW'); f.docs.NEW = { ...data, name: 'NEW', docstatus: 0 }; return f.docs.NEW;
	} });
	t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	let stored = { ID: '1', NAME: 'Ревизия', DETAIL_TEXT: JSON.stringify({ points: [f.point] }) };
	t.mock.method(B24Client.prototype, 'callWithMeta', async () => ({ result: [stored] }));
	t.mock.method(B24Client.prototype, 'call', async (_method: string, data: Record<string, unknown>) => { if (data.DETAIL_TEXT) stored = { ...stored, DETAIL_TEXT: String(data.DETAIL_TEXT) }; return true; });
	const app = Fastify();app.decorate('config', { portalDomain: 'test.example', inventorySqlRead: 'off' } as typeof app.config);registerInventoryReconciliationRoutes(app);t.after(() => app.close());
	const response = await app.inject({ method: 'POST', url: '/api/inventory/erp-doc-save', payload: { domain: 'test.example', accessToken: 'test', inventoryId: '1', storeId: -7, recreate: true } });
	assert.equal(response.json().ok, true);assert.equal(response.json().docs.issue, undefined);assert.equal(response.json().docs.receipt.name, 'NEW');
	assert.equal((f.docs.NEW?.items as {qty: number}[])[0]?.qty, 305);
	const point = JSON.parse(stored.DETAIL_TEXT).points[0];
	assert.equal((await checkInventoryDocuments(f.erp, point, [line])).blocked, false);
	assert.deepEqual(f.writes, ['delete:I', 'delete:R', 'create:NEW']);
	assert.deepEqual(point.stockSnapshot, f.point.stockSnapshot);assert.deepEqual(point.result, f.point.result);
});
