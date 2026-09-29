import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { loadTransferRequests } from './transfer-request-storage.js';
import { fetchAllRepairs } from './repair-storage.js';
import { registerInventoryReadRoutes } from './api-inventory-read-routes.js';
import { registerInventoryUpdateRoute } from './api-inventory-update-route.js';
import { loadInventoryPoint } from './api-inventory-reconciliation-helpers.js';
import { registerStockMovementRoutes } from './api-stock-movement-routes.js';

function entityPages(count: number) {
	const rows = Array.from({ length: count }, (_, index) => ({ ID: String(count - index), NAME: `Document ${count - index}`, DETAIL_TEXT: '{}' }));
	const starts: number[] = [];
	const callWithMeta = async (method: string, params: Record<string, unknown>) => {
		assert.equal(method, 'entity.item.get');
		const start = Number(params['start']);
		starts.push(start);
		assert.ok(start < rows.length, 'must not request a page beyond the server cursor');
		return { result: rows.slice(start, start + 50), ...(start + 50 < count ? { next: start + 50 } : {}), total: count };
	};
	return { rows, starts, callWithMeta };
}

test('transfer/supply requests include rows after 50 and stop at exact page boundary', async () => {
	const fake = entityPages(100);
	const requests = await loadTransferRequests(fake as unknown as B24Client);
	assert.equal(requests.length, 100);
	assert.equal(requests.at(-1)?.id, 1);
	assert.deepEqual(fake.starts, [0, 50]);
});

test('repair list no longer silently stops after 40 pages', async () => {
	const fake = entityPages(2051);
	const repairs = await fetchAllRepairs(fake as unknown as B24Client);
	assert.equal(repairs.length, 2051);
	assert.equal(repairs.at(-1)?.['ID'], '1');
	assert.equal(fake.starts.at(-1), 2050);
});

test('inventory list returns older documents from subsequent Bitrix pages', async (t) => {
	const fake = entityPages(51);
	t.mock.method(B24Client.prototype, 'callWithMeta', fake.callWithMeta);
	t.mock.method(B24Client.prototype, 'call', async (method: string) => { assert.equal(method, 'entity.add'); return true; });
	t.mock.method(ErpClient, 'fromEnv', () => null);
	const app = Fastify();
	app.decorate('config', { portalDomain: 'test.example' } as typeof app.config);
	registerInventoryReadRoutes(app);
	t.after(() => app.close());
	const response = await app.inject({ method: 'POST', url: '/api/inventory/list', payload: { domain: 'test.example', accessToken: 'test' } });
	assert.equal(response.json().ok, true, response.body);
	assert.equal(response.json().inventories.length, 51);
	assert.equal(response.json().inventories.at(-1).id, '1');
	assert.deepEqual(fake.starts, [0, 50]);
});

test('older inventory point can be read and saved directly by ID beyond first page', async (t) => {
	let writes = 0;
	const data = { points: [{ storeId: 7, status: 'in_progress', draft: { 123: 1 },
		stockSnapshot: { version: 1, capturedAt: '2026-09-01T00:00:00Z', lines: [[123, 1]] } }] };
	t.mock.method(B24Client.prototype, 'call', async (method: string, params: Record<string, unknown>) => {
		if (method === 'entity.add') return true;
		if (method === 'entity.item.get') {
			assert.deepEqual(params['FILTER'], { ID: '1' });
			return [{ ID: '1', NAME: 'Older inventory', DETAIL_TEXT: JSON.stringify(data) }];
		}
		if (method === 'entity.item.update') { writes++; assert.equal(params['ID'], '1'); return true; }
		throw new Error(`Unexpected method ${method}`);
	});
	const client = new B24Client({ auth: { kind: 'oauth', domain: 'test.example', accessToken: 'test' } });
	assert.equal((await loadInventoryPoint(client, '1', 7)).pt['storeId'], 7);
	const app = Fastify();
	app.decorate('config', { portalDomain: 'test.example' } as typeof app.config);
	registerInventoryUpdateRoute(app);
	t.after(() => app.close());
	const response = await app.inject({ method: 'POST', url: '/api/inventory/update', payload: {
		domain: 'test.example', accessToken: 'test', inventoryId: '1', storeId: 7, action: 'saveDraft', draft: { 123: 2 },
	} });
	assert.equal(response.json().draftSaved, true, response.body);
	assert.equal(writes, 1);
});

test('movement endpoint includes document 317 with its owner for global search', async (t) => {
	const heads = Array.from({ length: 1011 }, (_, index) => ({ name: `DN-${index}`, posting_date: '2026-09-04', docstatus: 1, b24_deal_id: '' }));
	heads[316] = { ...heads[316]!, name: 'MAT-DN-2026-00763', b24_deal_id: '36058' };
	t.mock.method(ErpClient, 'fromEnv', () => ({
		get: async () => ({ name: 'existing field' }),
		list: async (_doctype: string, _fields: string[], _filters: unknown[], limit: number) => limit ? heads.slice(0, limit) : heads,
	}));
	t.mock.method(B24Client.prototype, 'call', async (method: string) => {
		if (method === 'crm.deal.list') return [{ ID: '36058', ASSIGNED_BY_ID: '7' }];
		if (method === 'user.get') return [{ NAME: 'Иван', LAST_NAME: 'Иванов' }];
		throw new Error(`Unexpected method ${method}`);
	});
	const app = Fastify();
	app.decorate('config', { portalDomain: 'test.example' } as typeof app.config);
	registerStockMovementRoutes(app);
	t.after(() => app.close());
	const response = await app.inject({ method: 'POST', url: '/api/stock/movements', payload: { domain: 'test.example', accessToken: 'test', kind: 'delivery' } });
	assert.equal(response.json().ok, true, response.body);
	assert.equal(response.json().movements.length, 1011);
	assert.equal(response.json().movements[316].name, 'MAT-DN-2026-00763');
	assert.equal(response.json().movements[316].ownerName, 'Иван Иванов');
});
