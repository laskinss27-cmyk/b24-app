import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSupplyMirrorPlan } from './supply-backfill-plan.js';
import { buildSupplyMirrorSnapshot } from './supply-backfill-snapshot.js';
import { runSupplyBackfillDryRun, summarizeSupplyMirrorPlan } from './supply-backfill-service.js';
import { readSupplyBackfillErpSources, type SupplyBackfillRawSources } from './supply-backfill-read.js';
import type { ErpClient } from '../erp/client.js';
import type { B24Client } from '../b24/client.js';

const observedAt = '2026-08-20T14:00:00.000Z';

function rawSources(): SupplyBackfillRawSources {
	return {
		materialRequests: [{
			name: 'MR-1', creation: '2026-08-01 10:00:00', modified: '2026-08-01 10:00:00', status: 'Pending', docstatus: 0, b24_deal_id: '42',
			items: [{ name: 'MRI-1', item_code: '100', qty: 2, warehouse: 'Target' }],
		}],
		purchaseOrders: [{
			name: 'PO-1', creation: '2026-08-02 10:00:00', status: 'To Receive', docstatus: 1, b24_deal_id: '42', b24_supply_request: 'MR-1', b24_supply_request_key: 'MR-1@2026-08-01 10:00:00', b24_supply_stage: 'ordered',
			items: [{ name: 'POI-1', item_code: '100', qty: 2, b24_request_qty: 2 }],
		}],
		purchaseReceipts: [{
			name: 'PR-1', creation: '2026-08-03 10:00:00', status: 'Completed', docstatus: 1, b24_deal_id: '42', b24_supply_request: 'MR-1', b24_supply_request_key: 'MR-1@2026-08-01 10:00:00', b24_purchase_order: 'PO-1',
			items: [{ name: 'PRI-1', item_code: '100', qty: 2, warehouse: 'Incoming' }],
		}],
		stockEntries: [{
			name: 'MAT-STE-1', creation: '2026-08-04 10:00:00', status: 'Submitted', docstatus: 1, b24_deal_id: '42', b24_supply_request: 'MR-1', b24_supply_request_key: 'MR-1@2026-08-01 10:00:00', b24_purchase_order: 'PO-1', b24_transfer_document: '10', b24_transfer_phase: 'receive',
			items: [{ name: 'SEI-1', item_code: '100', qty: 2, s_warehouse: 'Transit', t_warehouse: 'Target' }],
		}],
		transferItems: [{
			ID: '10', NAME: 'Transfer 10', DETAIL_TEXT: JSON.stringify({
				supplyRequest: 'MR-1', supplyRequestKey: 'MR-1@2026-08-01 10:00:00', purchaseOrder: 'PO-1', dealId: '42', fromStore: 'Incoming', toStore: 'Target', status: 'posted', lines: [{ productId: 100, name: 'Item', qty: 2 }], acceptedLines: [{ productId: 100, name: 'Item', qty: 2 }], createdAt: '2026-08-04T09:00:00.000Z', createdById: '1858', createdByName: 'Owner', history: [],
			}),
		}],
		transferRequestItems: [],
	};
}

test('read-only supply snapshot builds the explicit ERP and Bitrix document graph', () => {
	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(rawSources(), observedAt));
	assert.equal(plan.readyToApply, true);
	assert.deepEqual(plan.issues, []);
	assert.equal(plan.documents.length, 5);
	assert.equal(plan.lines.length, 5);
	assert.equal(plan.links.length, 6);
	assert.equal(plan.allocations.length, 4);
	const report = summarizeSupplyMirrorPlan(plan);
	assert.match(report.planHash, /^[a-f0-9]{64}$/);
	const later = summarizeSupplyMirrorPlan(buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(rawSources(), '2026-08-20T15:00:00.000Z')));
	assert.equal(report.planHash, later.planHash);
	assert.deepEqual(report.documentsByType, { purchase_order: 1, purchase_receipt: 1, stock_entry: 1, supply_request: 1, transfer: 1 });
});

test('invalid Bitrix transfer JSON makes the mirror plan non-applicable', () => {
	const raw = rawSources();
	raw.transferItems[0]!['DETAIL_TEXT'] = '{broken';
	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	assert.equal(plan.readyToApply, false);
	assert.equal(plan.sourceStatus.bitrixTransfers.complete, false);
	assert.ok(plan.issues.some((item) => item.code === 'invalid_transfer_record'));
	assert.ok(plan.issues.some((item) => item.code === 'incomplete_source'));
	assert.ok(!plan.documents.some((item) => item.externalStatus === 'source_missing'));
});

