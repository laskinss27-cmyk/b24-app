import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DealGoodsRow } from './DealGoodsRow.js';
import { DealManualProductForm } from './DealManualProductForm.js';
import { buildDealRealizationSelection } from './deal-realization-selection.js';
import { createDealProductRowEditActions } from './deal-product-row-edit-actions.js';
import { DEAL_PRODUCTS_MOCK_DATA } from './deal-products-mock-data.js';
import type { EnrichedRow } from './deal-products-table-types.js';

Object.assign(globalThis, { React });
const row: EnrichedRow = { id: 'plan-manual:1', planLineKey: 'manual:1', productId: -1, manual: true, name: 'Кабель', type: 1, quantity: 2.5, price: 90, discountSum: 10, measure: 'м', stocks: [], purchasingPrice: null };

test('manual row exposes editable name and unit but no stock selection or shipment input', () => {
	const html = renderToStaticMarkup(<table><tbody><DealGoodsRow row={row} edit={{ qty: '2.5', price: '100', disc: '10', name: 'Кабель', unit: 'м' }} left={2.5} shipped={0} status="order" selected={false} editable workingMode hasParts={false} orderedTitle={null} saving={false} controlsDisabled={false} selectionDisabled={false} batchDisabled={false} removingThisRow={false} batchQuantity="2.5" stockExpanded={false} totalStock={0} statusCell={<td>Только для КП</td>} onRemove={() => {}} onReplace={() => {}} onToggleSelected={() => {}} onEdit={() => {}} onBlur={() => {}} onBatchQuantity={() => {}} onToggleStocks={() => {}} /></tbody></table>);
	assert.match(html, /Название ручного товара/);
	assert.match(html, /Единица измерения/);
	assert.match(html, /Вручную/);
	assert.doesNotMatch(html, /type="checkbox"|Сколько отгрузить|stock-toggle/);
});

test('manual rows are excluded even if stale selection and stock data mark them ready', () => {
	const result = buildDealRealizationSelection({ visibleGoods: [row], selected: { [row.id]: true }, segmentActionsBlocked: false, remaining: () => 2.5, rowStatus: () => 'ready', storeOf: () => 1 });
	assert.equal(result.realizeDocumentCount, 0);
	assert.deepEqual(result.readyRows, []);
});

test('manual form has the agreed five fields', () => {
	const html = renderToStaticMarkup(<DealManualProductForm dealId={1} onCancel={() => {}} onAdded={async () => {}} />);
	for (const label of ['Название', 'Количество', 'Единица', 'Цена, ₽', 'Скидка, %']) assert.ok(html.includes(label));
});

test('editing only name and unit saves one manual row without affecting another', async (t) => {
	Object.assign(globalThis, { window: { __B24_CONTEXT__: { dealId: 1, domain: 'test', memberId: null, accessToken: 'test-token' } } });
	let sent: Record<string, unknown> = {};
	t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
		sent = JSON.parse(String(options.body)) as Record<string, unknown>;
		return new Response(JSON.stringify({ ok: true, total: 225 }));
	});
	const first = { productId: -1, manual: true, lineKey: 'manual:1', itemName: 'Кабель', unit: 'м', qty: 2.5, priceListRate: 100, discountPercent: 10, rate: 90, delivered: 0 };
	const second = { ...first, productId: -2, lineKey: 'manual:2' };
	let notice: unknown;
	const actions = createDealProductRowEditActions({ dealId: 1, data: { ...DEAL_PRODUCTS_MOCK_DATA, stages: [], plan: [first, second] }, proposalEditable: false, activeVariantId: null, rowEdits: { [row.id]: { qty: '2.5', price: '100', disc: '10', name: 'Другой кабель', unit: 'бухта' } }, savingRow: null, onReload: async () => {}, setRowEdits: () => {}, setSavingRow: () => {}, setNotice: (value) => { notice = value; } });
	Object.assign(globalThis, { Node: class {} });
	actions.onRowBlur(row, { currentTarget: { closest: () => null }, relatedTarget: null } as unknown as React.FocusEvent<HTMLInputElement>);
	await new Promise((resolve) => setImmediate(resolve));
	const items = sent.items as typeof first[];
	assert.equal(items[0]!.itemName, 'Другой кабель');
	assert.equal(items[0]!.unit, 'бухта');
	assert.equal(items[0]!.manual, true);
	assert.deepEqual(items[1], second);
	assert.equal(notice, null);
});
