import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSupplyMirrorPlan } from './supply-backfill-service.js';
import type { SupplyMirrorPlan } from './supply-backfill-types.js';
import type { StoredSupplyMirrorSnapshot } from './supply-mirror-reader.js';
import { compareSupplyMirrorShadow } from './supply-shadow-compare.js';

const CURRENT_OBSERVED_AT = '2026-08-21T10:00:00.000Z';
const STORED_OBSERVED_AT = '2026-08-21 09:03:35.037000';

function plan(): SupplyMirrorPlan {
	return {
		readyToApply: true,
		observedAt: CURRENT_OBSERVED_AT,
		sourceStatus: {
			erpnext: { complete: true, records: 2 },
			bitrixTransfers: { complete: true, records: 0 },
			bitrixTransferRequests: { complete: true, records: 0 },
		},
		documents: [
			{
				identity: 'erpnext:purchase_order:PO-1', externalSystem: 'erpnext', documentType: 'purchase_order', externalId: 'PO-1',
				externalRevisionKey: 'REQ-1', externalStatus: 'ordered', externalDocstatus: 1, bitrixDealId: 42,
				sourceCreatedAt: '2026-08-21T08:00:00.000Z', sourceModifiedAt: null,
				observedAt: CURRENT_OBSERVED_AT, sourceHash: 'a'.repeat(64),
			},
			{
				identity: 'erpnext:purchase_receipt:PR-1', externalSystem: 'erpnext', documentType: 'purchase_receipt', externalId: 'PR-1',
				externalRevisionKey: null, externalStatus: 'completed', externalDocstatus: 1, bitrixDealId: null,
				sourceCreatedAt: null, sourceModifiedAt: '2026-08-21 08:30:00',
				observedAt: CURRENT_OBSERVED_AT, sourceHash: 'b'.repeat(64),
			},
		],
		transferPayloads: [],
		lines: [
			{
				identity: 'erpnext:purchase_order:PO-1:key:po-line', documentIdentity: 'erpnext:purchase_order:PO-1',
				externalLineKey: 'po-line', lineOrdinal: 0, erpItemCode: 'SKU-1', plannedQty: 2, requestQty: null, actualQty: null,
				sourceWarehouse: null, targetWarehouse: 'Stores', sourceModifiedAt: null,
				observedAt: CURRENT_OBSERVED_AT, sourceHash: 'c'.repeat(64),
			},
			{
				identity: 'erpnext:purchase_receipt:PR-1:key:pr-line', documentIdentity: 'erpnext:purchase_receipt:PR-1',
				externalLineKey: 'pr-line', lineOrdinal: 0, erpItemCode: 'SKU-1', plannedQty: null, requestQty: null, actualQty: 2,
				sourceWarehouse: null, targetWarehouse: 'Stores', sourceModifiedAt: null,
				observedAt: CURRENT_OBSERVED_AT, sourceHash: 'd'.repeat(64),
			},
		],
		links: [{
			identity: 'erpnext:purchase_order:PO-1->erpnext:purchase_receipt:PR-1:received_against_order',
			fromDocumentIdentity: 'erpnext:purchase_order:PO-1', toDocumentIdentity: 'erpnext:purchase_receipt:PR-1',
			relationType: 'received_against_order', evidenceKind: 'native_erp_link', evidenceSource: 'purchase_order',
			observedAt: CURRENT_OBSERVED_AT, sourceHash: 'e'.repeat(64),
		}],
		allocations: [{
			identity: 'erpnext:purchase_order:PO-1:key:po-line->erpnext:purchase_receipt:PR-1:key:pr-line:received',
			sourceLineIdentity: 'erpnext:purchase_order:PO-1:key:po-line', targetLineIdentity: 'erpnext:purchase_receipt:PR-1:key:pr-line',
			allocationType: 'received', quantity: 2, evidenceKind: 'native_erp_link', evidenceSource: 'purchase_order',
			observedAt: CURRENT_OBSERVED_AT, sourceHash: 'f'.repeat(64),
		}],
		issues: [],
	};
}

