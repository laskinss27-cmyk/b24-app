import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown> }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: {
		__B24_CONTEXT__: { dealId: null, domain: 'mobile.example', memberId: null, accessToken: 'analytics-token' },
	} as Window,
});

const {
	deleteAssortmentMatrixTemplate,
	downloadTurnoverReportXlsx,
	fetchAssortmentMatrix,
	fetchAssortmentMatrixTemplates,
	fetchTurnoverReport,
	saveAssortmentMatrixItem,
	saveAssortmentMatrixTemplate,
} = await import('./b24.js');

function captureResponses(responses: Array<unknown | Response>): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
		const value = responses.shift();
		if (value === undefined) throw new Error('unexpected fetch');
		return value instanceof Response
			? value
			: new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	return requests;
}

test('assortment matrix preserves request filters and response fallbacks', async () => {
	const requests = captureResponses([{ ok: true, periodDays: '31' }]);
	const input = { from: '2026-08-01', to: '2026-08-31', selectedStores: ['Основной'], salesScope: 'selected' as const };

	assert.deepEqual(await fetchAssortmentMatrix(input), {
		rows: [], stores: [], selectedStores: ['Основной'], categories: [], salesScope: 'selected',
		periodDays: 31, targetDays: 60, generatedAt: '',
	});
	assert.deepEqual(requests[0], {
		url: '/api/stock/assortment-matrix',
		body: { domain: 'mobile.example', accessToken: 'analytics-token', ...input },
	});
});

test('matrix saving and turnover reads preserve payloads and numeric fallbacks', async () => {
	const requests = captureResponses([{ ok: true }, { ok: true, days: '30' }]);
	const row = { productId: 17, enabled: true, category: 'A', segment: 'Хит', toOrderQty: 5, comment: 'Заказать' };

	await saveAssortmentMatrixItem(row);
	assert.deepEqual(await fetchTurnoverReport('2026-08-01', '2026-08-31', 'Основной'), {
		rows: [], generatedAt: '', days: 30,
	});
	assert.deepEqual(requests, [
		{
			url: '/api/stock/assortment-matrix/save',
			body: { domain: 'mobile.example', accessToken: 'analytics-token', ...row },
		},
		{
			url: '/api/stock/turnover-report',
			body: {
				domain: 'mobile.example', accessToken: 'analytics-token',
				from: '2026-08-01', to: '2026-08-31', store: 'Основной',
			},
		},
	]);
});

test('shared matrix template API preserves the editable definition', async () => {
	const template = {
		id: '0f0a5026-e702-43da-85c7-d561ccbf9f99', name: 'Домофоны', from: '2026-08-01', to: '2026-08-14',
		selectedStores: ['Основной'], salesScope: 'selected' as const,
		rows: [{ productId: 17, category: 'Домофоны', segment: 'IP', toOrderQty: 5, comment: 'Заказать' }],
		createdAt: '2026-08-14T10:00:00.000Z', createdBy: { id: '1', name: 'Автор' },
		updatedAt: '2026-08-14T10:00:00.000Z', updatedBy: { id: '1', name: 'Автор' },
	};
	const requests = captureResponses([{ ok: true, templates: [template] }, { ok: true, template }, { ok: true }]);

	assert.deepEqual(await fetchAssortmentMatrixTemplates(), [template]);
	assert.deepEqual(await saveAssortmentMatrixTemplate({
		name: template.name, from: template.from, to: template.to, selectedStores: template.selectedStores,
		salesScope: template.salesScope, rows: template.rows,
	}), template);
	await deleteAssortmentMatrixTemplate(template.id, template.name);
	assert.deepEqual(requests.map((request) => request.url), [
		'/api/stock/assortment-matrix/templates',
		'/api/stock/assortment-matrix/templates/save',
		'/api/stock/assortment-matrix/templates/delete',
	]);
	assert.deepEqual(requests[1]?.body['rows'], template.rows);
	assert.equal(requests[2]?.body['id'], template.id);
});

test('turnover Excel download preserves filename and object URL cleanup', async () => {
	const requests = captureResponses([new Response(new Blob(['xlsx']), {
		status: 200,
		headers: {
			'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'Content-Disposition': 'attachment; filename="turnover-custom.xlsx"',
		},
	})]);
	const link = { href: '', download: '', clicked: false, removed: false, click(): void { this.clicked = true; }, remove(): void { this.removed = true; } };
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: { createElement: () => link, body: { appendChild(): void {} } },
	});
	const revoked: string[] = [];
	Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:turnover' });
	Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => revoked.push(url) });
	const input = { from: '2026-08-01', to: '2026-08-31', showAverageCost: true, showStockValue: false };

	await downloadTurnoverReportXlsx(input);
	assert.deepEqual({ href: link.href, download: link.download, clicked: link.clicked, removed: link.removed }, {
		href: 'blob:turnover', download: 'turnover-custom.xlsx', clicked: true, removed: true,
	});
	assert.deepEqual(revoked, ['blob:turnover']);
	assert.deepEqual(requests[0], {
		url: '/api/stock/turnover-report.xlsx',
		body: { domain: 'mobile.example', accessToken: 'analytics-token', ...input },
	});
});
