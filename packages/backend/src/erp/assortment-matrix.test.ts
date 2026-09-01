import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ASSORTMENT_MATRIX_QUERY_BATCH_SIZE,
	assortmentMatrixItemCodeBatches,
	matrixRecommendation,
} from './assortment-matrix.js';

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

test('матрица разбивает большой шаблон на безопасные ERPNext-запросы', () => {
	const ids = Array.from({ length: 202 }, (_value, index) => String(index + 1));
	const batches = assortmentMatrixItemCodeBatches(ids);
	assert.deepEqual(batches.map((batch) => batch.length), [75, 75, 52]);
	assert.ok(batches.every((batch) => batch.length <= ASSORTMENT_MATRIX_QUERY_BATCH_SIZE));
	assert.deepEqual(batches.flat(), ids);
});
