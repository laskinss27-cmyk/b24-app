import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { domain: 'portal.example', accessToken: 'token' } } as Window,
});

const { diagnoseAdminDealDocuments, searchAdminDealDocuments } = await import('./admin-deal-documents-api.js');

test('admin deal document search preserves owner session and document query', async () => {
	let url = '';
	let requestBody: Record<string, unknown> = {};
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		url = String(input);
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(JSON.stringify({ ok: true, deals: [{ dealId: 37868 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	assert.deepEqual(await searchAdminDealDocuments('MAT-DN-2026-00451'), [{ dealId: 37868 }]);
	assert.equal(url, '/api/admin/deal-documents/search');
	assert.deepEqual(requestBody, { domain: 'portal.example', accessToken: 'token', query: 'MAT-DN-2026-00451', limit: 30 });
});

test('admin deal diagnostics sends the selected deal id and exposes server errors', async () => {
	let requestBody: Record<string, unknown> = {};
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(JSON.stringify({ ok: true, diagnostic: { deal: { id: 37868 }, documents: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	assert.equal((await diagnoseAdminDealDocuments(37868)).deal.id, 37868);
	assert.deepEqual(requestBody, { domain: 'portal.example', accessToken: 'token', dealId: 37868 });

	globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: 'Документы недоступны.' }), { status: 500, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
	await assert.rejects(diagnoseAdminDealDocuments(37868), /Документы недоступны/);
});
