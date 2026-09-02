import assert from 'node:assert/strict';
import test from 'node:test';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ensureBundleProduct, marketplaceBundleItemName } from './api-marketplaces.js';

type Call = { method: string; params: Record<string, unknown> };

function clientWith(call: (method: string, params: Record<string, unknown>) => Promise<unknown>): B24Client {
	return { call } as unknown as B24Client;
}

test('marketplace bundle name uses only model and units per bundle', () => {
	assert.equal(
		marketplaceBundleItemName('  CTV-M5702 W  ', 4),
		'Комплект CTV-M5702 W 4 шт',
	);
});

test('marketplace bundle reuses an exact existing Bitrix product', async () => {
	const calls: Call[] = [];
	const client = clientWith(async (method, params) => {
		calls.push({ method, params });
		return { products: [{ id: 20460, name: 'Комплект ИП 212-142 2 шт' }] };
	});

	const result = await ensureBundleProduct(client, null, 'Комплект ИП 212-142 2 шт');

	assert.deepEqual(result, { productId: 20460, delegated: false });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.method, 'catalog.product.list');
});

test('marketplace bundle delegates only a denied product creation', async () => {
	const userCalls: Call[] = [];
	const systemCalls: Call[] = [];
	const userClient = clientWith(async (method, params) => {
		userCalls.push({ method, params });
		if (method === 'catalog.product.list') return { products: [] };
		throw new B24ApiError(method, '200040300040', 'Access Denied', 200);
	});
	const systemClient = clientWith(async (method, params) => {
		systemCalls.push({ method, params });
		return { element: { id: 20461 } };
	});

	const result = await ensureBundleProduct(userClient, systemClient, 'Комплект ИП 212-142 2 шт');

	assert.deepEqual(result, { productId: 20461, delegated: true });
	assert.deepEqual(userCalls.map((call) => call.method), ['catalog.product.list', 'catalog.product.add']);
	assert.deepEqual(systemCalls.map((call) => call.method), ['catalog.product.add']);
});
