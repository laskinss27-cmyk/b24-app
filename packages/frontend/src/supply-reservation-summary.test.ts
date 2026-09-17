import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReservationRequestView } from './reservation-api.js';
import {
	filterReservationRequests,
	reservationSearchText,
	reservationStatusKey,
	sortReservationRequests,
} from './supply-reservation-summary.js';

function request(input: Partial<ReservationRequestView> & Pick<ReservationRequestView, 'id' | 'status' | 'requestedAt'>): ReservationRequestView {
	return {
		requestKey: `key-${input.id}`, dealId: null, comment: null, requestedExpiresAt: '2026-09-20T12:00:00.000Z',
		approvedExpiresAt: null, requestedBy: '1', reviewedBy: null, reviewedAt: null, rejectionReason: null,
		reservationId: null, reservationStatus: null, releaseRequestId: null, releaseRequestStatus: null,
		lines: [],
		...input,
	};
}

const active = request({
	id: 'a1', status: 'approved', reservationStatus: 'active', reservationId: 'res-7', requestedAt: '2026-09-10T10:00:00.000Z',
	dealId: 15, dealTitle: 'Сделка с ИП Иванов', dealManagerName: 'Петров Пётр',
	lines: [{ id: 'l1', sourceLineKey: 'k', itemCode: '100', itemName: 'Камера Hikvision', erpWarehouseName: 'Склад УД - УД', quantity: '2.000000000', activeQuantity: '2.000000000' }],
});
const pending = request({ id: 'p1', status: 'pending', requestedAt: '2026-09-11T10:00:00.000Z' });
const expired = request({ id: 'e1', status: 'approved', reservationStatus: 'expired', requestedAt: '2026-09-01T10:00:00.000Z' });

test('reservationStatusKey prefers request status for pending and rejected', () => {
	assert.equal(reservationStatusKey(pending), 'pending');
	assert.equal(reservationStatusKey(request({ id: 'r1', status: 'rejected', requestedAt: '2026-09-01T00:00:00.000Z' })), 'rejected');
	assert.equal(reservationStatusKey(active), 'active');
	assert.equal(reservationStatusKey(expired), 'expired');
});

test('reservationSearchText covers number, products, stores, deal, manager and status', () => {
	const haystack = reservationSearchText(active);
	assert.match(haystack, /камера hikvision/);
	assert.match(haystack, /склад уд/);
	assert.match(haystack, /сделка с ип иванов/);
	assert.match(haystack, /петров пётр/);
	assert.match(haystack, /резерв/);
});

test('filterReservationRequests matches case-insensitively and tolerates extra spaces', () => {
	const list = [active, pending, expired];
	assert.deepEqual(filterReservationRequests(list, '').map((item) => item.id), ['a1', 'p1', 'e1']);
	assert.deepEqual(filterReservationRequests(list, '  КАМЕРА   hikvision').map((item) => item.id), ['a1']);
	assert.deepEqual(filterReservationRequests(list, 'ип иванов').map((item) => item.id), ['a1']);
	assert.deepEqual(filterReservationRequests(list, 'нет такого').map((item) => item.id), []);
});

test('sortReservationRequests by status orders pending first, then active, closed last', () => {
	const list = [expired, active, pending];
	assert.deepEqual(sortReservationRequests(list, 'status').map((item) => item.id), ['p1', 'a1', 'e1']);
});

test('sortReservationRequests by expires and by created', () => {
	const soon = request({ id: 's1', status: 'approved', reservationStatus: 'active', requestedAt: '2026-09-12T10:00:00.000Z', requestedExpiresAt: '2026-09-15T12:00:00.000Z' });
	const later = request({ id: 'l1', status: 'approved', reservationStatus: 'active', requestedAt: '2026-09-13T10:00:00.000Z', requestedExpiresAt: '2026-09-30T12:00:00.000Z' });
	assert.deepEqual(sortReservationRequests([later, soon], 'expires').map((item) => item.id), ['s1', 'l1']);
	assert.deepEqual(sortReservationRequests([soon, later], 'created').map((item) => item.id), ['l1', 's1']);
});
