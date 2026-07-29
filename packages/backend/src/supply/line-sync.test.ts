import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductReplaceAllowed, quantityFromDealChange, quantityFromSupplyChange } from './line-sync.js';

test('уменьшение сделки закрывает необработанный остаток заявки', () => {
	assert.equal(quantityFromDealChange({ requestQty: 4, dealQtyAtSync: 4, nextDealQty: 2, allocatedQty: 2 }), 2);
});

test('количество сделки нельзя уменьшить ниже распределённого', () => {
	assert.throws(
		() => quantityFromDealChange({ requestQty: 4, dealQtyAtSync: 4, nextDealQty: 1, allocatedQty: 2 }),
		/ниже уже распределённого/,
	);
});

test('полностью распределённую позицию нельзя ни уменьшить, ни увеличить', () => {
	assert.throws(
		() => quantityFromDealChange({ requestQty: 4, dealQtyAtSync: 4, nextDealQty: 5, allocatedQty: 4 }),
		/полностью распределена/,
	);
	assert.throws(
		() => quantityFromSupplyChange({ dealQty: 4, requestQty: 4, nextRequestQty: 3, allocatedQty: 4 }),
		/полностью распределена/,
	);
});

test('изменение заявки снабжением переносит ту же дельту в сделку', () => {
	assert.equal(quantityFromSupplyChange({ dealQty: 7, requestQty: 4, nextRequestQty: 2, allocatedQty: 2 }), 5);
});

test('товар меняется только до первого распределения', () => {
	assert.doesNotThrow(() => assertProductReplaceAllowed(0));
	assert.throws(() => assertProductReplaceAllowed(0.5), /уже распределён/);
});
