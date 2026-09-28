import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Config } from '../config.js';
import { ErpClient } from '../erp/client.js';
import { registerSupplyRequestRoutes } from './api-supply-request-routes.js';

test('supply creation and comment editing require common note before any ERP operation', async (t) => {
	t.mock.method(ErpClient, 'fromEnv', () => { assert.fail('invalid comment must not reach ERP'); });
	const app = Fastify();
	app.decorate('config', { portalDomain: 'portal.example' } as Config);
	registerSupplyRequestRoutes(app, new Set());
	try {
		for (const url of ['/api/supply/request', '/api/supply/request-note']) {
			for (const note of [undefined, null, '', ' \n\t ', {}, 123, 'x'.repeat(501)]) {
				const response = await app.inject({ method: 'POST', url, payload: { domain: 'portal.example', accessToken: 'test', dealId: 42,
					requestName: 'MR-42', lines: [{ productId: 1, qty: 1 }], ...(note === undefined ? {} : { note }) } });
				assert.equal(response.statusCode, 400);
				assert.match(response.json().error, /общий комментарий|Общий комментарий/);
			}
		}
	} finally { await app.close(); }
});

test('old clients cannot create orders with per-line notes and silently lose them', async (t) => {
	t.mock.method(ErpClient, 'fromEnv', () => { assert.fail('must reject before writes'); });
	const app = Fastify();
	app.decorate('config', { portalDomain: 'portal.example' } as Config);
	registerSupplyRequestRoutes(app, new Set());
	try {
		const response = await app.inject({ method: 'POST', url: '/api/supply/request', payload: {
			domain: 'portal.example', accessToken: 'test', dealId: 42, note: 'Общий', lines: [{ productId: 1, qty: 1, note: 'Белый' }],
		} });
		assert.equal(response.statusCode, 400);
		assert.match(response.json().error, /Перенесите их в общий комментарий/);
	} finally { await app.close(); }
});
