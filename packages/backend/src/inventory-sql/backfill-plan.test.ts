import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInventorySqlBackfillPlan } from './backfill-plan.js';
import { parseInventoryBitrixItem } from './model.js';

function activeInventoryItem(): Record<string, unknown> {
	return {
		ID: '21664',
		NAME: 'Ревизия рабочего дня',
		CREATED_BY: '1858',
		DATE_CREATE: '2026-09-04T08:00:00.000Z',
		DETAIL_TEXT: JSON.stringify({
			status: 'active',
			deadline: '2026-09-05',
			createdById: '1858',
			createdAt: '2026-09-04T08:00:00.000Z',
			stockSnapshotAt: '2026-09-04T08:00:00.000Z',
			sectionIds: [4, 9],
			points: [{
				storeId: -1366325545,
				storeName: 'Main',
				status: 'in_progress',
				responsibleId: '986',
				responsibleName: 'Сотрудник',
				startedAt: '2026-09-04T08:02:00.000Z',
				stockSnapshot: { version: 1, capturedAt: '2026-09-04T08:00:00.000Z', lines: [[11962, 3], [13017, 2]] },
				draft: { 11962: 2 },
				comments: { 11962: 'Одной не хватает', 13017: 'Коробка вскрыта, ещё не считал' },
				draftUpdatedAt: '2026-09-04T08:05:00.000Z',
				draftUpdatedById: '986',
				draftUpdatedByName: 'Сотрудник',
				draftSessionId: 'browser-session-1',
				draftSequence: 7,
			}],
		}),
	};
}

test('active inventory draft is normalized without turning unfilled stock into zero', () => {
	const parsed = parseInventoryBitrixItem(activeInventoryItem());
	assert.deepEqual(parsed.issues, []);
	assert.ok(parsed.inventory);
	const point = parsed.inventory.points[0]!;
	assert.deepEqual(point.snapshotLines, [
		{ productId: 11962, bookQty: 3 },
		{ productId: 13017, bookQty: 2 },
	]);
	assert.deepEqual(point.countLines, [
		{ productId: 11962, factQty: 2, comment: 'Одной не хватает' },
		{ productId: 13017, factQty: null, comment: 'Коробка вскрыта, ещё не считал' },
	]);
	assert.equal(point.draftSessionId, 'browser-session-1');
	assert.equal(point.draftSequence, 7);
	assert.equal(point.resultTotal, null);
	assert.equal(point.erpDocuments.length, 0);
});

test('submitted result and both split ERP documents survive normalization', () => {
	const item = activeInventoryItem();
	const data = JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown>;
	const point = (data['points'] as Array<Record<string, unknown>>)[0]!;
	point['status'] = 'reconciled';
	point['submittedAt'] = '2026-09-04T09:00:00.000Z';
	point['resultBookAt'] = '2026-09-04T08:59:00.000Z';
	point['result'] = {
		total: 2,
		counted: 2,
		discrepancies: 2,
		lines: [
			{ productId: 11962, name: 'Монтажная коробка', book: 3, fact: 2, diff: -1, comment: 'Недостача' },
			{ productId: 13017, name: 'Монитор', book: 2, fact: 4, diff: 2 },
		],
	};
	point['erpDocs'] = {
		issue: { name: 'MAT-STE-2026-00419', status: 'submitted', lines: 1, savedAt: '2026-09-04T09:05:00.000Z', submittedAt: '2026-09-04T09:06:00.000Z' },
		receipt: { name: 'MAT-STE-2026-00420', status: 'draft', lines: 1, savedAt: '2026-09-04T09:05:00.000Z' },
	};
	item['DETAIL_TEXT'] = JSON.stringify(data);
	const parsed = parseInventoryBitrixItem(item);
	assert.deepEqual(parsed.issues, []);
	const normalized = parsed.inventory!.points[0]!;
	assert.equal(normalized.resultLines.length, 2);
	assert.equal(normalized.resultBookAt, '2026-09-04T08:59:00.000Z');
	assert.deepEqual(normalized.erpDocuments.map((document) => [document.kind, document.erpDoctype, document.status]), [
		['issue', 'Stock Entry', 'submitted'],
		['receipt', 'Stock Entry', 'draft'],
	]);
});

test('backfill plan is deterministic and blocks malformed or incomplete sources', () => {
	const first = buildInventorySqlBackfillPlan({
		observedAt: '2026-09-04T10:00:00.000Z', sourceComplete: true, sourceRecordCount: 1, items: [activeInventoryItem()],
	});
	const second = buildInventorySqlBackfillPlan({
		observedAt: '2026-09-04T10:05:00.000Z', sourceComplete: true, sourceRecordCount: 1, items: [activeInventoryItem()],
	});
	assert.equal(first.readyToApply, true);
	assert.equal(first.planHash, second.planHash);
	assert.deepEqual(first.counts, { inventories: 1, points: 1, sections: 2, snapshotLines: 2, countLines: 2, resultLines: 0, erpDocuments: 0 });

	const broken = activeInventoryItem();
	broken['DETAIL_TEXT'] = '{broken';
	const blocked = buildInventorySqlBackfillPlan({
		observedAt: 'bad-date', sourceComplete: false, sourceRecordCount: 2, items: [broken],
	});
	assert.equal(blocked.readyToApply, false);
	assert.ok(blocked.issues.some((entry) => entry.code === 'invalid_json'));
	assert.ok(blocked.issues.some((entry) => entry.code === 'incomplete_source'));
	assert.ok(blocked.issues.some((entry) => entry.code === 'source_count_mismatch'));
	assert.ok(blocked.issues.some((entry) => entry.code === 'parsed_count_mismatch'));
});

test('unknown legacy fields fail closed instead of being silently discarded', () => {
	const item = activeInventoryItem();
	const data = JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown>;
	(data['points'] as Array<Record<string, unknown>>)[0]!['mysteryValue'] = 123;
	item['DETAIL_TEXT'] = JSON.stringify(data);
	const parsed = parseInventoryBitrixItem(item);
	assert.ok(parsed.issues.some((entry) => entry.code === 'unknown_field' && entry.identity.endsWith('.mysteryValue')));
});

test('root catalog section zero is preserved as an explicit legacy scope', () => {
	const item = activeInventoryItem();
	const data = JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown>;
	data['sectionIds'] = [0];
	item['DETAIL_TEXT'] = JSON.stringify(data);
	const parsed = parseInventoryBitrixItem(item);
	assert.deepEqual(parsed.issues, []);
	assert.deepEqual(parsed.inventory?.sectionIds, [0]);
});
