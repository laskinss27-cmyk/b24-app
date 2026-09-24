import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoreRealization } from './core-realizations.js';
import type { EnrichedRow } from './deal-products-table-types.js';
import { dealProductRemainingQuantity, dealProductShippedQuantity } from './deal-product-fulfillment-values.js';
import { dealProductRealizationParts } from './deal-product-realization-parts.js';

const row = {
	id: 'base-line-1', productId: 21506, name: 'Товар', type: 1,
	price: 100, quantity: 10, discountSum: 0, measure: 'шт',
	stocks: [], purchasingPrice: null, planLineKey: 'line-1', segmentKind: 'base',
	legacyBaseFallback: true,
} as EnrichedRow;
const realizations = [{
	name: 'MAT-DN-2026-00972', submitted: true, isReturn: false, returnAgainst: '',
	postingDate: '2026-09-23', grandTotal: 1000,
	items: [{ productId: 21506, itemName: 'Товар', qty: 10, segmentId: 'base', rate: 100, storeTitle: 'Склад' }],
}] as CoreRealization[];

test('a unique keyed plan line recognizes its earlier base realization', () => {
	assert.equal(dealProductRemainingQuantity(row, realizations), 0);
	assert.equal(dealProductShippedQuantity(row, realizations), 10);
	assert.equal(dealProductRealizationParts(row, realizations).length, 1);
});

test('legacy base fallback never duplicates a sale across repeated or staged lines', () => {
	assert.equal(dealProductShippedQuantity({ ...row, legacyBaseFallback: false }, realizations), 0);
	assert.equal(dealProductShippedQuantity({ ...row, segmentKind: 'stage', stageId: 'stage-1' }, realizations), 0);
});
