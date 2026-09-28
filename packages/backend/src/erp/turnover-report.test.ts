import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTurnoverRow, fetchOutstandingOrderedQuantities, type TurnoverLedgerRow } from './turnover-report.js';
import { ErpApiError, ErpClient } from './client.js';

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

test('ожидаемые поставки: 149 заказов проходят лимит ERP HTTP и учитывают приходы всех порций', async (t) => {
	const erp = new ErpClient({ url: 'http://erp.test', token: 'token test' });
	const names = Array.from({ length: 149 }, (_, index) => `PUR-ORD-2026-${String(index + 1).padStart(5, '0')}`);
	const requestedReceipts: string[] = [];
	t.mock.method(erp, 'request', async (method: string, path: string) => {
		assert.equal(method, 'GET');
		// The production HTTP server rejects request lines above 4094 bytes.
		if (Buffer.byteLength(`GET ${path} HTTP/1.1`) > 4094) {
			throw new ErpApiError(method, path, 400, 'Request Line is too large');
		}
		const url = new URL(path, 'http://erp.test');
		const [, , , doctype, name] = url.pathname.split('/').map(decodeURIComponent);
		let data: unknown;
		if (doctype === 'Purchase Order' && !name) {
			data = names.map((name) => ({ name }));
		} else if (doctype === 'Purchase Order') {
			assert.ok(names.includes(name!));
			data = { name, items: [{ item_code: '42', qty: 10 }, { item_code: '99', qty: 7 }] };
		} else if (doctype === 'Purchase Receipt' && !name) {
			const filters = JSON.parse(url.searchParams.get('filters')!) as unknown[][];
			assert.deepEqual(filters.find((filter) => filter[0] === 'docstatus'), ['docstatus', '=', 1]);
			const orderFilter = filters.find((filter) => filter[0] === 'b24_purchase_order')!;
			assert.equal(orderFilter[1], 'in');
			const selected = orderFilter[2] as string[];
			data = names.flatMap((order, index) => selected.includes(order) && index % 2 === 0
				? [{ name: `PR-${index}`, b24_purchase_order: order }] : []);
		} else if (doctype === 'Purchase Receipt') {
			requestedReceipts.push(name!);
			const index = Number(name!.slice(3));
			data = { name, b24_purchase_order: names[index], items: [{ item_code: '42', qty: 4 }] };
		} else {
			assert.fail(`unexpected request: ${path}`);
		}
		return { status: 200, json: { data } };
	});
	assert.deepEqual(await fetchOutstandingOrderedQuantities(erp, [42]), new Map([[42, 1190]]));
	assert.equal(requestedReceipts.length, 75);
	assert.equal(new Set(requestedReceipts).size, 75);
	assert.ok(requestedReceipts.includes('PR-148'), 'receipt in the final portion must be deducted');
	assert.deepEqual(await fetchOutstandingOrderedQuantities(erp), new Map([[42, 1190], [99, 1043]]));
});

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
		balance: { actual: 12, reserved: 2, ordered: 5, stockValue: 13200, valuationQty: 12 },
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
	assert.equal(row.averagePurchasePrice, 1100);
	assert.equal(row.stockValue, 13200);
});

test('списание показывается отдельно и не увеличивает продажи', () => {
	const row = buildTurnoverRow({
		...base,
		balance: { actual: 6, reserved: 0, ordered: 0, stockValue: null, valuationQty: 6 },
		ledger: [{ itemCode: '42', date: '2026-07-06', qty: -2, voucherType: 'Stock Entry', voucherNo: 'STE-1' }],
		stockEntryTypes: new Map([['STE-1', 'Material Issue']]),
	});
	assert.equal(row.soldQty, 0);
	assert.equal(row.writtenOffQty, 2);
	assert.equal(row.status, 'no_movement');
	assert.equal(row.averagePurchasePrice, null);
	assert.equal(row.stockValue, null);
});
