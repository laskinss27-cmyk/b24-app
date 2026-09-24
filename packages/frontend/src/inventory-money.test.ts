import assert from 'node:assert/strict';
import test from 'node:test';
import { inventoryMoney } from './inventory-money.js';
import type { InvResult } from './inventory-api.js';

test('inventory money sums surplus and shortages across points, including unfilled rows', () => {
	const point = (lines: InvResult['lines']): InvResult => ({
		counted: 0, total: lines.length, discrepancies: lines.length, lines,
	});
	const summary = inventoryMoney([
		point([
			{ productId: 1, name: 'Камера', book: 2, fact: 0, diff: -2, purchase: 1250.5, unfilled: true },
			{ productId: 2, name: 'Кабель', book: 1, fact: 4, diff: 3, purchase: 100 },
		]),
		point([
			{ productId: 3, name: 'Блок питания', book: 0, fact: 1, diff: 1, purchase: 52.25 },
			{ productId: 4, name: 'Неоценённый товар', book: 1, fact: 0, diff: -1 },
		]),
	]);
	assert.deepEqual(summary, {
		surplus: 352.25,
		shortage: 2501,
		net: -2148.75,
		valuedCount: 3,
		missingPrice: 1,
	});
});
