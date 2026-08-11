import assert from 'node:assert/strict';
import test from 'node:test';
import { B24ApiError, type B24Client } from './b24/client.js';
import { addCatalogProductWithAccessFallback, isCatalogProductAccessDenied } from './catalog-product-writer.js';

type Call = { method: string; params: Record<string, unknown> };

function clientWith(
	call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): B24Client {
	return { call } as unknown as B24Client;
}

test('catalog product creation keeps the user identity when Bitrix accepts the write', async () => {
	const userCalls: Call[] = [];
	const systemCalls: Call[] = [];
	const userClient = clientWith(async (method, params) => {
		userCalls.push({ method, params });
		return { element: { id: 17 } };
	});
	const systemClient = clientWith(async (method, params) => {
		systemCalls.push({ method, params });
		return { element: { id: 18 } };
	});

	const written = await addCatalogProductWithAccessFallback<{ element: { id: number } }>({
		userClient,
		systemClient,
		fields: { name: 'Test' },
	});

	assert.equal(written.result.element.id, 17);
	assert.equal(written.client, userClient);
	assert.equal(written.delegated, false);
	assert.deepEqual(userCalls, [{ method: 'catalog.product.add', params: { fields: { name: 'Test' } } }]);
	assert.deepEqual(systemCalls, []);
});

test('catalog product creation delegates only the Bitrix access-denied failure', async () => {
	const denied = new B24ApiError('catalog.product.add', '200040300040', 'Access Denied', 200);
	const userClient = clientWith(async () => { throw denied; });
	const systemClient = clientWith(async () => ({ element: { id: 19 } }));

	const written = await addCatalogProductWithAccessFallback<{ element: { id: number } }>({
		userClient,
		systemClient,
		fields: { name: 'Test' },
	});

	assert.equal(isCatalogProductAccessDenied(denied), true);
	assert.equal(written.result.element.id, 19);
	assert.equal(written.client, systemClient);
	assert.equal(written.delegated, true);
});

test('catalog product creation does not hide unrelated Bitrix failures', async () => {
	const failure = new B24ApiError('catalog.product.add', 'ERROR_CORE', 'Unexpected failure', 200);
	const userClient = clientWith(async () => { throw failure; });
	let systemCalled = false;
	const systemClient = clientWith(async () => {
		systemCalled = true;
		return { element: { id: 20 } };
	});

	await assert.rejects(
		addCatalogProductWithAccessFallback({ userClient, systemClient, fields: { name: 'Test' } }),
		(error: unknown) => error === failure,
	);
	assert.equal(systemCalled, false);
});
