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
});

test('stale request revision is reported instead of guessed', () => {
	const raw = rawSources();
	raw.purchaseOrders[0]!['b24_supply_request_key'] = 'MR-1@old';
	const plan = buildSupplyMirrorPlan(buildSupplyMirrorSnapshot(raw, observedAt));
	assert.equal(plan.readyToApply, false);
	assert.ok(plan.issues.some((item) => item.code === 'stale_request_key' && item.identity === 'PO-1'));
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
	assert.ok(report.issues.some((item) => item.code === 'incomplete_source'));
});
