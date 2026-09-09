import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ErpApiError, ErpClient } from '../erp/client.js';
import { B24Client } from '../b24/client.js';
import { registerStockDocumentSubmitRoute } from './api-stock-document-submit-route.js';

test('owner and ordinary supply operator receive the same useful posting error; unauthorized user remains blocked', async t => {
	let user = { ID: '1858', UF_DEPARTMENT: [] as number[] };
	let attempts = 0;
	t.mock.method(B24Client.prototype, 'call', async () => user);
	t.mock.method(ErpClient, 'fromEnv', () => ({
		async get() { return { stock_entry_type: 'Material Receipt' }; },
		async submit() { attempts++; throw new ErpApiError('PUT', '/api/resource/Stock%20Entry/TEST', 417, '<b>Заполните обязательное поле</b>: Склад'); },
	}) as unknown as ErpClient);
	const app = Fastify();
	app.decorate('config', { portalDomain: 'example.bitrix24.ru' } as typeof app.config);
	registerStockDocumentSubmitRoute(app);
	t.after(() => app.close());
	const request = () => app.inject({ method: 'POST', url: '/api/stock/submit', payload: { domain: 'example.bitrix24.ru', accessToken: 'test', kind: 'receipt', doctype: 'Stock Entry', name: 'TEST' } });
	const owner = await request();
	user = { ID: '2000', UF_DEPARTMENT: [10] };
	const employee = await request();
	assert.equal(owner.json().ok, false); assert.equal(employee.json().ok, false);
	assert.equal(employee.json().error, owner.json().error);
	assert.match(employee.json().error, /Заполните обязательное поле/);
	assert.doesNotMatch(employee.json().error, /<|ErpApiError|\/api\//);
	assert.equal(attempts, 2);
	user = { ID: '2001', UF_DEPARTMENT: [12] };
	assert.equal((await request()).statusCode, 403);
	assert.equal(attempts, 2);
});
