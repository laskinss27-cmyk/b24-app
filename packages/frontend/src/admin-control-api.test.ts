import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { domain: 'portal.example', accessToken: 'token' } } as Window,
});

const { checkAdminControl } = await import('./admin-control-api.js');

test('admin control check preserves owner session and returns the report', async () => {
	const requestBodies: Array<Record<string, unknown>> = [];
	let call = 0;
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		call += 1;
		const batch = call === 1
			? { scanId: 'scan-1', generatedAt: '2026-08-13T10:00:00Z', dateFrom: '2026-08-01', dateTo: '2026-08-13', totalDeals: 2, totalRepairs: 1, checkedDeals: 1, checkedRepairs: 1, findings: [{ id: 'deal:10:x' }], nextCursor: { dealOffset: 1, repairOffset: 1 } }
			: { scanId: 'scan-1', generatedAt: '2026-08-13T10:00:01Z', dateFrom: '2026-08-01', dateTo: '2026-08-13', totalDeals: 2, totalRepairs: 1, checkedDeals: 1, checkedRepairs: 0, findings: [], nextCursor: null };
		return new Response(JSON.stringify({ ok: true, batch }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as typeof fetch;
	assert.deepEqual(await checkAdminControl('2026-08-01', '2026-08-13'), {
		generatedAt: '2026-08-13T10:00:01Z', dateFrom: '2026-08-01', dateTo: '2026-08-13', totalDeals: 2, totalRepairs: 1, checkedDeals: 2, checkedRepairs: 1, findings: [{ id: 'deal:10:x' }],
	});
	assert.deepEqual(requestBodies, [
		{ domain: 'portal.example', accessToken: 'token', dateFrom: '2026-08-01', dateTo: '2026-08-13', dealOffset: 0, repairOffset: 0 },
		{ domain: 'portal.example', accessToken: 'token', dateFrom: '2026-08-01', dateTo: '2026-08-13', dealOffset: 1, repairOffset: 1, scanId: 'scan-1' },
	]);
});

test('admin control turns an HTML gateway timeout into a readable error', async () => {
	globalThis.fetch = (async () => new Response('<html><h1>504 Gateway Time-out</h1></html>', {
		status: 504,
		headers: { 'Content-Type': 'text/html' },
	})) as typeof fetch;
	await assert.rejects(checkAdminControl('2026-08-01', '2026-08-13'), /не уложился в 60 секунд/);
});
