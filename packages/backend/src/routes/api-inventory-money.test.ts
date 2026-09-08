import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Config } from '../config.js';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { registerInventoryUpdateRoute } from './api-inventory-update-route.js';

test('failed retail lookup does not persist submitted status or replace the saved draft', async (t) => {
	const state = { status: 'active', points: [{ storeId: -1, storeName: 'Склад', status: 'in_progress',
		stockSnapshot: { version: 1, capturedAt: '2026-09-08T10:00:00Z', lines: [[1, 10]] }, draft: { 1: 8 },
	}] };
	let writes = 0;
	t.mock.method(B24Client.prototype, 'call', async (method: string) => {
		if (method === 'entity.item.update') writes++;
		return true;
	});
	t.mock.method(B24Client.prototype, 'callWithMeta', async () => ({ result: [{ ID: '42', NAME: 'Ревизия', DETAIL_TEXT: JSON.stringify(state) }] }));
	t.mock.method(ErpClient, 'fromEnv', () => ({ async list() { throw new Error('Price service unavailable'); } }));
	const app = Fastify(); app.decorate('config', { portalDomain: 'portal.example', inventorySqlRead: 'off' } as Config); registerInventoryUpdateRoute(app);
	try {
		const response = (await app.inject({ method: 'POST', url: '/api/inventory/update', payload: {
			domain: 'portal.example', accessToken: 'test', inventoryId: '42', storeId: -1, action: 'submit', userId: '1',
			facts: { 1: 8 }, result: { total: 1, counted: 1, discrepancies: 1, lines: [{ productId: 1, name: 'Монитор', book: 10, fact: 8, diff: -2 }] },
		} })).json();
		assert.equal(response.ok, false); assert.equal(writes, 0);
		assert.equal(state.points[0]!.status, 'in_progress');
		assert.deepEqual(state.points[0]!.draft, { 1: 8 });
	} finally { await app.close(); }
});

test('submission persists server retail price, ignores forged client price and rejects repricing a submitted result', async (t) => {
	let state = { status: 'active', points: [{ storeId: -1, storeName: 'Склад', status: 'in_progress',
		stockSnapshot: { version: 1, capturedAt: '2026-09-08T10:00:00Z', lines: [[1, 10], [2, 4]] }, draft: { 1: 8 },
	}] } as Record<string, unknown>;
	let writes = 0; let priceReads = 0;
	t.mock.method(B24Client.prototype, 'call', async (method: string, params: Record<string, unknown>) => {
		if (method === 'entity.item.update') { writes++; state = JSON.parse(String(params['DETAIL_TEXT'])); }
		else assert.equal(method, 'entity.add');
		return true;
	});
	t.mock.method(B24Client.prototype, 'callWithMeta', async () => ({ result: [{ ID: '42', NAME: 'Ревизия', DETAIL_TEXT: JSON.stringify(state) }] }));
	t.mock.method(ErpClient, 'fromEnv', () => ({ async list(doctype: string) { assert.equal(doctype, 'Item Price'); priceReads++; return [{ item_code: '1', price_list_rate: 5000, currency: 'RUB' }]; } }));
	const app = Fastify(); app.decorate('config', { portalDomain: 'portal.example', inventorySqlRead: 'off' } as Config); registerInventoryUpdateRoute(app);
	const payload = { domain: 'portal.example', accessToken: 'test', inventoryId: '42', storeId: -1, action: 'submit', userId: '1',
		facts: { 1: 8 }, result: { total: 2, counted: 1, discrepancies: 1, lines: [{ productId: 1, name: 'Монитор', book: 99, fact: 8, diff: -91, retailPrice: 1 }] } };
	try {
		const response = (await app.inject({ method: 'POST', url: '/api/inventory/update', payload })).json();
		assert.equal(response.ok, true, response.error);
		assert.equal(response.result.lines[0].retailPrice, 5000);
		assert.equal(response.result.lines[0].diff, -2);
		assert.equal(response.result.lines.length, 1, 'uncounted item does not become a shortage');
		assert.equal(writes, 1);
		const again = (await app.inject({ method: 'POST', url: '/api/inventory/update', payload })).json();
		assert.equal(again.ok, false); assert.equal(writes, 1); assert.equal(priceReads, 1);
		assert.match(JSON.stringify(state), /"retailPrice":5000/);
	} finally { await app.close(); }
});
