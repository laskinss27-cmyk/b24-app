import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredTransfer } from '../transfers/model.js';
import { buildLegacyReservationBackfillPlan, type LegacyReservationSnapshot } from './legacy-backfill-plan.js';

function transfer(id: number, createdAt: string, qty: number, status: StoredTransfer['status'] = 'draft'): StoredTransfer {
	return {
		id,
		name: `Перемещение #${id}`,
		supplyRequest: '',
		supplyRequestKey: '',
		purchaseOrder: '',
		dealId: '',
		toStore: 'Магазин - УД',
		fromStore: 'Основной склад - УД',
		status,
		lines: [{ productId: 100, name: 'Камера', qty }],
		collectedLines: [],
		shippedLines: [],
		acceptedLines: [],
		note: '',
		taskId: null,
		shipEntry: null,
		receiveEntry: null,
		receivedLines: [],
		shortageLines: [],
		shortageReturnEntry: null,
		correctionOf: null,
		correctionKind: null,
		correctionIds: [],
		createdAt,
		createdById: '2',
		createdByName: 'Снабжение',
		history: [],
	};
}

function snapshot(input: Partial<LegacyReservationSnapshot> = {}): LegacyReservationSnapshot {
	const transfers = input.transfers ?? [transfer(10, '2026-09-01T10:00:00.000Z', 4)];
	const basketReservations = input.basketReservations ?? [];
	const erpBins = input.erpBins ?? [{ erpWarehouseName: 'Основной склад - УД', itemCode: '100', actualQty: 4, reservedQty: 0 }];
	return {
		observedAt: '2026-09-01T12:00:00.000Z',
		sourceStatus: input.sourceStatus ?? {
			bitrixTransfers: { complete: true, records: transfers.length },
			bitrixBasketReservations: { complete: true, records: basketReservations.length },
			erpBins: { complete: true, records: erpBins.length },
		},
		transfers,
		basketReservations,
		erpBins,
	};
}

test('complete active transfers produce a deterministic transfer-only backfill plan', () => {
	const first = buildLegacyReservationBackfillPlan(snapshot());
	const second = buildLegacyReservationBackfillPlan(snapshot());
	assert.equal(first.readyToApply, true);
	assert.equal(first.planHash, second.planHash);
	assert.match(first.planHash, /^[a-f0-9]{64}$/);
	assert.deepEqual(first.counts, { reservations: 1, lines: 1, shortfallLines: 0, errors: 0, warnings: 0 });
	assert.deepEqual(first.reservations[0]!.lines[0], {
		sourceLineKey: 'product:100',
		erpWarehouseName: 'Основной склад - УД',
		itemCode: '100',
		reservedQty: '4',
		shortfallQty: '0',
	});
	assert.equal(first.reservations[0]!.expiresAt, null);
});

test('legacy transfer backfill clips a soft promise to current physical stock', () => {
	const plan = buildLegacyReservationBackfillPlan(snapshot({
		erpBins: [{ erpWarehouseName: 'Основной склад - УД', itemCode: '100', actualQty: 3, reservedQty: 0 }],
	}));
	assert.equal(plan.readyToApply, true);
	assert.equal(plan.reservations[0]!.lines[0]!.reservedQty, '4');
	assert.equal(plan.reservations[0]!.lines[0]!.shortfallQty, '1');
	assert.equal(plan.counts.shortfallLines, 1);
});

test('physical deficit reduces the newest legacy transfer first', () => {
	const plan = buildLegacyReservationBackfillPlan(snapshot({
		transfers: [
			transfer(10, '2026-09-01T10:00:00.000Z', 2),
			transfer(20, '2026-09-01T11:00:00.000Z', 2),
		],
		erpBins: [{ erpWarehouseName: 'Основной склад - УД', itemCode: '100', actualQty: 3, reservedQty: 0 }],
	}));
	const old = plan.reservations.find((item) => item.sourceId === '10')!;
	const recent = plan.reservations.find((item) => item.sourceId === '20')!;
	assert.equal(old.lines[0]!.shortfallQty, '0');
	assert.equal(recent.lines[0]!.shortfallQty, '1');
});

test('ambiguous requested transfers fail closed instead of silently reserving', () => {
	const plan = buildLegacyReservationBackfillPlan(snapshot({
		transfers: [transfer(10, '2026-09-01T10:00:00.000Z', 1, 'requested')],
	}));
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((item) => item.code === 'ambiguous_legacy_requested_transfer'));
	assert.equal(plan.reservations.length, 0);
});

test('native basket reservations require explicit supply review and expiry evidence', () => {
	const basketReservations = [{
		orderId: 50,
		basketId: 60,
		dealId: 501,
		productRowId: 700,
		storeId: 8,
		erpWarehouseName: 'Основной склад - УД',
		itemCode: '100',
		quantity: 1,
	}];
	const plan = buildLegacyReservationBackfillPlan(snapshot({ basketReservations }));
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((item) => item.code === 'legacy_basket_requires_supply_review'));
});

test('ERP reserved_qty is diagnostic and blocks attribution by coincidence', () => {
	const plan = buildLegacyReservationBackfillPlan(snapshot({
		erpBins: [{ erpWarehouseName: 'Основной склад - УД', itemCode: '100', actualQty: 4, reservedQty: 4 }],
	}));
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((item) => item.code === 'unattributed_erp_reserved_qty'));
});

test('negative ERP physical is explicit zero support and never makes active reserve negative', () => {
	const plan = buildLegacyReservationBackfillPlan(snapshot({
		erpBins: [{ erpWarehouseName: 'Основной склад - УД', itemCode: '100', actualQty: -1, reservedQty: 0 }],
	}));
	assert.equal(plan.readyToApply, true);
	assert.equal(plan.reservations[0]!.status, 'shortfall');
	assert.equal(plan.reservations[0]!.lines[0]!.shortfallQty, '4');
	assert.ok(plan.issues.some((item) => item.code === 'negative_erp_physical' && item.severity === 'warning'));
});

test('incomplete sources and count mismatches never produce an applicable plan', () => {
	const input = snapshot();
	input.sourceStatus.bitrixTransfers = { complete: false, records: 999, error: 'pagination failed' };
	const plan = buildLegacyReservationBackfillPlan(input);
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((item) => item.code === 'incomplete_source'));
	assert.ok(plan.issues.some((item) => item.code === 'source_count_mismatch'));
});

test('terminal transfers are evidence only and do not become active reservations', () => {
	const plan = buildLegacyReservationBackfillPlan(snapshot({
		transfers: [transfer(10, '2026-09-01T10:00:00.000Z', 4, 'posted')],
		erpBins: [],
	}));
	assert.equal(plan.readyToApply, true);
	assert.equal(plan.reservations.length, 0);
});
