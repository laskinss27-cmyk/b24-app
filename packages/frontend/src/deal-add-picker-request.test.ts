import assert from 'node:assert/strict';
import test from 'node:test';
import { dealAddPickerRequest } from './deal-add-picker-request.js';
import type { TableData } from './deal-products-table-types.js';

const data = (submitted: boolean, isReturn = false, stageCount = 0): TableData => ({
	coreReals: submitted ? [{ submitted: true, isReturn, items: [{ qty: 1 }] }] : [],
	stages: Array.from({ length: stageCount }, () => ({})),
} as unknown as TableData);

test('adding to a partially realized deal opens a new stage, preserving the posted sale', () => {
	assert.deepEqual(dealAddPickerRequest(data(true, false, 2), null, false), { kind: 'new-stage', stageName: 'Этап 3' });
	assert.deepEqual(dealAddPickerRequest(data(false), null, false), { kind: 'deal' });
	assert.deepEqual(dealAddPickerRequest(data(true, true), null, false), { kind: 'deal' });
	assert.deepEqual(dealAddPickerRequest(data(true), { id: 'v1', name: 'Вариант' } as TableData['quoteVariants']['variants'][number], false), { kind: 'variant', variantId: 'v1', variantName: 'Вариант' });
});
