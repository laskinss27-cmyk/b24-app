import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { B24Client } from '../b24/client.js';
import type { Config } from '../config.js';
import { registerTransferRequestManagementRoutes } from './transfer-request-management-routes.js';

test('unauthenticated requests and employees outside supply cannot process TT requests', async () => {
	for (const authenticated of [false, true]) {
		const app = Fastify(); app.decorate('config', { transferRequestSqlRead: 'off' } as Config);
		const client = { call: async (method: string) => { assert.equal(method, 'user.current'); return { ID: 22, UF_DEPARTMENT: [5] }; } } as unknown as B24Client;
		registerTransferRequestManagementRoutes(app, () => authenticated ? client : null, new Set(), async () => { throw Error('unexpected transfer'); });
		const response = await app.inject({ method: 'POST', url: '/api/transfer-requests/process-supply', payload: { id: 21388 } });
		assert.equal(response.statusCode, 403); await app.close();
	}
});
test('cancel, old conversion and supply handoff share the same lock', async () => {
	const app = Fastify(); const locks = new Set(['transfer-request:21388']);
	const client = { call: async () => assert.fail('locked request must not touch storage or ERP') } as unknown as B24Client;
	registerTransferRequestManagementRoutes(app, () => client, locks, async () => { throw Error('unexpected transfer'); });
	for (const endpoint of ['cancel', 'convert', 'process-supply']) {
		const response = await app.inject({ method: 'POST', url: '/api/transfer-requests/' + endpoint, payload: { id: 21388 } });
		assert.equal(response.statusCode, 409);
	}
	assert.equal(locks.has('transfer-request:21388'), true); await app.close();
});
test('cancel cannot discard a durable pending ERP handoff', async () => {
	const app = Fastify(); const locks = new Set<string>(); app.decorate('config', { transferRequestSqlRead: 'off' } as Config);
	app.decorate('transferRequestSqlWriter', { mode: 'primary' } as NonNullable<typeof app.transferRequestSqlWriter>);
	const client = { call: async (method: string) => {
		if (method === 'user.current') return { ID: 1858 };
		if (method === 'entity.item.get') return [{ ID: 21388, NAME: 'Заявка', DETAIL_TEXT: JSON.stringify({ kind: 'supply', status: 'pending', supplyHandoff: { title: 'marker' } }) }];
		assert.fail('must not write ' + method);
	} } as unknown as B24Client;
	registerTransferRequestManagementRoutes(app, () => client, locks, async () => { throw Error('unexpected transfer'); });
	const response = await app.inject({ method: 'POST', url: '/api/transfer-requests/cancel', payload: { id: 21388 } });
	assert.equal(response.statusCode, 409); assert.equal(locks.size, 0); await app.close();
});
