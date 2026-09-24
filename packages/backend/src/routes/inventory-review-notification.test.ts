import assert from 'node:assert/strict';
import test from 'node:test';
import { inventoryReviewMessage } from './inventory-review-notification.js';

test('inventory review message names manager and separates unfilled positions', () => {
	const message = inventoryReviewMessage({
		inventoryId: '42',
		storeName: 'Максидом Дунайский 64',
		managerName: 'Иванов Иван',
		result: { counted: 8, total: 10, discrepancies: 3, unfilled: 2 },
		appUrl: 'https://example.test/inventory',
	});
	assert.match(message, /Инвентаризация #42/u);
	assert.match(message, /Менеджер: Иванов Иван/u);
	assert.match(message, /Не заполнено: 2 \(рассчитано как 0\)/u);
});
