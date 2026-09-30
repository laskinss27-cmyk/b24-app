import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dealProductActiveSupply, dealSupplyOrderCandidates } from './deal-product-availability.js';
import type { EnrichedRow } from './deal-products-table-types.js';
import type { SupplyCard } from './deal-fulfillment.js';
import { DealGoodsStatusCell } from './DealGoodsStatusCell.js';
Object.assign(globalThis, { React });

const row = { id: 'a', productId: 101, quantity: 3, stocks: [{ storeId: 1, storeName: 'Точка', amount: 1 }] } as EnrichedRow;
const complete: SupplyCard = { id: 0, title: 'MR-1', source: 'core', stageId: 'CORE:Completed', closed: true, productIds: [101] };

test('completed requests release ordering; any remaining active request still blocks the same product', () => {
	assert.equal(dealProductActiveSupply(row, [complete]), null);
	const pending = { ...complete, closed: false, stageId: 'CORE:Draft' };
	assert.equal(dealProductActiveSupply(row, [complete, pending]), pending);
	for (const stage of ['Transferred', 'Received', 'Issued', 'Stopped']) {
		const legacy = { ...complete, stageId: `CORE:${stage}` }; delete legacy.closed;
		assert.equal(dealProductActiveSupply(row, [legacy]), null);
	}
});

test('order candidates remain available despite sufficient book stock, but not during active supply or transfer', () => {
	const qty = (r: EnrichedRow) => r.quantity;
	for (const amount of [0, 1, 3, 10]) {
		const stockedRow = { ...row, stocks: [{ storeId: 1, storeName: 'Точка', amount }] };
		assert.deepEqual(dealSupplyOrderCandidates([stockedRow], [complete], qty, []), [stockedRow]);
	}
	assert.deepEqual(dealSupplyOrderCandidates([row], [], qty, []), [row]);
	assert.deepEqual(dealSupplyOrderCandidates([row], [complete, { ...complete, closed: false }], qty, []), []);
	assert.deepEqual(dealSupplyOrderCandidates([row], [complete], () => 0, []), []);
	assert.deepEqual(dealSupplyOrderCandidates([{ ...row, manual: true }], [complete], qty, []), []);
	assert.deepEqual(dealSupplyOrderCandidates([row], [complete], qty, [{ id: 1, status: 'in_transit', lines: [{ productId: 101, qty: 3 }] } as never]), []);
	assert.deepEqual(dealSupplyOrderCandidates([row, { ...row, id: 'b' }], [complete], qty, []).map((r) => r.id), ['a', 'b']);
});

test('a historical received transfer cannot display current shortage as ready', () => {
	const html = renderToStaticMarkup(createElement(DealGoodsStatusCell, { workingMode: true, alternativeView: false,
		stores: [], selectedStoreId: 1, storeAmount: () => 0, selectionDisabled: false,
		activeTransfer: null, activeTransferLabel: null, receivedTransfer: true, status: 'order', activeSupply: null,
		refreshing: false, busy: false, onStoreChange() {}, onRefresh() {} }));
	assert.match(html, /нужен заказ/);
	assert.doesNotMatch(html, /✓ принято|st-badge ready/);
});
