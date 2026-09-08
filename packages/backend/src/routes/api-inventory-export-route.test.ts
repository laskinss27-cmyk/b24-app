import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import ExcelJS from 'exceljs';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import type { Config } from '../config.js';
import { registerInventoryExportRoute } from './api-inventory-export-route.js';

test('authenticated export reads only entity and Item metadata; scoped XLSX has frozen quantities', async (t) => {
	const calls: string[] = [];
	t.mock.method(B24Client.prototype, 'call', async (method: string) => {
		calls.push(method); assert.equal(method, 'user.current'); return { ID: '1' };
	});
	t.mock.method(B24Client.prototype, 'callWithMeta', async (method: string) => {
		calls.push(method); assert.equal(method, 'entity.item.get');
		return { result: [{ ID: '42', NAME: 'Тест', DETAIL_TEXT: JSON.stringify({ points: [{ storeId: -10, storeName: 'Склад',
			stockSnapshot: { version: 1, lines: [[1, 10]] }, draft: { 1: 9 } }, { storeId: -20 }] }) }] };
	});
	t.mock.method(ErpClient, 'fromEnv', () => ({ async list(doctype: string) {
		calls.push(doctype); assert.equal(doctype, 'Item'); return [{ name: '1', item_name: 'Монитор', b24_article: '001' }];
	} }));
	const app = Fastify();
	app.decorate('config', { portalDomain: 'portal.example', inventorySqlRead: 'off' } as Config);
	registerInventoryExportRoute(app);
	try {
		const res = await app.inject({ method: 'POST', url: '/api/inventory/export-xlsx', payload: {
			domain: 'portal.example', accessToken: 'test', inventoryId: '42', storeId: -10,
		} });
		assert.equal(res.statusCode, 200, res.body.slice(0, 100));
		assert.match(String(res.headers['content-type']), /spreadsheetml/);
		assert.match(String(res.headers['content-disposition']), /filename\*=UTF-8''/);
		assert.equal(res.headers['cache-control'], 'no-store');
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(res.rawPayload as unknown as ExcelJS.Buffer);
		assert.equal(workbook.getWorksheet('Товары')!.getCell('C6').value, 'Монитор');
		assert.equal(workbook.getWorksheet('Товары')!.getCell('E6').value, 10);
		assert.equal(workbook.getWorksheet('Сводка')!.rowCount, 6);
		assert.deepEqual(calls, ['user.current', 'entity.item.get', 'Item']);
	} finally { await app.close(); }
});

test('missing auth, wrong domain and malformed targets are rejected before reads', async () => {
	const app = Fastify();
	app.decorate('config', { portalDomain: 'portal.example', inventorySqlRead: 'off' } as Config);
	registerInventoryExportRoute(app);
	try {
		for (const [payload, expected] of [
			[{}, 403], [{ domain: 'wrong', accessToken: 'test', inventoryId: '42' }, 403],
			[{ domain: 'portal.example', accessToken: 'test', inventoryId: '../42' }, 400],
			[{ domain: 'portal.example', accessToken: 'test', inventoryId: '42', storeId: 'all' }, 400],
		] as const) assert.equal((await app.inject({ method: 'POST', url: '/api/inventory/export-xlsx', payload })).statusCode, expected);
	} finally { await app.close(); }
});

test('invalid token cannot read inventory even when global permission hook is unavailable', async (t) => {
	t.mock.method(B24Client.prototype, 'call', async () => { throw new Error('expired_token'); });
	t.mock.method(B24Client.prototype, 'callWithMeta', async () => { assert.fail('must not read inventory'); });
	const app = Fastify();
	app.decorate('config', { portalDomain: 'portal.example', inventorySqlRead: 'off' } as Config);
	registerInventoryExportRoute(app);
	try {
		const res = await app.inject({ method: 'POST', url: '/api/inventory/export-xlsx', payload: { domain: 'portal.example', accessToken: 'bad', inventoryId: '42' } });
		assert.equal(res.statusCode, 400);
		assert.match(res.json().error, /expired_token/);
	} finally { await app.close(); }
});
