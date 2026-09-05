import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../config.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import { buildInventorySqlBackfillPlan } from './backfill-plan.js';
import { parseInventoryBitrixItem } from './model.js';
import { observeInventorySqlReadShadow, readPrimaryInventorySqlItems, resolveInventorySqlRead } from './read-shadow.js';

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

function reconciledItem(): Record<string, unknown> {
	const source = item();
	const detail = JSON.parse(String(source['DETAIL_TEXT'])) as Record<string, unknown>;
	detail['deadline'] = '2026-09-06';
	const point = (detail['points'] as Array<Record<string, unknown>>)[0]!;
	point['status'] = 'reconciled';
	point['startedAt'] = '2026-09-05T08:05:00.000Z';
	point['submittedAt'] = '2026-09-05T08:10:00.000Z';
	point['actAt'] = '2026-09-05T08:15:00.000Z';
	point['stockSnapshotMigratedAt'] = '2026-09-05T08:01:00.000Z';
	point['draftUpdatedAt'] = '2026-09-05T08:09:00.000Z';
	point['draftUpdatedById'] = '2';
	point['draftUpdatedByName'] = 'Менеджер';
	point['comments'] = { 10: 'Недостача', 11: 'Ещё не посчитан' };
	point['resultBookAt'] = '2026-09-05T08:14:00.000Z';
	point['result'] = {
		total: 2, counted: 1, discrepancies: 1,
		lines: [{ productId: 10, name: 'Товар', book: 3, fact: 2, diff: -1, comment: 'Недостача' }],
	};
	point['erpDocs'] = {
		issue: { name: 'MAT-STE-1', status: 'submitted', lines: 1, savedAt: '2026-09-05T08:16:00.000Z', submittedAt: '2026-09-05T08:17:00.000Z' },
		receipt: { name: 'MAT-STE-2', status: 'draft', lines: 1, savedAt: '2026-09-05T08:16:00.000Z' },
	};
	source['DETAIL_TEXT'] = JSON.stringify(detail);
	return source;
}

function normalized(source: Record<string, unknown>) {
	return buildInventorySqlBackfillPlan({
		observedAt: '2026-09-05T09:00:00.000Z', sourceComplete: true, sourceRecordCount: 1, items: [source],
	}).inventories;
}

function database(read: NonNullable<DatabaseRuntime['readInventoryRecords']>): DatabaseRuntime {
	return { mode: 'readiness', readInventoryRecords: read } as DatabaseRuntime;
}

test('inventory SQL read gate defaults off and accepts guarded modes', () => {
	assert.equal(loadConfig({}).inventorySqlRead, 'off');
	assert.equal(loadConfig({ B24_APP_INVENTORY_SQL_READ: 'shadow' }).inventorySqlRead, 'shadow');
	assert.equal(loadConfig({ B24_APP_INVENTORY_SQL_READ: 'verified' }).inventorySqlRead, 'verified');
	assert.equal(loadConfig({ B24_APP_INVENTORY_SQL_READ: 'primary' }).inventorySqlRead, 'primary');
});

test('primary mode reconstructs SQL records in descending external id order', async () => {
	const first = normalized(item())[0]!;
	const secondSource = item();
	secondSource['ID'] = '84';
	const second = normalized(secondSource)[0]!;
	const items = await readPrimaryInventorySqlItems(database(async () => [first, second]));
	assert.deepEqual(items.map((entry) => entry['ID']), ['84', '42']);
	for (const entry of items) {
		const parsed = parseInventoryBitrixItem(entry);
		assert.deepEqual(parsed.issues, []);
		assert.equal(parsed.inventory?.stateHash, Number(entry['ID']) === 84 ? second.stateHash : first.stateHash);
	}
});

test('primary mode fails closed when SQL is unavailable', async () => {
	await assert.rejects(() => readPrimaryInventorySqlItems(null), /reader is unavailable/);
	await assert.rejects(
		() => readPrimaryInventorySqlItems(database(async () => { throw new Error('SQL down'); })),
		/SQL down/,
	);
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

test('verified mode serves a reversible SQL reconstruction only after exact parity', async () => {
	const source = reconciledItem();
	const stored = normalized(source);
	const resolution = await resolveInventorySqlRead('verified', database(async () => stored), [source], '2026-09-05T09:00:00.000Z');
	assert.equal(resolution.report.status, 'match');
	assert.equal(resolution.report.responseSource, 'sql');
	assert.equal(resolution.report.legacyResponsePreserved, false);
	assert.notStrictEqual(resolution.items[0], source);
	const reconstructed = parseInventoryBitrixItem(resolution.items[0]!);
	assert.deepEqual(reconstructed.issues, []);
	assert.equal(reconstructed.inventory?.stateHash, stored[0]?.stateHash);
	const detail = JSON.parse(String(resolution.items[0]?.['DETAIL_TEXT'])) as Record<string, unknown>;
	const point = (detail['points'] as Array<Record<string, unknown>>)[0]!;
	assert.deepEqual(point['comments'], { 10: 'Недостача', 11: 'Ещё не посчитан' });
	assert.equal((point['result'] as Record<string, unknown>)['discrepancies'], 1);
	assert.deepEqual(Object.keys(point['erpDocs'] as Record<string, unknown>), ['issue', 'receipt']);
});

test('verified mismatch returns the original Bitrix objects unchanged', async () => {
	const source = item(2);
	const resolution = await resolveInventorySqlRead('verified', database(async () => normalized(item(1))), [source], '2026-09-05T09:00:00.000Z');
	assert.equal(resolution.report.status, 'mismatch');
	assert.equal(resolution.report.responseSource, 'bitrix');
	assert.equal(resolution.report.legacyResponsePreserved, true);
	assert.strictEqual(resolution.items[0], source);
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
	const source = item();
	const resolution = await resolveInventorySqlRead('verified', database(async () => { throw new Error('SQL down'); }), [source]);
	assert.equal(resolution.report.status, 'error');
	assert.equal(resolution.report.responseSource, 'bitrix');
	assert.equal(resolution.report.legacyResponsePreserved, true);
	assert.strictEqual(resolution.items[0], source);
});
