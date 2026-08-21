import assert from 'node:assert/strict';
import test from 'node:test';
import { TildaCommerceMlClient } from './commerce-ml-client.js';

const config = { url: 'https://store.tilda.ru/connector/123', username: 'user', password: 'secret' };

test('Tilda CommerceML client keeps one session and sends only the offers XML body', async () => {
	const requests: Array<{ mode: string; method: string; cookie: string | null; authorization: string | null; contentType: string | null; body: string }> = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		const mode = url.searchParams.get('mode') ?? '';
		requests.push({
			mode,
			method: init?.method ?? 'GET',
			cookie: headers.get('Cookie'),
			authorization: headers.get('Authorization'),
			contentType: headers.get('Content-Type'),
			body: init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : String(init?.body ?? ''),
		});
		if (mode === 'checkauth') return new Response('success\nPHPSESSID\nsession-value\n');
		if (mode === 'init') return new Response('zip=no\nfile_limit=1024\n');
		if (mode === 'file') return new Response('success\n');
		return new Response(requests.filter((request) => request.mode === 'import').length === 1 ? 'progress\n' : 'success\n');
	};
	const client = new TildaCommerceMlClient(config, fetcher as typeof fetch);
	const session = await client.authenticateAndInitialize();
	const result = await client.uploadAndImportOffers(session, '<xml/>');

	assert.deepEqual(result, { fileName: 'offers0_1.xml', importResponses: ['progress', 'success'] });
	assert.deepEqual(requests.map((request) => request.mode), ['checkauth', 'init', 'file', 'import', 'import']);
	assert.match(requests[0]?.authorization ?? '', /^Basic /u);
	assert.equal(requests[0]?.cookie, null);
	assert.ok(requests.slice(1).every((request) => request.cookie === 'PHPSESSID=session-value'));
	assert.equal(requests[2]?.method, 'POST');
	assert.equal(requests[2]?.body, '<xml/>');
	assert.equal(requests[2]?.contentType, 'application/octet-stream');
	assert.ok(requests.filter((request) => request.mode !== 'file').every((request) => request.body === ''));
});

test('Tilda CommerceML client fails closed before upload on protocol or size errors', async () => {
	const responses = ['success\nPHPSESSID\nsession\n', 'zip=no\nfile_limit=4\n'];
	const client = new TildaCommerceMlClient(config, (async () => new Response(responses.shift())) as typeof fetch);
	const session = await client.authenticateAndInitialize();
	await assert.rejects(client.uploadAndImportOffers(session, '<xml/>'), /exceeds/u);
	assert.throws(() => new TildaCommerceMlClient({ ...config, url: 'http://store.tilda.ru/connector' }), /HTTPS/u);
	assert.throws(() => new TildaCommerceMlClient({ ...config, url: 'https://example.com/connector' }), /store\.tilda\.ru/u);
});

test('Tilda CommerceML client preserves a bounded sanitized protocol failure reason', async () => {
	const responses = [
		'success\nPHPSESSID\nsession\n',
		'zip=no\nfile_limit=1024\n',
		'success\n',
		'failure\nНе передан import.xml: https://secret.example/path\n',
	];
	const client = new TildaCommerceMlClient(config, (async () => new Response(responses.shift())) as typeof fetch);
	const session = await client.authenticateAndInitialize();
	await assert.rejects(client.uploadAndImportOffers(session, '<xml/>'), /failure \| Не передан import\.xml: \[url\]/u);
});

test('Tilda CommerceML stock exchange follows the required two-file order in one session', async () => {
	const requests: Array<{ mode: string; fileName: string; body: string }> = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const mode = url.searchParams.get('mode') ?? '';
		requests.push({
			mode,
			fileName: url.searchParams.get('filename') ?? '',
			body: init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : '',
		});
		if (mode === 'checkauth') return new Response('success\nPHPSESSID\nsession\n');
		if (mode === 'init') return new Response('zip=no\nfile_limit=4096\n');
		return new Response('success\n');
	};
	const client = new TildaCommerceMlClient(config, fetcher as typeof fetch);
	const session = await client.authenticateAndInitialize();
	const result = await client.uploadAndImportStock(session, '<catalog/>', '<offers/>');
	assert.deepEqual(requests.map(({ mode, fileName }) => ({ mode, fileName })), [
		{ mode: 'checkauth', fileName: '' },
		{ mode: 'init', fileName: '' },
		{ mode: 'file', fileName: 'import0_1.xml' },
		{ mode: 'file', fileName: 'offers0_1.xml' },
		{ mode: 'import', fileName: 'import0_1.xml' },
		{ mode: 'import', fileName: 'offers0_1.xml' },
	]);
	assert.equal(requests[2]?.body, '<catalog/>');
	assert.equal(requests[3]?.body, '<offers/>');
	assert.deepEqual(result, {
		catalog: { fileName: 'import0_1.xml', importResponses: ['success'] },
		offers: { fileName: 'offers0_1.xml', importResponses: ['success'] },
	});
});
