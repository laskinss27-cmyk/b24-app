import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSupplyMirrorPlan, supplyMirrorSourceHash } from './supply-backfill-plan.js';
import type { MirrorDocumentRef, SupplyMirrorSnapshot } from './supply-backfill-types.js';

const observedAt = '2026-08-20T13:30:00.000Z';
const request: MirrorDocumentRef = { externalSystem: 'erpnext', documentType: 'supply_request', externalId: 'MR-1' };
const purchase: MirrorDocumentRef = { externalSystem: 'erpnext', documentType: 'purchase_order', externalId: 'PO-1' };

function completeSnapshot(): SupplyMirrorSnapshot {
	return {
		observedAt,
		sources: {
			erpnext: { complete: true, records: 2 },
			bitrixTransfers: { complete: true, records: 0 },
		},
		documents: [
			{
				...request,
				externalRevisionKey: 'MR-1@created',
				externalStatus: 'Pending',
				externalDocstatus: 0,
				bitrixDealId: 42,
				observedAt,
				sourcePayload: { name: 'MR-1', status: 'Pending' },
				lines: [{ externalLineKey: 'MRI-1', lineOrdinal: 1, erpItemCode: '100', requestQty: 2, targetWarehouse: 'Target', sourcePayload: { name: 'MRI-1', qty: 2 } }],
			},
			{
				...purchase,
				externalRevisionKey: 'MR-1@created',
				externalStatus: 'ordered',
				externalDocstatus: 0,
				bitrixDealId: 42,
				observedAt,
				sourcePayload: { name: 'PO-1', stage: 'ordered' },
				lines: [{ externalLineKey: 'POI-1', lineOrdinal: 1, erpItemCode: '100', plannedQty: 3, requestQty: 2, sourcePayload: { name: 'POI-1', qty: 3, requestQty: 2 } }],
			},
		],
		links: [{
			from: purchase,
			to: request,
			relationType: 'ordered_for_request',
			evidenceKind: 'explicit_external_field',
			evidenceSource: 'b24_supply_request',
			observedAt,
			sourcePayload: { purchaseOrder: 'PO-1', supplyRequest: 'MR-1' },
		}],
		allocations: [{
			source: { document: request, externalLineKey: 'MRI-1', lineOrdinal: 1 },
			target: { document: purchase, externalLineKey: 'POI-1', lineOrdinal: 1 },
			allocationType: 'ordered',
			quantity: 2,
			evidenceKind: 'derived_match',
			evidenceSource: 'b24_request_qty+item_code',
			observedAt,
			sourcePayload: { requestLine: 'MRI-1', purchaseLine: 'POI-1', quantity: 2 },
		}],
	};
}

test('supply mirror plan is deterministic and ready only for a complete valid snapshot', () => {
	const first = buildSupplyMirrorPlan(completeSnapshot());
	const secondSnapshot = completeSnapshot();
	secondSnapshot.documents.reverse();
	const second = buildSupplyMirrorPlan(secondSnapshot);
	assert.equal(first.readyToApply, true);
	assert.deepEqual(first.issues, []);
	assert.equal(first.documents.length, 2);
	assert.equal(first.lines.length, 2);
	assert.equal(first.links.length, 1);
	assert.equal(first.allocations.length, 1);
	assert.deepEqual(first, second);
	assert.match(first.documents[0]!.sourceHash, /^[a-f0-9]{64}$/);
	assert.equal(supplyMirrorSourceHash({ b: 2, a: 1 }), supplyMirrorSourceHash({ a: 1, b: 2 }));
});

test('supply mirror plan refuses an incomplete Bitrix transfer source', () => {
	const snapshot = completeSnapshot();
	snapshot.sources.bitrixTransfers = { complete: false, records: 0, error: 'entity.item.get: access denied' };
	const plan = buildSupplyMirrorPlan(snapshot);
	assert.equal(plan.readyToApply, false);
	assert.deepEqual(plan.issues.map((issue) => issue.code), ['incomplete_source']);
	assert.match(plan.issues[0]!.message, /access denied/);
});

test('supply mirror plan reports duplicate identities and unresolved graph references', () => {
	const snapshot = completeSnapshot();
	snapshot.documents.push(structuredClone(snapshot.documents[0]!));
	snapshot.links.push({
		from: purchase,
		to: { externalSystem: 'bitrix', documentType: 'transfer', externalId: '404' },
		relationType: 'transfers_for_purchase',
		evidenceKind: 'explicit_external_field',
		evidenceSource: 'purchaseOrder',
		observedAt,
		sourcePayload: {},
	});
	const plan = buildSupplyMirrorPlan(snapshot);
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((issue) => issue.code === 'duplicate_document_identity'));
	assert.ok(plan.issues.some((issue) => issue.code === 'duplicate_line_identity'));
	assert.ok(plan.issues.some((issue) => issue.code === 'missing_link_document'));
});

test('supply mirror plan rejects invalid quantities before SQL exists', () => {
	const snapshot = completeSnapshot();
	snapshot.documents[0]!.lines[0]!.requestQty = -1;
	snapshot.allocations[0]!.quantity = 0;
	const plan = buildSupplyMirrorPlan(snapshot);
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((issue) => issue.code === 'invalid_line_quantity'));
	assert.ok(plan.issues.some((issue) => issue.code === 'missing_allocation_line'));
	assert.ok(plan.issues.some((issue) => issue.code === 'invalid_allocation_quantity'));
});
