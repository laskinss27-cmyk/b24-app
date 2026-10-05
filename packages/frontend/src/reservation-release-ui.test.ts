import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReleaseQuantities, releaseSelectionDescription } from './reservation-release-ui.js';
import type { ReservationLineView, ReservationRequestView } from './reservation-api.js';

const lines: ReservationLineView[] = [
	{ id: '100', reservationLineId: '11', sourceLineKey: 'a', itemCode: '7', itemName: 'Камера', erpWarehouseName: 'Склад А', quantity: '5', activeQuantity: '5' },
	{ id: '101', reservationLineId: '12', sourceLineKey: 'a', itemCode: '7', itemName: 'Камера', erpWarehouseName: 'Склад Б', quantity: '3', activeQuantity: '3' },
];
test('release form selects explicit line IDs, leaves blank and zero in reserve and accepts decimal comma', () => {
	assert.deepEqual(parseReleaseQuantities(lines, {}), { selected: [], error: null });
	assert.deepEqual(parseReleaseQuantities(lines, { '11': '0', '12': '1,25' }), { selected: [{ lineId: '12', quantity: '1.25' }], error: null });
	assert.match(releaseSelectionDescription({ lines } as ReservationRequestView, [{ lineId: '12', quantity: '1.25' }]), /Склад Б.*1.25/);
});
test('release form rejects invalid quantities and over-release even at ninth decimal', () => {
	for (const raw of ['-1', '6', '5.000000001', '1e0', 'NaN', '1.0000000001']) assert.ok(parseReleaseQuantities(lines, { '11': raw }).error);
	assert.deepEqual(parseReleaseQuantities(lines, { '11': '0.000000001' }).selected, [{ lineId: '11', quantity: '0.000000001' }]);
});