test('stale request revision is reported instead of guessed', () => {
	const raw = rawSources();
	raw.purchaseOrders[0]!['b24_supply_request_key'] = 'MR-1@old';
	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((item) => item.code === 'stale_request_key' && item.identity === 'PO-1'));
});

test('standalone purchase orders and transfers are valid graph roots', () => {
	const raw = rawSources();
	raw.materialRequests = [];
	raw.purchaseReceipts = [];
	raw.stockEntries = [];
	raw.purchaseOrders[0]!['b24_supply_request'] = '__standalone__';
	raw.purchaseOrders[0]!['b24_supply_request_key'] = '';
	const transfer = JSON.parse(String(raw.transferItems[0]!['DETAIL_TEXT'])) as Record<string, unknown>;
	transfer['supplyRequest'] = '';
	transfer['supplyRequestKey'] = '';
	transfer['purchaseOrder'] = '';
	raw.transferItems[0]!['DETAIL_TEXT'] = JSON.stringify(transfer);

	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	assert.equal(plan.readyToApply, true);
	assert.deepEqual(plan.issues, []);
	assert.equal(plan.documents.length, 2);
	assert.equal(plan.links.length, 0);
	assert.equal(plan.allocations.length, 0);
});

test('manual Bitrix transfer request is a real graph document keyed by transfer-request id', () => {
	const raw = rawSources();
	raw.materialRequests = [];
	raw.purchaseOrders = [];
	raw.purchaseReceipts = [];
	raw.stockEntries = [];
	raw.transferRequestItems = [{
		ID: '5', NAME: 'Заказ на перемещение #5: A → B', DETAIL_TEXT: JSON.stringify({
			kind: 'transfer', fromStore: 'A', toStore: 'B', status: 'converted', createdAt: '2026-08-01T10:00:00.000Z',
			lines: [{ productId: 100, name: 'Item', qty: 2 }], supplyLines: [], transferId: 10,
		}),
	}];
	const transfer = JSON.parse(String(raw.transferItems[0]!['DETAIL_TEXT'])) as Record<string, unknown>;
	transfer['supplyRequest'] = 'Заказ на перемещение #5';
	transfer['supplyRequestKey'] = 'transfer-request:5';
	transfer['purchaseOrder'] = '';
	raw.transferItems[0]!['DETAIL_TEXT'] = JSON.stringify(transfer);

	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	assert.equal(plan.readyToApply, true);
	assert.deepEqual(plan.issues, []);
	assert.ok(plan.documents.some((item) => item.identity === 'bitrix:supply_request:5'));
	assert.ok(plan.links.some((item) => item.identity === 'bitrix:transfer:10->bitrix:supply_request:5:transfers_for_request'));
	assert.equal(plan.allocations.length, 1);
});

test('invalid Bitrix transfer request JSON makes its source incomplete', () => {
	const raw = rawSources();
	raw.transferRequestItems = [{ ID: '5', DETAIL_TEXT: '{broken' }];
	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	assert.equal(plan.readyToApply, false);
	assert.equal(plan.sourceStatus.bitrixTransferRequests.complete, false);
	assert.ok(plan.issues.some((item) => item.code === 'invalid_transfer_request_record'));
	assert.ok(plan.issues.some((item) => item.code === 'incomplete_source' && item.identity === 'bitrixTransferRequests'));
});

test('missing historical transfer becomes an evidence-only tombstone without invented lines', () => {
	const raw = rawSources();
	raw.materialRequests = [];
	raw.purchaseOrders = [];
	raw.purchaseReceipts = [];
	raw.transferItems = [];
	raw.transferRequestItems = [];

	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	const report = summarizeSupplyMirrorPlan(plan);
	assert.equal(plan.readyToApply, true);
	assert.equal(plan.documents.length, 2);
	assert.equal(plan.lines.length, 1);
	assert.equal(plan.links.length, 1);
	assert.equal(plan.allocations.length, 0);
	assert.deepEqual(plan.issues, [{
		severity: 'warning',
		code: 'historical_transfer_line_unavailable',
		identity: 'MAT-STE-1:1',
		message: 'transfer 10 is absent from the complete Bitrix snapshot; line allocation was not invented',
	}]);
	const tombstone = plan.documents.find((item) => item.identity === 'bitrix:transfer:10');
	assert.equal(tombstone?.externalStatus, 'source_missing');
	assert.ok(!plan.lines.some((item) => item.documentIdentity === 'bitrix:transfer:10'));
	assert.equal(report.counts.errors, 0);
	assert.equal(report.counts.warnings, 1);
});

