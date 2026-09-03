import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDealSupplySelection } from './deal-supply-selection.js';
import type { EnrichedRow } from './deal-products-table-types.js';

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
			accessToken: 'deal-token',
		},
	} as Window,
});

const { addProductsToDeal, createQuickSale, searchDealProducts } = await import('./b24.js');
const { createDealSupplyOrderActions } = await import('./deal-supply-order-actions.js');

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

test('createQuickSale preserves auth, item data, assignee, and selected store', async () => {
	const requests = captureResponses([{ ok: true, dealId: 42 }]);
	const items = [{ productId: 17, name: 'Товар', price: 1200, quantity: 2, discountPercent: 5 }];

	assert.equal(await createQuickSale(items, { assignedById: '1858', storeId: 7 }), 42);
	assert.deepEqual(requests, [{
		url: '/api/quicksale/create',
		body: {
			domain: 'mobile.example',
			accessToken: 'deal-token',
			items,
			assignedById: '1858',
			storeId: 7,
		},
	}]);
});

test('searchDealProducts skips short queries and rejects backend errors', async () => {
	const requests = captureResponses([{ ok: false, error: 'catalog unavailable', products: [{ id: 17, name: 'Товар', price: 1200 }] }]);

	assert.deepEqual(await searchDealProducts(' x '), []);
	assert.equal(requests.length, 0);
	await assert.rejects(searchDealProducts('товар'), /catalog unavailable/);
	assert.deepEqual(requests[0], {
		url: '/api/deal/search-products',
		body: { domain: 'mobile.example', accessToken: 'deal-token', q: 'товар' },
	});
});

test('addProductsToDeal preserves stage options and the current zero fallback', async () => {
	const requests = captureResponses([{ ok: true }]);
	const items = [{ productId: 17, quantity: 2, price: 1200, name: 'Товар', isService: false }];

	assert.equal(await addProductsToDeal(91, items, {
		stage: true,
		stageId: 'stage-1',
		stageName: 'Первый этап',
		variantId: 'variant-2',
	}), 0);
	assert.deepEqual(requests[0], {
		url: '/api/deal/add-products',
		body: {
			domain: 'mobile.example',
			accessToken: 'deal-token',
			dealId: 91,
			items,
			stage: true,
			stageId: 'stage-1',
			stageName: 'Первый этап',
			variantId: 'variant-2',
		},
	});
});

function supplyRow(id: string, productId: number, quantity: number): EnrichedRow {
	return {
		id,
		productId,
		name: `Товар ${productId}`,
		type: 1,
		price: 1,
		quantity,
		discountSum: 0,
		measure: 'шт',
		stocks: [],
		purchasingPrice: null,
	};
}

test('supply selection orders only the deal quantity not covered by active requests', () => {
	const base = supplyRow('base-18060', 18060, 3200);
	const added = supplyRow('stage-equipment-18060', 18060, 1300);
	const result = buildDealSupplySelection({
		rows: [base, added],
		supply: [{
			id: 0,
			title: 'MAT-MR-2026-00041',
			stageId: 'CORE:Pending',
			source: 'core',
			productIds: [18060],
			items: [{ productId: 18060, itemName: 'Труба', qty: 3200, note: '' }],
		}],
		isSelected: (row) => row.id === added.id,
		remaining: (row) => row.quantity,
	});

	assert.deepEqual(result.rows.map((row) => row.id), [added.id]);
	assert.equal(result.availableByRow.get(added.id), 1300);
});

test('supply selection ignores stopped requests and never duplicates an uncovered product quantity', () => {
	const first = supplyRow('first', 77, 3);
	const second = supplyRow('second', 77, 4);
	const result = buildDealSupplySelection({
		rows: [first, second],
		supply: [
			{ id: 0, title: 'active', stageId: 'CORE:Pending', source: 'core', productIds: [77], items: [{ productId: 77, itemName: 'Товар', qty: 5, note: '' }] },
			{ id: 0, title: 'stopped', stageId: 'CORE:Stopped', source: 'core', productIds: [77], items: [{ productId: 77, itemName: 'Товар', qty: 100, note: '' }] },
		],
		isSelected: () => true,
		remaining: (row) => row.quantity,
	});

	assert.deepEqual(result.rows.map((row) => row.id), [first.id]);
	assert.equal(result.availableByRow.get(first.id), 2);
	assert.equal(result.availableByRow.has(second.id), false);
});

function supplyOrderActions(overrides: { deadline?: string; onReload?: () => Promise<void>; onNotice?: (notice: { kind: 'ok' | 'err'; text: string } | null) => void } = {}) {
	const row = supplyRow('row-17', 17, 1);
	let formError: string | null = null;
	const actions = createDealSupplyOrderActions({
		dealId: 91,
		supplyGoods: [row],
		supplyBusy: false,
		busy: false,
		hasPendingDrafts: false,
		supplyNotes: {},
		supplyQty: { [row.id]: '1' },
		supplyToStore: 'Основной склад',
		supplyDeadline: overrides.deadline ?? '',
		supplyOrderNote: '',
		remaining: () => 1,
		onReload: overrides.onReload ?? (async () => {}),
		setSupplyBusy: () => {},
		setShowSupplyOrder: () => {},
		setSupplyNotes: () => {},
		setSupplyQty: () => {},
		setSupplyToStore: () => {},
		setSupplyDeadline: () => {},
		setSupplyOrderNote: () => {},
		setSupplyFormError: (value) => { formError = value; },
		setSelected: () => {},
		setNotice: overrides.onNotice ?? (() => {}),
	});
	return { actions, formError: () => formError };
}

test('supply order submit explains a missing deadline instead of silently doing nothing', async () => {
	globalThis.fetch = (async () => { throw new Error('request must not be sent'); }) as typeof fetch;
	const scenario = supplyOrderActions();

	await scenario.actions.doCreateSupply();

	assert.equal(scenario.formError(), 'Укажите крайнюю дату поставки.');
});

test('supply order success names the document confirmed by the server', async () => {
	const requests = captureResponses([{ ok: true, name: 'MAT-MR-2026-00104' }]);
	const notices: Array<{ kind: 'ok' | 'err'; text: string } | null> = [];
	let reloads = 0;
	const scenario = supplyOrderActions({
		deadline: '2099-09-04',
		onReload: async () => { reloads += 1; },
		onNotice: (value) => { notices.push(value); },
	});

	await scenario.actions.doCreateSupply();

	assert.equal(reloads, 1);
	assert.match(notices.at(-1)?.text ?? '', /MAT-MR-2026-00104/);
	assert.equal(requests[0]?.url, '/api/supply/request');
});
