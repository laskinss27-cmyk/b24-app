import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionPlanFitsCurrentRequest } from './supply-decision-planning.js';
import type { SupplyDecisionLine, SupplyOrderRow } from './supply-api.js';

const request = (items: Array<{ productId: number; qty: number }>): SupplyOrderRow => ({
	name: 'MR-1', requestKey: 'MR-1@creation', dealId: '42', dealTitle: '',
	date: '', deadline: '', status: 'Draft', closed: false, toStore: 'Main', note: '',
	items: items.map((item) => ({ ...item, itemName: `Product ${item.productId}`, note: '', stocks: {} })),
});

const purchase = (productId: number, qty: number): SupplyDecisionLine => ({
	productId, itemName: `Product ${productId}`, qty, action: 'purchase', supplier: 'Vendor',
});

test('a reviewed supply plan is rejected when another user has already distributed a line', () => {
	const previous = request([{ productId: 101, qty: 7 }, { productId: 202, qty: 2 }]);
	const current = request([{ productId: 202, qty: 2 }]);
	assert.equal(decisionPlanFitsCurrentRequest(previous, current, [purchase(101, 7), purchase(202, 2)]), false);
	assert.equal(decisionPlanFitsCurrentRequest(previous, current, [purchase(202, 2)]), true);
});

test('a reviewed supply plan is rejected when combined decisions exceed the current remainder', () => {
	const previous = request([{ productId: 101, qty: 4 }]);
	const current = request([{ productId: 101, qty: 3 }]);
	assert.equal(decisionPlanFitsCurrentRequest(previous, current, [purchase(101, 2), purchase(101, 2)]), false);
	assert.equal(decisionPlanFitsCurrentRequest(previous, current, [purchase(101, 2)]), true);
});
