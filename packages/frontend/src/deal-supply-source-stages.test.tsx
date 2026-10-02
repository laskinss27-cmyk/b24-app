import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { withSupplySourceStages } from '@b24-app/shared';
import { DealDocumentsPanel } from './DealDocumentsPanel.js';
import { stockMovementPage } from './stock-movement-view.js';
import type { EnrichedRow } from './deal-products-table-types.js';
import type { CoreMovement } from './stock-history.js';

test('ordering the same product from different deal sections preserves their identities in the actual request', async (t) => {
	const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { __B24_CONTEXT__: { domain: 'audit.example', accessToken: 'fake' } } });
	t.after(() => { if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window'); });
	const { createDealSupplyOrderActions } = await import('./deal-supply-order-actions.js');
	let sent: Record<string, unknown> | undefined; let reloaded = false;
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
		sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({ ok: true, name: 'MR-NEW' }));
	});
	const row: EnrichedRow = { id: 'a', productId: 10, name: 'Монитор', type: 1, price: 100, quantity: 1, discountSum: 0, measure: 'шт', stocks: [], purchasingPrice: 50 };
	const noop = () => {};
	const action = createDealSupplyOrderActions({ dealId: 73, supplyGoods: [row, { ...row, id: 'b', segmentKind: 'stage', stageId: 'finish' }],
		supplyBusy: false, busy: false, hasPendingDrafts: false, supplyQty: { a: '1', b: '2' }, supplyToStore: 'Дунайский', supplyDeadline: '2099-12-31', supplyOrderNote: 'На объект', remaining: () => 1,
		onReload: async () => { reloaded = true; }, setSupplyBusy: noop, setShowSupplyOrder: noop, setSupplyQty: noop, setSupplyToStore: noop, setSupplyDeadline: noop,
		setSupplyOrderNote: noop, setSupplyFormError: noop, setSelected: noop, setNotice: noop });
	await action.doCreateSupply();
	assert.equal(reloaded, true);
	assert.deepEqual(sent?.lines, [
		{ productId: 10, itemName: 'Монитор', qty: 1, stageId: 'base' },
		{ productId: 10, itemName: 'Монитор', qty: 2, stageId: 'finish' },
	]);
});

test('deal document titles show all source stages without changing document identifiers', () => {
	const stages = [{ id: 'a', name: 'Черновой монтаж' }, { id: 'b', name: 'Чистовой <монтаж>' }];
	const title = withSupplySourceStages('MR-42 — Дунайский', stages);
	const noop = () => {};
	const html = renderToStaticMarkup(<DealDocumentsPanel contracts={[]} realizations={[]} returns={[]} transfers={[]}
		supply={[{ id: 0, title, stageId: 'CORE:Draft', source: 'core' }]} documentCount={1}
		onOpenContract={noop} onOpenRealization={noop} onOpenSupply={noop} onOpenTransfer={noop} />);
	assert.match(html, /MR-42/); assert.match(html, /Этапы заказа: Черновой монтаж, Чистовой &lt;монтаж&gt;/);
});

test('warehouse search finds a receipt by either source stage beyond the first page', () => {
	const rows: CoreMovement[] = Array.from({ length: 70 }, (_, i) => ({ name: `PR-${i}`, doctype: 'Purchase Receipt', date: '2026-10-02', submitted: true, summary: '', dealId: '73', ownerName: '' }));
	rows[65]!.sourceStages = [{ id: 'a', name: 'Черновой монтаж' }, { id: 'b', name: 'Чистовой монтаж' }];
	for (const term of ['черновой', 'чистовой']) assert.equal(stockMovementPage(rows, term, 'all', 1).rows[0]?.name, 'PR-65');
});
