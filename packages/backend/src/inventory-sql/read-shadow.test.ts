import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../config.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import { buildInventorySqlBackfillPlan } from './backfill-plan.js';
import { observeInventorySqlReadShadow } from './read-shadow.js';

function item(factQty = 2): Record<string, unknown> {
	return {
		ID: '42',
		NAME: 'Ревизия',
		CREATED_BY: '1',
		DATE_CREATE: '2026-09-05T08:00:00.000Z',
		DETAIL_TEXT: JSON.stringify({
			status: 'active',
			createdById: '1',
			createdAt: '2026-09-05T08:00:00.000Z',
			stockSnapshotAt: '2026-09-05T08:00:00.000Z',
			sectionIds: [0],
			points: [{
				storeId: -100,
				storeName: 'Склад',
				status: 'in_progress',
				responsibleId: '2',
				responsibleName: 'Менеджер',
				stockSnapshot: { version: 1, capturedAt: '2026-09-05T08:00:00.000Z', lines: [[10, 3]] },
				draft: { 10: factQty },
				comments: {},
				draftSessionId: 's1',
				draftSequence: 1,
			}],
		}),
	};
}

function normalized(source: Record<string, unknown>) {
	return buildInventorySqlBackfillPlan({
		observedAt: '2026-09-05T09:00:00.000Z', sourceComplete: true, sourceRecordCount: 1, items: [source],
	}).inventories;
}

function database(read: NonNullable<DatabaseRuntime['readInventoryRecords']>): DatabaseRuntime {
	return { mode: 'readiness', readInventoryRecords: read } as DatabaseRuntime;
}

test('inventory SQL read gate defaults off, accepts shadow and rejects source modes', (t) => {
	assert.equal(loadConfig({}).inventorySqlRead, 'off');
	assert.equal(loadConfig({ B24_APP_INVENTORY_SQL_READ: 'shadow' }).inventorySqlRead, 'shadow');
	t.mock.method(console, 'error', () => {});
	assert.throws(() => loadConfig({ B24_APP_INVENTORY_SQL_READ: 'primary' }), /Bad config/);
});

test('off mode does not touch SQL and explicitly preserves the Bitrix response', async () => {
	let reads = 0;
	const report = await observeInventorySqlReadShadow('off', database(async () => { reads += 1; return []; }), [item()]);
	assert.equal(reads, 0);
	assert.deepEqual(report, {
		status: 'disabled', legacyResponsePreserved: true, responseSource: 'bitrix', sourcePlanHash: null,
		bitrixCount: 1, sqlCount: null, differences: [], issues: [],
	});
});

test('shadow mode reports exact parity without becoming a response source', async () => {
	const source = item();
	const report = await observeInventorySqlReadShadow('shadow', database(async () => normalized(source)), [source], '2026-09-05T09:00:00.000Z');
	assert.equal(report.status, 'match');
	assert.equal(report.legacyResponsePreserved, true);
	assert.equal(report.responseSource, 'bitrix');
	assert.equal(report.bitrixCount, 1);
	assert.equal(report.sqlCount, 1);
	assert.deepEqual(report.differences, []);
});

test('shadow mismatch is observable but does not replace the Bitrix response', async () => {
	const report = await observeInventorySqlReadShadow('shadow', database(async () => normalized(item(1))), [item(2)], '2026-09-05T09:00:00.000Z');
	assert.equal(report.status, 'mismatch');
	assert.equal(report.responseSource, 'bitrix');
	assert.deepEqual(report.differences, ['state_hash:42']);
});

test('malformed Bitrix source blocks comparison before SQL is read', async () => {
	let reads = 0;
	const broken = item();
	broken['DETAIL_TEXT'] = '{broken';
	const report = await observeInventorySqlReadShadow('shadow', database(async () => { reads += 1; return []; }), [broken]);
	assert.equal(reads, 0);
	assert.equal(report.status, 'plan_blocked');
	assert.ok(report.issues.includes('invalid_json:ctv_inv:42'));
});

test('SQL reader failure is isolated from the employee request', async () => {
	const report = await observeInventorySqlReadShadow('shadow', database(async () => { throw new Error('SQL down'); }), [item()]);
	assert.equal(report.status, 'error');
	assert.equal(report.responseSource, 'bitrix');
	assert.equal(report.legacyResponsePreserved, true);
});
