import assert from 'node:assert/strict';
import test from 'node:test';
import { directReceiptFulfillment } from './progress.js';

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
