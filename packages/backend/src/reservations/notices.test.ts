import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildEndedNotice,
	buildRequestedNotice,
	groupLinesByStore,
	reservationNoticeChatText,
	type ReservationNotice,
} from './notices.js';

const line = (erpWarehouseName: string, itemCode: string, quantity = '2.000000000') => ({
	erpWarehouseName, itemCode, itemName: `Товар ${itemCode}`, quantity,
});

test('groupLinesByStore groups lines by warehouse preserving order', () => {
	const stores = groupLinesByStore([
		line('Склад А - УД', '1'),
		line('Склад Б - УД', '2'),
		line('Склад А - УД', '3'),
	]);
	assert.equal(stores.length, 2);
	assert.equal(stores[0]!.erpWarehouseName, 'Склад А - УД');
	assert.deepEqual(stores[0]!.items.map((item) => item.itemCode), ['1', '3']);
	assert.equal(stores[1]!.erpWarehouseName, 'Склад Б - УД');
});

test('buildRequestedNotice carries request, deal, comment and expiry', () => {
	const notice = buildRequestedNotice({
		requestId: 'req-1', dealId: 77, comment: 'Срочно', requestedExpiresAt: '2026-09-24T10:00:00.000Z',
		lines: [line('Склад А - УД', '5', '3.000000000')],
	});
	assert.equal(notice.kind, 'requested');
	assert.equal(notice.requestId, 'req-1');
	assert.equal(notice.dealId, 77);
	assert.equal(notice.comment, 'Срочно');
	assert.equal(notice.expiresAt, '2026-09-24T10:00:00.000Z');
	assert.equal(notice.stores.length, 1);
	assert.throws(() => buildRequestedNotice({ requestId: 'x', dealId: null, comment: null, requestedExpiresAt: '2026-09-24T10:00:00.000Z', lines: [] }), /at least one line/);
});

test('buildEndedNotice supports released, expired and consumed', () => {
	for (const kind of ['released', 'expired', 'consumed'] as const) {
		const notice = buildEndedNotice(kind, { reservationId: 'res-9', dealId: null, lines: [line('Склад Б - УД', '8')] });
		assert.equal(notice.kind, kind);
		assert.equal(notice.reservationId, 'res-9');
		assert.equal(notice.requestId, null);
	}
	assert.throws(() => buildEndedNotice('released', { reservationId: 'x', dealId: null, lines: [] }), /at least one line/);
});

test('reservationNoticeChatText builds chat message per store', () => {
	const notice: ReservationNotice = buildRequestedNotice({
		requestId: 'req-2', dealId: 5, comment: 'Для КП', requestedExpiresAt: '2026-09-25T12:00:00.000Z',
		lines: [line('Склад А - УД', '10'), line('Склад Б - УД', '20')],
	});
	const storeA = notice.stores.find((store) => store.erpWarehouseName === 'Склад А - УД')!;
	const text = reservationNoticeChatText(notice, storeA, 'Склад А');
	assert.match(text, /Резерв: новая заявка: Заявка №req-2 — склад «Склад А»/);
	assert.match(text, /Товар 10 \(#10\) · 2\.000000000 шт\./);
	assert.match(text, /Сделка: №5/);
	assert.match(text, /Для КП/);
});

test('reservationNoticeChatText for expired asks to return goods to shelves', () => {
	const notice = buildEndedNotice('expired', { reservationId: 'res-3', dealId: 12, lines: [line('Склад А - УД', '30')] });
	const text = reservationNoticeChatText(notice, notice.stores[0]!, 'Склад А');
	assert.match(text, /Резерв истёк: Резерв №res-3/);
	assert.match(text, /верните/i);
});
