import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerDealCoreRealizationRoute } from './deal-core-realization-route.js';
import { ErpClient } from '../erp/client.js';
import type { B24Client } from '../b24/client.js';

test('stale frontend cannot create a service realization; ERP service type overrides false client flag', async (t) => {
	let writes = 0;
	const erp = {
		async list(type: string) {
			if (type === 'Sales Order') return [{ name: 'SO' }];
			if (type === 'Item') return [{ name: '9916', is_stock_item: 0 }];
			throw new Error(`Unexpected read ${type}`);
		},
		async get(type: string, name: string) {
			if (type === 'Custom Field') return { name };
			if (type === 'Sales Order') return { name, b24_quote_variants: '', items: [{ name: 'row', item_code: '9916', qty: 1, rate: 154000 }] };
			throw new Error(`Unexpected get ${type}`);
		},
		async create() { writes++; throw new Error('No service document may be created'); },
		async update() { writes++; throw new Error('No document may be updated'); },
	} as unknown as ErpClient;
	t.mock.method(ErpClient, 'fromEnv', () => erp);
	const client = { async callBatch() { return { result: { p9916: { product: { type: 1 } } } }; } } as unknown as B24Client;
	const app = Fastify();
	app.decorate('operationLog', { async record() {} } as unknown as typeof app.operationLog);
	registerDealCoreRealizationRoute(app, () => client, async () => { throw new Error('No synchronization expected'); });
	t.after(() => app.close());
	const response = await app.inject({ method: 'POST', url: '/api/deal/realize-core', payload: { dealId: 32686, action: 'draft',
		groups: [{ storeTitle: 'Склад', lines: [{ productId: 9916, qty: 1, rate: 154000, isService: false }] }] } });
	assert.equal(response.json().ok, false, response.body);
	assert.match(response.json().error, /услуги не требуют реализации/);
	assert.equal(writes, 0);
});
