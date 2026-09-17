import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import {
	createInventoryRecoDraft,
	fetchErpPurchasingRates,
} from '../erp/operations.js';
import { registerInventoryReconciliationRoutes } from './api-inventory-reconciliation-routes.js';
import type { Config } from '../config.js';

const testConfig: Config = {
	port: 3000,
	host: '127.0.0.1',
	portalDomain: 'portal.example.bitrix24.ru',
	publicBaseUrl: 'https://app.example.com',
	appSectionUrl: '',
	inventoryNotify: 'off',
	appOAuthVault: 'off',
	supplyShadowCompare: 'off',
	supplySqlRead: 'off',
	transferSqlRead: 'off',
	transferRequestSqlRead: 'off',
	inventorySqlRead: 'off',
	repairSqlRead: 'off',
	appClientId: 'local.test',
	appClientSecret: 'secret',
	nodeEnv: 'test',
};

interface ErpMock {
	client: ErpClient;
	requests: Array<{ method: string; path: string }>;
	created: Array<{ doctype: string; fields: Record<string, unknown> }>;
	deleted: Array<{ doctype: string; name: string }>;
}

/** Ядро без закупочной цены товара #202: Standard Buying пуст, valuation_rate = 0. */
function mockErp(): ErpMock {
	const requests: ErpMock['requests'] = [];
	const created: ErpMock['created'] = [];
	const deleted: ErpMock['deleted'] = [];
	const client = {
		list: async (doctype: string) => {
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Bin') return [
				{ item_code: '101', actual_qty: 5, valuation_rate: 125.5 },
				{ item_code: '202', actual_qty: 2, valuation_rate: 0 },
			];
			if (doctype === 'Item Price') return [];
			if (doctype === 'Item') return [
				{ name: '101', item_name: 'Relay', valuation_rate: 125.5 },
				{ name: '202', item_name: 'Sensor', valuation_rate: 0 },
			];
			if (doctype === 'Account') return [{ name: 'Stock Adjustment - TEST' }];
			return [];
		},
		get: async (doctype: string, name: string) => {
			if (doctype === 'Custom Field') return { name };
			if (doctype === 'Stock Reconciliation') return { name, docstatus: 0, items: [] };
			if (doctype === 'Stock Entry') return { name, docstatus: 0, items: [] };
			return null;
		},
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: `NEW-${doctype}` };
		},
		request: async (method: string, path: string) => {
			requests.push({ method, path });
			return { status: 200, json: {} };
		},
		delete: async (doctype: string, name: string) => {
			deleted.push({ doctype, name });
		},
	} as unknown as ErpClient;
	return { client, requests, created, deleted };
}

function reconciledPoint(extra: Record<string, unknown>): Record<string, unknown> {
	return {
		storeId: 7,
		storeName: 'Main',
		status: 'reconciled',
		draft: { 101: 2, 202: 4 },
		result: { lines: [{ productId: 101, name: 'Relay' }, { productId: 202, name: 'Sensor' }] },
		...extra,
	};
}

interface MockHarness {
	mock: {
		method: (target: unknown, method: string, implementation: (...args: never[]) => unknown) => void;
	};
}

async function injectRecreate(t: unknown, point: Record<string, unknown>) {
	const harness = t as MockHarness;
	const erp = mockErp();
	let bitrixWrites = 0;
	harness.mock.method(B24Client.prototype, 'call', async (method: string) => {
		if (method === 'entity.item.update') bitrixWrites += 1;
		return true;
	});
	harness.mock.method(B24Client.prototype, 'callWithMeta', async (method: string) => {
		assert.equal(method, 'entity.item.get');
		return {
			result: [{
				ID: '42', NAME: 'Ревизия',
				DETAIL_TEXT: JSON.stringify({ status: 'active', points: [point] }),
			}],
		};
	});
	harness.mock.method(ErpClient, 'fromEnv', () => erp.client);
	const app = Fastify();
	app.decorate('config', testConfig);
	registerInventoryReconciliationRoutes(app);
	try {
		const response = await app.inject({
			method: 'POST',
			url: '/api/inventory/erp-doc-save',
			payload: {
				domain: testConfig.portalDomain, accessToken: 'test-only',
				inventoryId: '42', storeId: 7, recreate: true,
			},
		});
		return { body: response.json() as Record<string, unknown>, erp, bitrixWrites };
	} finally {
		await app.close();
	}
}

