import assert from 'node:assert/strict';
import test from 'node:test';
import {
	activeReservationQuantity,
	availableForUnrelatedOperation,
	deriveQuantityStatus,
	formatReservationQuantity,
	idempotencyDecision,
	parseReservationQuantity,
	reconcileReservationShortfall,
	reduceReservationLine,
	type ReservationLineProjection,
} from './domain.js';

const q = parseReservationQuantity;

function line(input: Partial<ReservationLineProjection> & Pick<ReservationLineProjection, 'lineId' | 'reservationId' | 'approvedAt' | 'reservedQty'>): ReservationLineProjection {
	return {
		erpWarehouseName: 'Основной склад - УД',
		itemCode: 'CAM-1',
		consumedQty: 0n,
		releasedQty: 0n,
		shortfallQty: 0n,
		...input,
	};
}

test('quantities retain the SQL DECIMAL(21,9) scale without floating point drift', () => {
	assert.equal(q('4'), 4_000_000_000n);
	assert.equal(q('0.000000001'), 1n);
	assert.equal(formatReservationQuantity(q('12.340000000')), '12.34');
	assert.throws(() => q('-1'), /Invalid reservation quantity/);
	assert.throws(() => q('1.0000000001'), /Invalid reservation quantity/);
});

test('consume, release and shortfall only reduce the active promise', () => {
	const original = line({ lineId: 1n, reservationId: 10n, approvedAt: '2026-09-01T10:00:00.000000Z', reservedQty: q('4') });
	const consumed = reduceReservationLine(original, 'consumed', q('1'));
	const released = reduceReservationLine(consumed, 'released', q('1'));
	const shortfall = reduceReservationLine(released, 'shortfall', q('1'));
	assert.equal(formatReservationQuantity(activeReservationQuantity(shortfall)), '1');
	assert.throws(() => reduceReservationLine(shortfall, 'released', q('2')), /exceeds active quantity/);
	assert.equal(activeReservationQuantity(original), q('4'));
});

test('physical 4 to 3 does not block the document and irreversibly shrinks reserve 4 to 3', () => {
	const original = line({ lineId: 1n, reservationId: 10n, approvedAt: '2026-09-01T10:00:00.000000Z', reservedQty: q('4') });
	const reduced = reconcileReservationShortfall([original], q('3'));
	assert.deepEqual(reduced.reductions, [{ lineId: 1n, reservationId: 10n, quantity: q('1') }]);
	assert.equal(activeReservationQuantity(reduced.lines[0]!), q('3'));
	assert.equal(reduced.lines[0]!.shortfallQty, q('1'));

	const afterReceipt = reconcileReservationShortfall(reduced.lines, q('4'));
	assert.deepEqual(afterReceipt.reductions, []);
	assert.equal(activeReservationQuantity(afterReceipt.lines[0]!), q('3'));
});

test('shortfall protects older approvals and reduces newest reservations first', () => {
	const oldest = line({ lineId: 1n, reservationId: 10n, approvedAt: '2026-09-01T10:00:00.000000Z', reservedQty: q('2') });
	const newest = line({ lineId: 2n, reservationId: 20n, approvedAt: '2026-09-01T11:00:00.000000Z', reservedQty: q('2') });
	const result = reconcileReservationShortfall([newest, oldest], q('3'));
	assert.deepEqual(result.reductions, [{ lineId: 2n, reservationId: 20n, quantity: q('1') }]);
	assert.equal(activeReservationQuantity(result.lines.find((item) => item.lineId === 1n)!), q('2'));
	assert.equal(activeReservationQuantity(result.lines.find((item) => item.lineId === 2n)!), q('1'));
});

test('equal approval timestamps use descending reservation and line ids', () => {
	const approvedAt = '2026-09-01T10:00:00.000000Z';
	const result = reconcileReservationShortfall([
		line({ lineId: 1n, reservationId: 10n, approvedAt, reservedQty: q('1') }),
		line({ lineId: 2n, reservationId: 20n, approvedAt, reservedQty: q('1') }),
		line({ lineId: 3n, reservationId: 20n, approvedAt, reservedQty: q('1') }),
	], q('1'));
	assert.deepEqual(result.reductions.map((item) => item.lineId), [3n, 2n]);
});

test('own-source realization consumes its reserve before physical shortfall is reconciled', () => {
	const own = line({ lineId: 2n, reservationId: 20n, approvedAt: '2026-09-01T11:00:00.000000Z', reservedQty: q('2') });
	const other = line({ lineId: 1n, reservationId: 10n, approvedAt: '2026-09-01T10:00:00.000000Z', reservedQty: q('2') });
	const consumedOwn = reduceReservationLine(own, 'consumed', q('2'));
	const result = reconcileReservationShortfall([consumedOwn, other], q('2'));
	assert.deepEqual(result.reductions, []);
	assert.equal(deriveQuantityStatus([consumedOwn]), 'consumed');
	assert.equal(activeReservationQuantity(other), q('2'));
});

test('unrelated sales see reserve overlay while physical operations can still use physical stock', () => {
	assert.equal(availableForUnrelatedOperation(q('4'), q('4')), 0n);
	assert.equal(availableForUnrelatedOperation(q('3'), q('4')), 0n);
	assert.equal(availableForUnrelatedOperation(q('5'), q('3'), q('1')), q('1'));
});

test('terminal quantity status distinguishes single and mixed closure reasons', () => {
	const base = line({ lineId: 1n, reservationId: 10n, approvedAt: '2026-09-01T10:00:00.000000Z', reservedQty: q('2') });
	assert.equal(deriveQuantityStatus([reduceReservationLine(base, 'shortfall', q('2'))]), 'shortfall');
	assert.equal(deriveQuantityStatus([reduceReservationLine(base, 'released', q('2'))]), 'released');
	assert.equal(deriveQuantityStatus([reduceReservationLine(base, 'consumed', q('2'))]), 'consumed');
	const mixed = reduceReservationLine(reduceReservationLine(base, 'consumed', q('1')), 'shortfall', q('1'));
	assert.equal(deriveQuantityStatus([mixed]), 'closed');
});

test('idempotency replays the same request and rejects key reuse for another request', () => {
	const first = 'a'.repeat(64);
	assert.equal(idempotencyDecision(null, first), 'start');
	assert.equal(idempotencyDecision(first, first), 'replay');
	assert.throws(() => idempotencyDecision(first, 'b'.repeat(64)), /conflicts with a different request hash/);
});
