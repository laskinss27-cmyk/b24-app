import assert from 'node:assert/strict';
import test from 'node:test';
import { B24ApiError, B24Client } from './client.js';

const client = (): B24Client => new B24Client({
	auth: { kind: 'oauth', domain: 'portal.example.test', accessToken: 'test-token' },
	requestsPerSecond: 100,
});

test('safe Bitrix reads retry a transient internal error', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls += 1;
		return calls === 1
			? new Response(JSON.stringify({ error: 'INTERNAL_SERVER_ERROR', error_description: 'Internal server error' }), { status: 200 })
			: new Response(JSON.stringify({ result: [{ ID: '42' }] }), { status: 200 });
	}) as typeof fetch;
	try {
		assert.deepEqual(await client().call('crm.deal.list', {}), [{ ID: '42' }]);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('Bitrix writes are never retried after an uncertain response', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls += 1;
		return new Response(JSON.stringify({ error: 'INTERNAL_SERVER_ERROR', error_description: 'Internal server error' }), { status: 200 });
	}) as typeof fetch;
	try {
		await assert.rejects(() => client().call('crm.deal.add', { fields: { TITLE: 'Test' } }), B24ApiError);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