test('recent missing transfer stays an error instead of becoming a tombstone', () => {
	const raw = rawSources();
	raw.materialRequests = [];
	raw.purchaseOrders = [];
	raw.purchaseReceipts = [];
	raw.transferItems = [];
	raw.transferRequestItems = [];
	raw.stockEntries[0]!['creation'] = observedAt;
	raw.stockEntries[0]!['modified'] = observedAt;

	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((item) => item.code === 'unconfirmed_missing_transfer' && item.identity === '10'));
	assert.ok(!plan.documents.some((item) => item.externalStatus === 'source_missing'));
});

test('missing transfer backed only by old canceled Stock Entries becomes a canceled evidence tombstone', () => {
	const raw = rawSources();
	raw.materialRequests = [];
	raw.purchaseOrders = [];
	raw.purchaseReceipts = [];
	raw.transferItems = [];
	raw.transferRequestItems = [];
	raw.stockEntries[0]!['docstatus'] = 2;
	raw.stockEntries[0]!['status'] = 'Cancelled';

	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	const report = summarizeSupplyMirrorPlan(plan);
	const tombstone = plan.documents.find((item) => item.identity === 'bitrix:transfer:10');
	assert.equal(plan.readyToApply, true);
	assert.equal(tombstone?.externalStatus, 'source_missing_canceled');
	assert.equal(plan.links.length, 1);
	assert.equal(plan.allocations.length, 0);
	assert.equal(report.counts.errors, 0);
	assert.equal(report.counts.warnings, 1);
});

test('recent canceled missing transfer stays an error', () => {
	const raw = rawSources();
	raw.materialRequests = [];
	raw.purchaseOrders = [];
	raw.purchaseReceipts = [];
	raw.transferItems = [];
	raw.transferRequestItems = [];
	raw.stockEntries[0]!['docstatus'] = 2;
	raw.stockEntries[0]!['creation'] = observedAt;
	raw.stockEntries[0]!['modified'] = observedAt;

	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((item) => item.code === 'unconfirmed_missing_transfer' && item.identity === '10'));
	assert.ok(!plan.documents.some((item) => item.externalStatus?.startsWith('source_missing')));
});

test('mixed submitted and canceled evidence stays an error instead of guessing transfer state', () => {
	const raw = rawSources();
	raw.materialRequests = [];
	raw.purchaseOrders = [];
	raw.purchaseReceipts = [];
	raw.transferItems = [];
	raw.transferRequestItems = [];
	raw.stockEntries[0]!['docstatus'] = 2;
	raw.stockEntries.push({ ...raw.stockEntries[0]!, name: 'MAT-STE-2', docstatus: 1 });

	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((item) => item.code === 'unconfirmed_missing_transfer' && item.identity === '10'));
	assert.ok(!plan.documents.some((item) => item.externalStatus?.startsWith('source_missing')));
});

test('ERP source collector uses list and get only', async () => {
	const calls: string[] = [];
	const erp = {
		async list(doctype: string): Promise<Record<string, unknown>[]> { calls.push(`list:${doctype}`); return []; },
		async get(): Promise<null> { calls.push('get'); return null; },
	} as unknown as ErpClient;
	assert.deepEqual(await readSupplyBackfillErpSources(erp), { materialRequests: [], purchaseOrders: [], purchaseReceipts: [], stockEntries: [] });
	assert.deepEqual(calls, ['list:Material Request', 'list:Purchase Order', 'list:Purchase Receipt', 'list:Stock Entry']);
});

test('Bitrix access failure is an explicit non-applicable report, never an empty registry', async () => {
	const erp = { async list(): Promise<[]> { return []; }, async get(): Promise<null> { return null; } } as unknown as ErpClient;
	const client = { async callWithMeta(): Promise<never> { throw new Error('entity.item.get: access denied'); } } as unknown as B24Client;
	const report = await runSupplyBackfillDryRun(erp, client, new Date(observedAt));
	assert.equal(report.readyToApply, false);
	assert.deepEqual(report.sources.bitrixTransfers, { complete: false, records: 0, error: 'entity.item.get: access denied' });
	assert.deepEqual(report.sources.bitrixTransferRequests, { complete: false, records: 0, error: 'entity.item.get: access denied' });
	assert.ok(report.issues.some((item) => item.code === 'incomplete_source'));
});
