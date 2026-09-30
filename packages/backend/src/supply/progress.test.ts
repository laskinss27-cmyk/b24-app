import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateRequestProgress, coverageBeyondBaseline, directReceiptFulfillment } from './progress.js';

test('delivery and cancellation quantities cover duplicate product rows only once', () => {
	const items = [{ productId: 101, qty: 2, row: 'first' }, { productId: 101, qty: 2, row: 'second' }];
	const partial = calculateRequestProgress(items, new Map([[101, 4]]), new Map([[101, 2]]), new Map());
	assert.equal(partial.closed, false);
	assert.deepEqual(partial.remaining, []);
	assert.deepEqual(partial.unfulfilled, [{ productId: 101, qty: 2, row: 'second' }]);
	assert.equal(calculateRequestProgress(items, new Map(), new Map([[101, 3]]), new Map()).closed, false);
	assert.equal(calculateRequestProgress(items, new Map(), new Map([[101, 3]]), new Map([[101, 1]])).closed, true);
});

test('purchase transfer covers lines missing from its changed or cancelled purchase', () => {
	assert.deepEqual(
		coverageBeyondBaseline(
			new Map([[101, 1], [202, 1], [303, 1], [404, 1]]),
			new Map([[101, 1], [202, 1]]),
		),
		[{ productId: 303, qty: 1 }, { productId: 404, qty: 1 }],
	);
});

test('cancelled purchase quantity resolves demand instead of reopening it', () => {
	const progress = calculateRequestProgress(
		[{ productId: 101, qty: 5 }, { productId: 202, qty: 2 }],
		new Map([[101, 3]]),
		new Map([[101, 3]]),
		new Map([[101, 2], [202, 2]]),
	);
	assert.deepEqual(progress.remaining, []);
	assert.deepEqual(progress.unfulfilled, []);
	assert.equal(progress.closed, true);
});

test('active order hides allocated demand but keeps request open until fulfillment', () => {
	const progress = calculateRequestProgress(
		[{ productId: 101, qty: 5 }],
		new Map([[101, 5]]),
		new Map(),
		new Map(),
	);
	assert.deepEqual(progress.remaining, []);
	assert.deepEqual(progress.unfulfilled, [{ productId: 101, qty: 5 }]);
	assert.equal(progress.closed, false);
});

test('полный прямой приход закрывает количество заявки', () => {
	assert.deepEqual(directReceiptFulfillment('Склад Прихода', [{
		lines: [{ productId: 101, qty: 5, requestQty: 5 }],
		receipts: [{ docstatus: 1, lines: [{ productId: 101, qty: 5, warehouse: 'Склад Прихода' }] }],
	}]), [{ productId: 101, qty: 5 }]);
});

test('частичный прямой приход засчитывает только принятое количество', () => {
	assert.deepEqual(directReceiptFulfillment('Склад Прихода', [{
		lines: [{ productId: 101, qty: 5, requestQty: 5 }],
		receipts: [{ docstatus: 1, lines: [{ productId: 101, qty: 2, warehouse: 'Склад Прихода' }] }],
	}]), [{ productId: 101, qty: 2 }]);
});

test('приход на другой склад не заменяет перемещение', () => {
	assert.deepEqual(directReceiptFulfillment('Дунайский 64', [{
		lines: [{ productId: 101, qty: 5, requestQty: 5 }],
		receipts: [{ docstatus: 1, lines: [{ productId: 101, qty: 5, warehouse: 'Склад Прихода' }] }],
	}]), []);
});

test('лишнее количество закупки не закрывает заявку сверх закреплённой доли', () => {
	assert.deepEqual(directReceiptFulfillment('Склад Прихода', [{
		lines: [{ productId: 101, qty: 10, requestQty: 4 }],
		receipts: [{ docstatus: 1, lines: [{ productId: 101, qty: 10, warehouse: ' склад прихода ' }] }],
	}]), [{ productId: 101, qty: 4 }]);
});

test('непроведённый приход не закрывает заявку', () => {
	assert.deepEqual(directReceiptFulfillment('Склад Прихода', [{
		lines: [{ productId: 101, qty: 5, requestQty: 5 }],
		receipts: [{ docstatus: 0, lines: [{ productId: 101, qty: 5, warehouse: 'Склад Прихода' }] }],
	}]), []);
});
