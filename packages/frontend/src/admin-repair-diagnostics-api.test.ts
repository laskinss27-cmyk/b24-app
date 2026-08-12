import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { domain: 'portal.example', accessToken: 'token' } } as Window,
});

const { diagnoseAdminRepair, searchAdminRepairs } = await import('./admin-repair-diagnostics-api.js');

test('admin repair search sends owner session and query', async () => {
	let requestBody: Record<string, unknown> = {};
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(JSON.stringify({ ok: true, repairs: [{ id: 17 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	assert.deepEqual(await searchAdminRepairs('REPAIR-100'), [{ id: 17 }]);
	assert.deepEqual(requestBody, { domain: 'portal.example', accessToken: 'token', query: 'REPAIR-100', limit: 30 });
});

test('admin repair diagnostics exposes readable server errors', async () => {
	globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: 'Ремонт не найден.' }), {
		status: 404,
		headers: { 'Content-Type': 'application/json' },
	})) as typeof fetch;
	await assert.rejects(diagnoseAdminRepair(404), /Ремонт не найден/);
});
