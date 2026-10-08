import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { registerInventoryReconciliationRoutes } from './api-inventory-reconciliation-routes.js';
import { INVENTORY_POSTING_FIELD } from '../erp/inventory-posting-audit.js';

for (const legacy of [false, true]) {
	test(`inventory HTTP posting ignores forged actor and retains identity after reload (legacy=${legacy})`, async () => {
		const originalCall = B24Client.prototype.call;
		const originalFromEnv = ErpClient.fromEnv;
		const name = legacy ? 'RECO' : 'STE';
		let point: Record<string, unknown> = { storeId: 7, status: 'reconciled', result: { discrepancies: 1 }, ...(legacy ? { erpDoc: { name, status: 'draft', lines: 1 } } : { erpDocs: { receipt: { name, status: 'draft', lines: 1 } } }) };
		let posting: Record<string, unknown> = { name, docstatus: 0 };
		let validIdentity = true;
		let writes = 0;
		B24Client.prototype.call = (async (method: string, params: Record<string, unknown>) => {
			if (method === 'user.current') return { ID: validIdentity ? '78' : '', NAME: 'Даниил', LAST_NAME: 'Андропов' };
			if (method === 'entity.item.get') return [{ ID: '10', NAME: 'Test', DETAIL_TEXT: JSON.stringify({ points: [point] }) }];
			if (method === 'entity.item.update') { point = JSON.parse(String(params['DETAIL_TEXT'])).points[0]; return true; }
			throw new Error(`Unexpected B24 method ${method}`);
		}) as typeof B24Client.prototype.call;
		ErpClient.fromEnv = () => ({
			get: async (doctype: string) => doctype === 'Custom Field' ? {} : structuredClone(posting),
			update: async (_doctype: string, _name: string, fields: Record<string, unknown>) => { writes++; posting = { ...posting, ...fields }; return structuredClone(posting); },
		} as unknown as ErpClient);
		const app = Fastify({ logger: false });
		app.decorate('config', { portalDomain: 'example.bitrix24.ru', port: 3000, host: '127.0.0.1', publicBaseUrl: 'https://example.test', appSectionUrl: '', inventoryNotify: 'off', nodeEnv: 'test' });
		registerInventoryReconciliationRoutes(app);
		const payload = { domain: 'example.bitrix24.ru', accessToken: 'test', inventoryId: '10', storeId: 7, submittedById: '999', submittedByName: 'Forged', actor: { id: '999', name: 'Forged' } };
		try {
			validIdentity = false;
			assert.equal((await app.inject({ method: 'POST', url: '/api/inventory/erp-doc-submit', payload })).json().ok, false);
			assert.equal(writes, 0);
			validIdentity = true;
			const response = (await app.inject({ method: 'POST', url: '/api/inventory/erp-doc-submit', payload })).json();
			assert.equal(response.ok, true);
			const record = legacy ? response.legacyDoc : response.docs.receipt;
			assert.equal(record.submittedById, '78');
			assert.equal(record.submittedByName, 'Даниил Андропов');
			assert.equal(JSON.parse(String(posting[INVENTORY_POSTING_FIELD])).id, '78');
			assert.equal(writes, 1);
			assert.equal((await app.inject({ method: 'POST', url: '/api/inventory/erp-doc-submit', payload })).json().ok, true);
			assert.equal(writes, 1);
		} finally { B24Client.prototype.call = originalCall; ErpClient.fromEnv = originalFromEnv; await app.close(); }
	});
}
