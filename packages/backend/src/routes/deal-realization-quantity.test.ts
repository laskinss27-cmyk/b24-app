import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDealRealizationQuantityAvailable } from './deal-realization-quantity.js';

test('a fully returned old sale does not enlarge a new one-unit plan line', () => {
	const plan = [{ productId: 12668, qty: 1, lineKey: 'new-line' }];
	const history = [
		{ items: [{ productId: 12668, qty: 2, segmentId: 'base' }] },
		{ items: [{ productId: 12668, qty: -1, segmentId: 'base' }] },
		{ items: [{ productId: 12668, qty: -1, segmentId: 'base' }] },
	];
	assert.doesNotThrow(() => assertDealRealizationQuantityAvailable(plan, [], history, [
		{ productId: 12668, qty: 1, segmentId: 'line:new-line' },
	]));
	assert.throws(() => assertDealRealizationQuantityAvailable(plan, [], history, [
		{ productId: 12668, qty: 2, segmentId: 'line:new-line' },
	]), /в плане осталось 1, к реализации передано 2/);
});

test('existing drafts consume the remaining realization quantity', () => {
	assert.throws(() => assertDealRealizationQuantityAvailable(
		[{ productId: 42, qty: 2, lineKey: 'line-42' }],
		[],
		[{ items: [{ productId: 42, qty: 1, segmentId: 'line:line-42' }] }],
		[{ productId: 42, qty: 2, segmentId: 'line:line-42' }],
	), /в плане осталось 1, к реализации передано 2/);
});