test('legacy recreate without purchase price keeps the old Stock Reconciliation draft', async (t) => {
	const point = reconciledPoint({
		erpDoc: { name: 'RECO-OLD', status: 'draft', lines: 2, savedAt: '2026-09-17T00:00:00.000Z' },
	});
	const { body, erp, bitrixWrites } = await injectRecreate(t, point);
	assert.equal(body['ok'], false);
	assert.match(String(body['error']), /нет закупочной цены.*товар #202/);
	// Старый черновик не удалён, новый не создан, состояние Б24 не тронуто.
	assert.deepEqual(erp.requests, []);
	assert.deepEqual(erp.created, []);
	assert.deepEqual(erp.deleted, []);
	assert.equal(bitrixWrites, 0);
	assert.equal(String((point['erpDoc'] as Record<string, unknown>)['name']), 'RECO-OLD');
});

test('recreate without purchase price keeps existing Stock Entry drafts', async (t) => {
	const point = reconciledPoint({
		erpDocs: {
			issue: { name: 'STE-ISS-1', status: 'draft', lines: 1, savedAt: '2026-09-17T00:00:00.000Z' },
			receipt: { name: 'STE-REC-1', status: 'draft', lines: 1, savedAt: '2026-09-17T00:00:00.000Z' },
		},
	});
	const { body, erp, bitrixWrites } = await injectRecreate(t, point);
	assert.equal(body['ok'], false);
	assert.match(String(body['error']), /нет закупочной цены.*товар #202/);
	assert.deepEqual(erp.deleted, []);
	assert.deepEqual(erp.created, []);
	assert.equal(bitrixWrites, 0);
});

test('first save without purchase price writes nothing to ERPNext at all', async (t) => {
	const point = reconciledPoint({});
	const erp = mockErp();
	let bitrixWrites = 0;
	const harness = t as MockHarness;
	harness.mock.method(B24Client.prototype, 'call', async (method: string) => {
		if (method === 'entity.item.update') bitrixWrites += 1;
		return true;
	});
	harness.mock.method(B24Client.prototype, 'callWithMeta', async (method: string) => {
		assert.equal(method, 'entity.item.get');
		return {
			result: [{
				ID: '42', NAME: 'Ревизия',
				DETAIL_TEXT: JSON.stringify({ status: 'active', points: [point] }),
			}],
		};
	});
	harness.mock.method(ErpClient, 'fromEnv', () => erp.client);
	const app = Fastify();
	app.decorate('config', testConfig);
	registerInventoryReconciliationRoutes(app);
	try {
		const response = await app.inject({
			method: 'POST',
			url: '/api/inventory/erp-doc-save',
			payload: {
				domain: testConfig.portalDomain, accessToken: 'test-only',
				inventoryId: '42', storeId: 7,
			},
		});
		const body = response.json() as Record<string, unknown>;
		assert.equal(body['ok'], false);
		assert.match(String(body['error']), /нет закупочной цены.*товар #202/);
		// Ни временный черновик списания, ни любая другая запись в ядро не создавались.
		assert.deepEqual(erp.created, []);
		assert.deepEqual(erp.deleted, []);
		assert.deepEqual(erp.requests, []);
		assert.equal(bitrixWrites, 0);
	} finally {
		await app.close();
	}
});

test('legacy Stock Reconciliation allows a shortage line with zero valuation', async () => {
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const client = {
		list: async (doctype: string) => {
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Account') return [{ name: 'Stock Adjustment - TEST' }];
			return [];
		},
		get: async (doctype: string, name: string) => doctype === 'Custom Field' ? { name } : null,
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: 'RECO-1' };
		},
	} as unknown as ErpClient;

	const result = await createInventoryRecoDraft(client, {
		invRef: 'inv42:store7',
		storeTitle: 'Main',
		lines: [{ productId: 101, qty: 2, valuation: 0, requiresPrice: false }],
	});
	assert.deepEqual(result, { name: 'RECO-1' });
	const document = created.find((entry) => entry.doctype === 'Stock Reconciliation');
	assert.deepEqual(document?.fields['items'], [{
		item_code: '101', warehouse: 'Main - TEST', qty: 2, valuation_rate: 0,
	}]);
});

test('surplus valuation resolves Standard Buying first with item valuation fallback', async () => {
	const calls: Array<{ doctype: string; filters: unknown[][] }> = [];
	const client = {
		list: async (doctype: string, _fields: string[], filters: unknown[][] = []) => {
			calls.push({ doctype, filters: structuredClone(filters) });
			if (doctype === 'Item Price') {
				if (filters.some((filter) => filter[2] === 'Standard Buying')) {
					return [
						{ item_code: '101', price_list_rate: 12.5 },
						{ item_code: '303', price_list_rate: 0.01 },
					];
				}
				return [{ item_code: '101', price_list_rate: 99 }];
			}
			if (doctype === 'Item') return [
				{ name: '101', valuation_rate: 9 },
				{ name: '202', valuation_rate: 18 },
				{ name: '303', valuation_rate: 40 },
				{ name: '404', valuation_rate: 0.01 },
			];
			return [];
		},
	} as unknown as ErpClient;

	const rates = await fetchErpPurchasingRates(client, [101, 202, 303, 404]);
	// Standard Buying побеждает valuation_rate; valuation_rate — fallback; ноль и 0,01 отвергаются.
	assert.deepEqual([...rates], [[101, 12.5], [202, 18], [303, 40]]);
	const buying = calls.find((call) => call.doctype === 'Item Price' && call.filters.some((filter) => filter[2] === 'Standard Buying'));
	assert.ok(buying, 'Standard Buying price list queried');
});
