import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { domain: 'portal.example', accessToken: 'token' } } as Window,
});

const { fetchOperationLog } = await import('./operation-log-api.js');

test('operation log request preserves auth, area and outcome filter', async () => {
	let body: Record<string, unknown> = {};
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(JSON.stringify({ ok: true, events: [{ id: 'event-1' }] }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as typeof fetch;

	assert.deepEqual(await fetchOperationLog('failure'), [{ id: 'event-1' }]);
	assert.deepEqual(body, {
		domain: 'portal.example',
		accessToken: 'token',
		area: 'realizations',
		limit: 200,
		outcome: 'failure',
	});
});

test('operation log exposes a readable backend error', async () => {
	globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: 'журнал недоступен' }), {
		status: 500,
		headers: { 'Content-Type': 'application/json' },
	})) as typeof fetch;
	await assert.rejects(fetchOperationLog(), /журнал недоступен/);
});
