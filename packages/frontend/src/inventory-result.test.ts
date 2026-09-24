import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInventoryResult } from './inventory-result.js';

test('unfilled inventory positions are separate shortages calculated as zero', () => {
	const result = buildInventoryResult([
		{ productId: 1, name: 'Камера', book: 3, purchase: 1200 },
		{ productId: 2, name: 'Кабель', book: 5, purchase: 50 },
		{ productId: 3, name: 'Блок питания', book: 0, purchase: 900 },
	], { 2: '7', 3: '' }, {});

	assert.equal(result.counted, 1);
	assert.equal(result.unfilled, 2);
	assert.equal(result.discrepancies, 2);
	assert.deepEqual(result.lines, [
		{ productId: 1, name: 'Камера', book: 3, fact: 0, diff: -3, purchase: 1200, unfilled: true },
		{ productId: 2, name: 'Кабель', book: 5, fact: 7, diff: 2, purchase: 50 },
	]);
});
