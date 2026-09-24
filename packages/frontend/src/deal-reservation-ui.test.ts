import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultReservationQuantities, parseReservationQuantities } from './deal-reservation-ui.js';

const lines = [{ id: 'line-1', quantity: 3, maxQuantity: 3, availableQuantity: 2 }];

test('reservation dialog defaults to currently available quantity and accepts a partial reserve', () => {
	assert.deepEqual(defaultReservationQuantities(lines), { 'line-1': '2' });
	assert.deepEqual(parseReservationQuantities(lines, { 'line-1': '1.5' }), {
		quantities: { 'line-1': 1.5 }, error: null,
	});
	assert.equal(parseReservationQuantities(lines, { 'line-1': '3' }).error, 'Нельзя зарезервировать больше 2');
	assert.equal(parseReservationQuantities(lines, { 'line-1': '0' }).error, 'Укажите количество хотя бы для одной позиции');
});
