import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DealWorkRow } from './DealWorkRow.js';
import { buildDealRealizationSelection } from './deal-realization-selection.js';
import type { EnrichedRow } from './deal-products-table-types.js';

Object.assign(globalThis, { React });
const row: EnrichedRow = { id: 'service', productId: 9916, name: 'Проектирование', quantity: 1, price: 154000,
	type: 7, measure: 'шт', discountSum: 0, stocks: [], purchasingPrice: null };

test('service row keeps composition editing but has no checkbox or realization quantity and status', () => {
	const html = renderToStaticMarkup(createElement(DealWorkRow, { row, edit: { price: '154000', qty: '1', disc: '0' },
		editable: true, workingMode: true, alternativeView: false, saving: false, removalBusy: false, removingThisRow: false,
		busy: false, hasPendingDrafts: false, onRemove() {}, onEdit() {}, onBlur() {} }));
	assert.match(html, /без реализации/);
	assert.match(html, /154/);
	assert.match(html, /Количество в сделке/);
	assert.doesNotMatch(html, /checkbox|qty-input|Отметить услугу|Сколько услуг|✓ реализовано/);
});

test('stale selected services cannot become a delivery while selected goods still group by warehouse', () => {
	const goods = { ...row, id: 'goods', productId: 42, type: 1 };
	const options = { selected: { service: true, goods: true }, segmentActionsBlocked: false,
		remaining: () => 1, rowStatus: () => 'ready' as const, storeOf: () => 7 };
	assert.equal(buildDealRealizationSelection({ ...options, visibleGoods: [row] }).realizeDocumentCount, 0);
	const result = buildDealRealizationSelection({ ...options, visibleGoods: [goods, row] });
	assert.deepEqual(result.readyRows.map((item) => item.productId), [42]);
	assert.equal(result.realizeGroups.get(7)?.length, 1);
});
