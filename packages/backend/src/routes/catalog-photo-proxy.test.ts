import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerInventoryReadRoutes } from './api-inventory-read-routes.js';

test('catalog photo proxy serves saved Unicode, space and punctuation filenames', async () => {
	const app = Fastify({ logger: false });
	registerInventoryReadRoutes(app);
	const previousFetch = globalThis.fetch;
	const previousBase = process.env['ERPNEXT_URL'];
	process.env['ERPNEXT_URL'] = 'http://frontend:8080/';
	const requested: string[] = [];
	const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
	globalThis.fetch = (async (input: string | URL | Request) => {
		requested.push(String(input));
		return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } });
	}) as typeof fetch;
	try {
		for (const name of ['Снимок экрана 2026-10-01 154432.jpg', 'photo.jpg', 'Фото (2) + 50%.jpg', '%2e%2e%2fprivate.jpg']) {
			const response = await app.inject({ method: 'GET', url: `/api/inventory/erp-image?p=${encodeURIComponent(`/files/${name}`)}` });
			assert.equal(response.statusCode, 200, name);
			assert.equal(response.headers['content-type'], 'image/jpeg');
			assert.deepEqual(response.rawPayload, bytes);
			assert.equal(requested.at(-1), `http://frontend:8080/files/${encodeURIComponent(name)}`);
		}
	} finally {
		globalThis.fetch = previousFetch;
		if (previousBase === undefined) delete process.env['ERPNEXT_URL']; else process.env['ERPNEXT_URL'] = previousBase;
		await app.close();
	}
});

test('catalog photo proxy refuses paths outside one public file segment without fetching', async () => {
	const app = Fastify({ logger: false });
	registerInventoryReadRoutes(app);
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async () => { throw new Error('invalid path reached fetch'); }) as typeof fetch;
	try {
		for (const path of ['', '/files/', '/files/.', '/files/..', '/files/../secret', '/files/a/b.jpg', '/files/a\\b.jpg', '/private/files/a.jpg', 'https://outside.example/a.jpg', '/files/a.jpg?x=1', '/files/a.jpg#x', '/files/a\u0000.jpg', '/files/a\n.jpg']) {
			const response = await app.inject({ method: 'GET', url: `/api/inventory/erp-image?p=${encodeURIComponent(path)}` });
			assert.equal(response.statusCode, 400, path);
		}
	} finally {
		globalThis.fetch = previousFetch;
		await app.close();
	}
});

test('catalog photo proxy preserves a missing core file response', async () => {
	const app = Fastify({ logger: false });
	registerInventoryReadRoutes(app);
	const previousFetch = globalThis.fetch;
	const previousBase = process.env['ERPNEXT_URL'];
	process.env['ERPNEXT_URL'] = 'http://frontend:8080';
	globalThis.fetch = (async () => new Response('missing', { status: 404 })) as typeof fetch;
	try {
		const response = await app.inject({ method: 'GET', url: `/api/inventory/erp-image?p=${encodeURIComponent('/files/Фото товара.jpg')}` });
		assert.equal(response.statusCode, 404);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousBase === undefined) delete process.env['ERPNEXT_URL']; else process.env['ERPNEXT_URL'] = previousBase;
		await app.close();
	}
});
