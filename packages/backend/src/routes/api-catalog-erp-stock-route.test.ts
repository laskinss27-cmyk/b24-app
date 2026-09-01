import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDealReservationAvailability } from './api-catalog-erp-stock-route.js';

test('deal stock display subtracts other reservations but uses backend-computed own-deal availability', () => {
	const physical = new Map<number, Record<string, number>>([
		[42, { Main: 3, Reserve: 1 }],
		[43, { Main: 5 }],
	]);
	const result = applyDealReservationAvailability(physical, [{
		productId: 42,
		storeTitle: 'Main',
		physicalQuantity: 3,
		reservedByOthers: 1,
		reservedByOwnDeal: 0,
		availableForDeal: 2,
	}]);

	assert.deepEqual([...result], [
		[42, { Main: 2, Reserve: 1 }],
		[43, { Main: 5 }],
	]);
	assert.deepEqual([...physical], [
		[42, { Main: 3, Reserve: 1 }],
		[43, { Main: 5 }],
	]);
});
