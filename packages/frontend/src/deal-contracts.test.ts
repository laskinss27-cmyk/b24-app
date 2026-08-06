import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown> }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { dealId: null, domain: 'contracts.example', memberId: null, accessToken: 'contracts-token' } } as Window,
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
Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:contract' });
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });

const {
	createDealContract,
	downloadStoredDealContract,
	fetchDealContractContext,
	fetchDealContractFile,
	fetchDealContracts,
} = await import('./b24.js');

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

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

const documentRow = {
	id: 'contract-1',
	dealId: 501,
	contractNumber: '501/26',
	templateId: 'supply' as const,
	templateTitle: 'Supply',
	companyId: 7,
	companyName: 'Our Company',
	customerName: 'Customer',
	contractDate: '06.08.2026',
	contractDateIso: '2026-08-06',
	createdAt: '2026-08-06T12:00:00Z',
	filename: 'contract.docx',
	vatRate: 5 as const,
	total: 1500,
};

test('contract context and list preserve endpoints and deal authentication', async () => {
	const context = { dealId: 501 };
	const requests = captureResponses([
		jsonResponse({ ok: true, context }),
		jsonResponse({ ok: true, documents: [documentRow] }),
	]);

	assert.deepEqual(await fetchDealContractContext(501), context);
	assert.deepEqual(await fetchDealContracts(501), [documentRow]);
	assert.deepEqual(requests, [
		{ url: '/api/contracts/context', body: { domain: 'contracts.example', accessToken: 'contracts-token', dealId: 501 } },
		{ url: '/api/contracts/list', body: { domain: 'contracts.example', accessToken: 'contracts-token', dealId: 501 } },
	]);
});

test('contract generation preserves complete input payload and document response', async () => {
	const input = {
		dealId: 501,
		companyId: 7,
		templateId: 'supply' as const,
		customerKind: 'company' as const,
		contractDate: '2026-08-06',
		objectAddress: 'Moscow',
		objectName: 'Apartment',
		workDuration: 15,
		workDurationUnit: 'working' as const,
	};
	const requests = captureResponses([jsonResponse({ ok: true, document: documentRow })]);

	assert.deepEqual(await createDealContract(input), documentRow);
	assert.deepEqual(requests[0], {
		url: '/api/contracts/generate',
		body: { domain: 'contracts.example', accessToken: 'contracts-token', ...input },
	});
});

test('contract file reading and download preserve binary endpoint and stored filename', async () => {
	clickedDownloads.length = 0;
	const contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
	const requests = captureResponses([
		new Response('first', { status: 200, headers: { 'Content-Type': contentType } }),
		new Response('second', { status: 200, headers: { 'Content-Type': contentType } }),
	]);

	assert.equal((await fetchDealContractFile(501, 'contract-1')).size, 5);
	await downloadStoredDealContract(documentRow);
	assert.deepEqual(requests.map((item) => item.body), [
		{ domain: 'contracts.example', accessToken: 'contracts-token', dealId: 501, documentId: 'contract-1' },
		{ domain: 'contracts.example', accessToken: 'contracts-token', dealId: 501, documentId: 'contract-1' },
	]);
	assert.deepEqual(clickedDownloads, ['contract.docx']);
});
