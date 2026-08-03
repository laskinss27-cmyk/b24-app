import assert from 'node:assert/strict';
import test from 'node:test';
import { matrixRecommendation } from './assortment-matrix.js';

test('матрица рекомендует запас на 60 дней и вычитает свободный остаток с заказанным', () => {
	assert.equal(matrixRecommendation({ soldQty: 90, periodDays: 90, freeQty: 20, orderedQty: 10 }), 30);
});

test('матрица округляет потребность вверх', () => {
	assert.equal(matrixRecommendation({ soldQty: 7, periodDays: 30, freeQty: 3, orderedQty: 0 }), 11);
});

test('матрица не предлагает отрицательный заказ и не выдумывает спрос без продаж', () => {
	assert.equal(matrixRecommendation({ soldQty: 5, periodDays: 30, freeQty: 20, orderedQty: 4 }), 0);
	assert.equal(matrixRecommendation({ soldQty: 0, periodDays: 30, freeQty: -2, orderedQty: 0 }), 0);
});
