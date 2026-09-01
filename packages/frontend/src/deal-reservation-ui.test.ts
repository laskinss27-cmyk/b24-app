import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnrichedRow } from './deal-products-table-types.js';
import type { ReservationRequestView } from './reservation-api.js';
import { dealRowReservationMark, defaultReservationQuantities, parseReservationQuantities } from './deal-reservation-ui.js';

const lines = [{ id: 'line-1', quantity: 3, maxQuantity: 3, availableQuantity: 2 }];

test('reservation dialog defaults to currently available quantity and accepts a partial reserve', () => {
	assert.deepEqual(defaultReservationQuantities(lines), { 'line-1': '2' });
	assert.deepEqual(parseReservationQuantities(lines, { 'line-1': '1.5' }), {
		quantities: { 'line-1': 1.5 }, error: null,
	});
	assert.equal(parseReservationQuantities(lines, { 'line-1': '3' }).error, 'Нельзя зарезервировать больше 2');
	assert.equal(parseReservationQuantities(lines, { 'line-1': '0' }).error, 'Укажите количество хотя бы для одной позиции');
});

test('deal row marker follows the exact plan line and approved expiry', () => {
	const row = { id: 'plan-42', planLineKey: 'plan-line-42', productId: 42 } as EnrichedRow;
	const request = {
		status: 'approved', reservationStatus: 'active', requestedExpiresAt: '2026-09-08T12:00:00.000Z',
		approvedExpiresAt: '2026-09-07T12:00:00.000Z',
		lines: [{ sourceLineKey: 'plan-line-42', itemCode: '42', quantity: '2', activeQuantity: '2' }],
	} as ReservationRequestView;
	assert.deepEqual(dealRowReservationMark(request, row), {
		state: 'active', quantity: 2, expiresAt: '2026-09-07T12:00:00.000Z',
	});
	assert.deepEqual(dealRowReservationMark({ ...request, status: 'pending' }, row), {
		state: 'pending', quantity: 2, expiresAt: '2026-09-08T12:00:00.000Z',
	});
});
