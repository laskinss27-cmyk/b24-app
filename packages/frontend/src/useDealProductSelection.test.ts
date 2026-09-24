import assert from 'node:assert/strict';
import test from 'node:test';
import { selectionForRows } from './useDealProductSelection.js';

test('select all affects visible actionable rows without changing hidden selections', () => {
	const selected = { hidden: true, first: false, second: true };
	assert.deepEqual(selectionForRows(selected, ['first', 'second'], true), { hidden: true, first: true, second: true });
	assert.deepEqual(selectionForRows(selected, ['first', 'second'], false), { hidden: true, first: false, second: false });
	assert.equal(selected.first, false);
});
