import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
}

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: {
		__B24_CONTEXT__: {
			dealId: null,
			domain: 'mobile.example',
			memberId: null,
			accessToken: 'planning-token',
		},
	} as Window,
});

const {
	cancelDealQuoteVariantSelection,
	collapseDealToService,
	createDealQuoteVariant,
	deleteDealQuoteVariant,
	fetchDealPlan,
	fetchDealQuoteVariants,
	fetchDealStages,
	removeDealProduct,
	removeDealStageItem,
	renameDealQuoteVariant,
	renameDealStage,
	replaceDealPlanProduct,
	selectDealQuoteVariant,
	setDealPlan,
	updateDealProduct,
	updateDealStageItem,
} = await import('./b24.js');

function captureResponses(responses: unknown[]): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({
			url: String(input),
			body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
		});
		const response = responses.shift();
		if (response === undefined) throw new Error('unexpected fetch');
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as typeof fetch;
	return requests;
}

const planItem = {
	productId: 17,
	itemName: 'Товар',
	qty: 2,
	rate: 1100,
	priceListRate: 1200,
	discountPercent: 8.33,
	delivered: 0,
};

test('deal plan reads preserve empty error fallback and write payload options', async () => {
	const requests = captureResponses([
		{ ok: false },
		{ ok: true },
		{ ok: true },
	]);

	assert.deepEqual(await fetchDealPlan(91), []);
	assert.equal(await setDealPlan(91, [planItem], 'variant-2'), 0);
	assert.equal(await collapseDealToService(91), 0);
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/deal/plan',
		'/api/deal/plan-set',
		'/api/deal/collapse-service',
	]);
	assert.deepEqual(requests[1]?.body, {
		domain: 'mobile.example', accessToken: 'planning-token', dealId: 91, items: [planItem], variantId: 'variant-2',
	});
});

test('legacy deal row edits preserve their endpoint payloads', async () => {
	const requests = captureResponses([{ ok: true }, { ok: true }]);

	await removeDealProduct(91, 501);
	await updateDealProduct(91, 501, 3, 1200, 5);
	assert.deepEqual(requests, [
		{
			url: '/api/deal/remove-product',
			body: { domain: 'mobile.example', accessToken: 'planning-token', dealId: 91, rowId: 501 },
		},
		{
			url: '/api/deal/update-product',
			body: {
				domain: 'mobile.example', accessToken: 'planning-token', dealId: 91, rowId: 501,
				quantity: 3, price: 1200, discountRate: 5,
			},
		},
	]);
});

test('plan product and stage mutations preserve totals, payloads, and list fallbacks', async () => {
	const requests = captureResponses([
		{ ok: true, total: '3300' },
		{ ok: true, total: 3200 },
		{ ok: true },
		{ ok: true },
		{ ok: false },
	]);

	assert.equal(await replaceDealPlanProduct(91, 17, { productId: 18, name: 'Новый товар' }), 3300);
	assert.equal(await updateDealStageItem(91, 'stage-1', 18, 3, 1200, 5), 3200);
	assert.equal(await removeDealStageItem(91, 'stage-1', 18), 0);
	assert.deepEqual(await renameDealStage(91, 'stage-1', 'Монтаж'), []);
	assert.deepEqual(await fetchDealStages(91), []);
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/deal/replace-plan-product',
		'/api/deal/stage-item-update',
		'/api/deal/stage-item-remove',
		'/api/deal/stage-rename',
		'/api/deal/stages',
	]);
	assert.equal(requests[0]?.body['newProductId'], 18);
	assert.equal(requests[0]?.body['newItemName'], 'Новый товар');
});

test('quote variant reads preserve disabled fallback', async () => {
	captureResponses([{ ok: false }]);
	assert.deepEqual(await fetchDealQuoteVariants(91), { enabled: false, selectedId: null, variants: [] });
});

test('all quote variant mutations share auth and preserve endpoint-specific payloads', async () => {
	const variants = { enabled: true, selectedId: 'variant-2', variants: [] };
	const requests = captureResponses(Array.from({ length: 5 }, () => ({ ok: true, variants })));

	assert.deepEqual(await createDealQuoteVariant(91, 'Вариант 2', 'variant-1'), variants);
	assert.deepEqual(await renameDealQuoteVariant(91, 'variant-2', 'Основной'), variants);
	assert.deepEqual(await deleteDealQuoteVariant(91, 'variant-3'), variants);
	assert.deepEqual(await selectDealQuoteVariant(91, 'variant-2'), variants);
	assert.deepEqual(await cancelDealQuoteVariantSelection(91), variants);
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/deal/variant-create',
		'/api/deal/variant-rename',
		'/api/deal/variant-delete',
		'/api/deal/variant-select',
		'/api/deal/variant-selection-cancel',
	]);
	assert.deepEqual(requests[0]?.body, {
		domain: 'mobile.example', accessToken: 'planning-token', dealId: 91,
		name: 'Вариант 2', sourceVariantId: 'variant-1',
	});
});
