import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { domain: 'portal.example', accessToken: 'token' } } as Window,
});

const { checkAdminControl } = await import('./admin-control-api.js');

test('admin control check preserves owner session and returns the report', async () => {
	let requestBody: Record<string, unknown> = {};
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(JSON.stringify({ ok: true, report: { generatedAt: '2026-08-13T10:00:00Z', dateFrom: '2026-08-01', dateTo: '2026-08-13', checkedDeals: 10, checkedRepairs: 8, findings: [] } }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as typeof fetch;
	assert.deepEqual(await checkAdminControl('2026-08-01', '2026-08-13'), { generatedAt: '2026-08-13T10:00:00Z', dateFrom: '2026-08-01', dateTo: '2026-08-13', checkedDeals: 10, checkedRepairs: 8, findings: [] });
	assert.deepEqual(requestBody, { domain: 'portal.example', accessToken: 'token', dateFrom: '2026-08-01', dateTo: '2026-08-13' });
});
