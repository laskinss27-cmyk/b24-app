import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTurnoverRow, type TurnoverLedgerRow } from './turnover-report.js';

const base = {
	productId: 42,
	name: 'Камера',
	article: 'CAM-42',
	brand: 'Test',
	section: 'Камеры',
	from: '2026-07-01',
	to: '2026-07-10',
	today: '2026-07-15',
	days: 10,
};

test('оборачиваемость: продажи и возвраты считаются, перемещение не расход', () => {
	const ledger: TurnoverLedgerRow[] = [
		{ itemCode: '42', date: '2026-07-02', qty: 10, voucherType: 'Purchase Receipt', voucherNo: 'PR-1' },
		{ itemCode: '42', date: '2026-07-03', qty: -4, voucherType: 'Delivery Note', voucherNo: 'DN-1' },
		{ itemCode: '42', date: '2026-07-04', qty: 1, voucherType: 'Delivery Note', voucherNo: 'DN-RET-1' },
		{ itemCode: '42', date: '2026-07-05', qty: -3, voucherType: 'Stock Entry', voucherNo: 'MOVE-1' },
		{ itemCode: '42', date: '2026-07-05', qty: 3, voucherType: 'Stock Entry', voucherNo: 'MOVE-1' },
		{ itemCode: '42', date: '2026-07-12', qty: -2, voucherType: 'Delivery Note', voucherNo: 'DN-2' },
	];
	const row = buildTurnoverRow({
		...base,
		balance: { actual: 12, reserved: 2, ordered: 5 },
		ledger,
		stockEntryTypes: new Map([['MOVE-1', 'Material Transfer']]),
	});
	assert.equal(row.openingQty, 7);
	assert.equal(row.closingQty, 14);
	assert.equal(row.currentQty, 12);
	assert.equal(row.receivedQty, 10);
	assert.equal(row.soldQty, 3);
	assert.equal(row.returnedQty, 1);
	assert.equal(row.writtenOffQty, 0);
	assert.equal(row.availableQty, 10);
});

test('списание показывается отдельно и не увеличивает продажи', () => {
	const row = buildTurnoverRow({
		...base,
		balance: { actual: 6, reserved: 0, ordered: 0 },
		ledger: [{ itemCode: '42', date: '2026-07-06', qty: -2, voucherType: 'Stock Entry', voucherNo: 'STE-1' }],
		stockEntryTypes: new Map([['STE-1', 'Material Issue']]),
	});
	assert.equal(row.soldQty, 0);
	assert.equal(row.writtenOffQty, 2);
	assert.equal(row.status, 'no_movement');
});
