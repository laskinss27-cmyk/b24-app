import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import type { Config } from '../config.js';
import { stockAccess, isShellyIssueDocument } from './api-stock-access.js';
import { registerStockDocumentCreationRoute } from './api-stock-document-creation-route.js';
import { registerStockDocumentSubmitRoute } from './api-stock-document-submit-route.js';
import { registerStockDocumentCancelRoute } from './api-stock-document-cancel-route.js';
import { registerStockCatalogRoutes } from './api-stock-catalog-routes.js';

const warehouse = 'Shelly - УД';
const issue = () => ({ stock_entry_type: 'Material Issue', purpose: 'Material Issue', docstatus: 0, items: [{ item_code: '18110', qty: 1, s_warehouse: warehouse }] });
const auth = { domain: 'portal.example', accessToken: 'test' };

test('only exact two identities gain scoped issue; general permissions remain unchanged', async () => {
	for (const id of ['760', '3608', '1760', '36080', '', '2', '1858']) {
		const access = await stockAccess({ call: async () => ({ ID: id, UF_DEPARTMENT: [] }) } as unknown as B24Client);
		assert.equal(access.canIssueShelly, ['760', '3608'].includes(id));
		assert.equal(access.canManage, id === '1858');
		assert.equal(access.isSupply, false);
	}
	assert.equal((await stockAccess({ call: async () => { throw Error('invalid token'); } } as unknown as B24Client)).canIssueShelly, false);
});

test('document guard rejects mixed warehouses, transfers, empty lines, non-drafts and header overrides', () => {
	assert.equal(isShellyIssueDocument(issue(), warehouse), true);
	for (const patch of [
		{ stock_entry_type: 'Material Transfer' }, { purpose: 'Material Receipt' }, { docstatus: 1 },
		{ items: [] }, { items: [null] }, { from_warehouse: 'Офис - УД' }, { to_warehouse: warehouse },
		{ items: [...issue().items, { s_warehouse: 'Офис - УД' }] },
		{ items: [{ s_warehouse: 'Shelly - ДругаяКомпания' }] },
		{ items: [{ s_warehouse: warehouse, t_warehouse: 'Офис - УД' }] },
	]) assert.equal(isShellyIssueDocument({ ...issue(), ...patch }, warehouse), false, JSON.stringify(patch));
});

test('real routes enforce scope without general receipts, product creation or cancellation access', async (t) => {
	let userId = '760';
	let document: Record<string, unknown> = issue();
	let submitted = 0;
	let created = 0;
	t.mock.method(B24Client.prototype, 'call', async (method: string) => {
		if (method === 'user.current') return { ID: userId, UF_DEPARTMENT: [] };
		if (method === 'crm.category.list') return { categories: [] };
		if (method === 'crm.item.list') return { items: [] };
		throw Error('Unexpected Bitrix operation ' + method);
	});
	t.mock.method(ErpClient, 'fromEnv', () => ({
		async list(type: string) {
			if (type === 'Company') return [{ name: 'Умный дом', abbr: 'УД' }];
			if (type === 'Warehouse') return [{ name: warehouse, warehouse_name: 'Shelly' }, { name: 'Офис - УД', warehouse_name: 'Офис' }];
			throw Error('Unexpected ERP list ' + type);
		},
		async get(type: string) {
			if (type === 'Stock Entry') return document;
			// Existing setup fields already exist; no schema changes in this test.
			return { name: 'existing' };
		},
		async create(type: string, fields: Record<string, unknown>) {
			assert.equal(type, 'Stock Entry');
			assert.equal(fields['stock_entry_type'], 'Material Issue');
			assert.deepEqual(fields['items'], [{ item_code: '18110', qty: 1, s_warehouse: warehouse }]);
			created++;
			return { name: 'TEST-DRAFT' };
		},
		async submit(type: string) { assert.equal(type, 'Stock Entry'); submitted++; },
	}));
	const app = Fastify();
	app.decorate('config', { portalDomain: 'portal.example' } as Config);
	app.decorate('operationLog', { record: async () => undefined } as unknown as typeof app.operationLog);
	registerStockDocumentCreationRoute(app);
	registerStockDocumentSubmitRoute(app);
	registerStockDocumentCancelRoute(app);
	registerStockCatalogRoutes(app);
	const post = (url: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url, payload: { ...auth, ...body } });
	try {
		for (userId of ['760', '3608']) {
			const form = (await post('/api/stock/form-data', {})).json();
			assert.equal(form.canCreate, false); assert.equal(form.canCancel, false); assert.equal(form.isSupply, false);
			assert.equal(form.canCreateIssue, true); assert.equal(form.canPostIssue, true); assert.deepEqual(form.issueStores, ['Shelly']);
			for (const fromStore of ['Офис', 'Shelly - УД', 'Shelly evil', '']) {
				assert.equal((await post('/api/stock/create', { kind: 'issue', fromStore, lines: [{ productId: 18110, qty: 1 }] })).statusCode, 403);
			}
			assert.equal((await post('/api/stock/create', { kind: 'receipt', toStore: 'Shelly', lines: [{ productId: 18110, qty: 1 }] })).statusCode, 403);
			assert.equal((await post('/api/stock/create-product', { name: 'New product' })).statusCode, 403);
			assert.equal((await post('/api/stock/submit', { kind: 'receipt', name: 'TEST', doctype: 'Stock Entry' })).statusCode, 403);
			assert.equal((await post('/api/stock/cancel-submission', { kind: 'issue', name: 'TEST', doctype: 'Stock Entry' })).statusCode, 403);
			document = { ...issue(), items: [...issue().items, { item_code: '2', qty: 1, s_warehouse: 'Офис - УД' }] };
			assert.equal((await post('/api/stock/submit', { kind: 'issue', name: 'TEST', fromStore: 'Shelly' })).statusCode, 403);
			document = { ...issue(), stock_entry_type: 'Material Transfer' };
			assert.equal((await post('/api/stock/submit', { kind: 'issue', name: 'TEST' })).statusCode, 403);
			document = issue();
			const draft = await post('/api/stock/create', { kind: 'issue', fromStore: 'Shelly', lines: [{ productId: 18110, qty: 1 }] });
			assert.equal(draft.json().ok, true, draft.body);
			const result = await post('/api/stock/submit', { kind: 'issue', name: 'TEST' });
			assert.equal(result.json().ok, true, result.body);
		}
		assert.equal(created, 2); assert.equal(submitted, 2);
		userId = '2';
		assert.equal((await post('/api/stock/submit', { kind: 'issue', name: 'TEST' })).statusCode, 403);
		assert.equal((await post('/api/stock/create', { kind: 'issue', fromStore: 'Shelly' })).statusCode, 403);
		assert.equal((await post('/api/stock/form-data', {})).json().canCreateIssue, false);
		userId = '1858';
		const admin = (await post('/api/stock/form-data', {})).json();
		assert.equal(admin.canCreate, true); assert.equal(admin.canCancel, true); assert.deepEqual(new Set(admin.issueStores), new Set(['Shelly', 'Офис']));
	} finally { await app.close(); }
});