function sqlTimestamp(value: string | null): string | null {
	if (value === null) return null;
	return new Date(value.replace(' ', 'T') + (value.includes('T') ? '' : 'Z')).toISOString().replace('T', ' ').replace('Z', '000');
}

function stored(current: SupplyMirrorPlan): StoredSupplyMirrorSnapshot {
	const summary = summarizeSupplyMirrorPlan(current);
	return {
		checkpoint: {
			planHash: summary.planHash,
			observedAt: STORED_OBSERVED_AT,
			appliedAt: '2026-08-21 09:08:45.000000',
			sourceRecords: {
				erpnext: current.sourceStatus.erpnext.records,
				bitrixTransfers: current.sourceStatus.bitrixTransfers.records,
				bitrixTransferRequests: current.sourceStatus.bitrixTransferRequests.records,
			},
			counts: {
				documents: current.documents.length,
				lines: current.lines.length,
				links: current.links.length,
				allocations: current.allocations.length,
				warnings: summary.counts.warnings,
			},
		},
		documents: current.documents.map((row) => ({
			...row,
			sourceCreatedAt: sqlTimestamp(row.sourceCreatedAt),
			sourceModifiedAt: sqlTimestamp(row.sourceModifiedAt),
			observedAt: STORED_OBSERVED_AT,
		})),
		transferPayloads: current.transferPayloads.map((row) => ({ ...row, observedAt: STORED_OBSERVED_AT })),
		lines: current.lines.map((row) => ({ ...row, sourceModifiedAt: sqlTimestamp(row.sourceModifiedAt), observedAt: STORED_OBSERVED_AT })),
		links: current.links.map((row) => ({ ...row, observedAt: STORED_OBSERVED_AT })),
		allocations: current.allocations.map((row) => ({ ...row, observedAt: STORED_OBSERVED_AT })),
	};
}

test('shadow comparator reports exact parity while ignoring the observation time difference', () => {
	const current = plan();
	const report = compareSupplyMirrorShadow(current, stored(current));
	assert.equal(report.status, 'match');
	assert.equal(report.matches, true);
	assert.equal(report.comparable, true);
	assert.equal(report.totalDifferences, 0);
	assert.deepEqual(report.differences, []);
});

test('shadow comparator reports field, missing-row and checkpoint integrity differences deterministically', () => {
	const current = plan();
	const sql = stored(current);
	sql.documents[0]!.externalStatus = 'cancelled';
	sql.lines.pop();
	const report = compareSupplyMirrorShadow(current, sql, { maxDifferences: 2 });
	assert.equal(report.status, 'mismatch');
	assert.equal(report.matches, false);
	assert.equal(report.comparable, true);
	assert.equal(report.totalDifferences, 3);
	assert.equal(report.differences.length, 2);
	assert.equal(report.truncated, true);
	assert.deepEqual(report.differences.map((item) => [item.collection, item.kind, item.field]), [
		['checkpoint', 'field_mismatch', 'linesCount'],
		['documents', 'field_mismatch', 'externalStatus'],
	]);
});

test('shadow comparator refuses an incomplete current plan instead of treating it as an empty source', () => {
	const current = plan();
	current.readyToApply = false;
	current.sourceStatus.bitrixTransfers = { complete: false, records: 0, error: 'Bitrix unavailable' };
	current.issues.push({ severity: 'error', code: 'incomplete_source', identity: 'bitrixTransfers', message: 'Bitrix unavailable' });
	const report = compareSupplyMirrorShadow(current, stored(plan()));
	assert.equal(report.status, 'plan_blocked');
	assert.equal(report.comparable, false);
	assert.equal(report.planErrors, 1);
	assert.equal(report.totalDifferences, 0);
});

test('shadow comparator distinguishes an absent SQL snapshot from a mismatch', () => {
	const report = compareSupplyMirrorShadow(plan(), null);
	assert.equal(report.status, 'no_snapshot');
	assert.equal(report.comparable, false);
	assert.equal(report.storedPlanHash, null);
});

test('shadow comparator bounds detailed differences', () => {
	assert.throws(() => compareSupplyMirrorShadow(plan(), null, { maxDifferences: 0 }), /maxDifferences/);
});
