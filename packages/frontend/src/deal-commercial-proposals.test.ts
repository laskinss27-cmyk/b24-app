import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown> }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { dealId: null, domain: 'kp.example', memberId: null, accessToken: 'kp-token' } } as Window,
});

const clickedDownloads: string[] = [];
Object.defineProperty(globalThis, 'document', {
	configurable: true,
	value: {
		body: { appendChild() {} },
		createElement: () => ({
			href: '',
			download: '',
			click() { clickedDownloads.push(this.download); },
			remove() {},
		}),
	},
});
Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:proposal' });
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });

const { downloadDealKpDocx, downloadDealXlsx, fetchDealKp } = await import('./b24.js');

function kpData() {
	return {
		number: 501,
		date: '2026-08-06',
		title: 'Proposal',
		client: { name: 'Client', phone: '+70000000000' },
		manager: { name: 'Manager', phone: '+71111111111' },
		goods: [],
		works: [],
		sumGoods: 0,
		sumWorks: 0,
		total: 0,
	};
}

function captureResponses(responses: Response[]): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
		const value = responses.shift();
		if (!value) throw new Error('unexpected fetch');
		return value;
	}) as typeof fetch;
	return requests;
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('deal proposal loading preserves optional variant payload', async () => {
	const kp = kpData();
	const requests = captureResponses([jsonResponse({ ok: true, kp })]);

	assert.deepEqual(await fetchDealKp(501, 'variant-a'), kp);
	assert.deepEqual(requests[0], {
		url: '/api/deal/kp',
		body: { domain: 'kp.example', accessToken: 'kp-token', dealId: 501, variantId: 'variant-a' },
	});
});

test('Word proposal download preserves generated data, filename, and endpoint order', async () => {
	clickedDownloads.length = 0;
	const kp = kpData();
	const requests = captureResponses([
		jsonResponse({ ok: true, kp }),
		new Response('docx', {
			status: 200,
			headers: {
				'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				'Content-Disposition': 'attachment; filename="offer.docx"',
			},
		}),
	]);

	await downloadDealKpDocx(501);
	assert.deepEqual(requests.map((item) => item.url), ['/api/deal/kp', '/api/deal/kp-docx']);
	assert.deepEqual(requests[1]!.body, { domain: 'kp.example', accessToken: 'kp-token', dealId: 501, kp });
	assert.deepEqual(clickedDownloads, ['offer.docx']);
});

test('Excel proposal download preserves variant loading and fallback filename', async () => {
	clickedDownloads.length = 0;
	const kp = kpData();
	const requests = captureResponses([
		jsonResponse({ ok: true, kp }),
		new Response('xlsx', {
			status: 200,
			headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
		}),
	]);

	await downloadDealXlsx(501, 'variant-b');
	assert.deepEqual(requests[0]!.body, {
		domain: 'kp.example',
		accessToken: 'kp-token',
		dealId: 501,
		variantId: 'variant-b',
	});
	assert.equal(requests[1]!.url, '/api/deal/kp-xlsx');
	assert.deepEqual(clickedDownloads, ['kp-501.xlsx']);
});
