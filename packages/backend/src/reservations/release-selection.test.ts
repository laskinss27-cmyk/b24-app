import assert from 'node:assert/strict';
import test from 'node:test';
import { selectReleaseLines, readReleaseSelection } from './release-selection.js';

const active = [{ id: '11', activeQuantity: '5' }, { id: '12', activeQuantity: '2.125' }];
test('partial release retains exact fractional quantities and selected line identity', () => {
	assert.deepEqual(selectReleaseLines(active, [{ lineId: '12', quantity: '0.000000001' }]), [{ lineId: '12', quantity: '0.000000001' }]);
	assert.deepEqual(selectReleaseLines(active, undefined), active.map((line) => ({ lineId: line.id, quantity: line.activeQuantity })));
});
test('invalid, empty, duplicate, foreign and stale selection never falls back to full release', () => {
	for (const value of [null, [], {}, [{ lineId: '99', quantity: '1' }], [{ lineId: '11', quantity: '1' }, { lineId: '11', quantity: '1' }]]) assert.throws(() => selectReleaseLines(active, value));
	for (const quantity of ['0', '-1', 'NaN', 'Infinity', '6', '1.0000000001', '1e0']) assert.throws(() => selectReleaseLines(active, [{ lineId: '11', quantity }]));
	assert.throws(() => selectReleaseLines([{ id: '11', activeQuantity: '1' }], [{ lineId: '11', quantity: '2' }]));
	assert.equal(readReleaseSelection(null), null);
	assert.throws(() => readReleaseSelection('[]'));
});
