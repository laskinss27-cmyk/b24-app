import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReserveDate, publicReservation, reservationStatus, trackedFromSnapshot } from './model.js';

const base = trackedFromSnapshot({
	key: '42:7:10', dealId: 42, dealTitle: 'Монтаж', managerName: 'Иванов Иван', rowId: '7', reserveId: '10',
	productId: 100, productName: 'Камера', storeId: 8, storeName: 'Максидом Дунайский 64', quantity: 2, endDate: '2026-09-22',
}, '2026-09-20T10:00:00.000Z');

test('normalizeReserveDate accepts Bitrix and ISO reservation dates', () => {
	assert.equal(normalizeReserveDate('22.09.2026'), '2026-09-22');
	assert.equal(normalizeReserveDate('2026-09-22T00:00:00+03:00'), '2026-09-22');
	assert.equal(normalizeReserveDate(''), '');
});

test('reservation becomes urgent on end date and expires the next day', () => {
	assert.equal(reservationStatus(base, '2026-09-21'), 'active');
	assert.equal(reservationStatus(base, '2026-09-22'), 'ending_today');
	assert.equal(reservationStatus(base, '2026-09-23'), 'expired');
});

test('reservation released before deadline does not become expired', () => {
	const released = { ...base, endedAt: '2026-09-21T12:00:00.000Z' };
	assert.equal(reservationStatus(released, '2026-09-23'), 'released');
});

test('public reservation exposes notification delivery states', () => {
	assert.equal(publicReservation(base, '2026-09-21').requestNotification, 'pending');
	assert.equal(publicReservation({ ...base, requestNotifiedAt: '2026-09-20T11:00:00.000Z' }, '2026-09-21').requestNotification, 'sent');
	assert.equal(publicReservation({ ...base, requestNotificationError: 'Для склада не настроен чат' }, '2026-09-21').requestNotification, 'not_configured');
});
