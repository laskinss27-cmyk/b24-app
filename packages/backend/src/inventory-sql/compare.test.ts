import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInventorySqlBackfillPlan } from './backfill-plan.js';
import { compareInventorySqlParity } from './compare.js';

function inventory(id: number, title = `Ревизия ${id}`) {
	return buildInventorySqlBackfillPlan({
		observedAt: '2026-09-04T10:00:00Z', sourceComplete: true, sourceRecordCount: 1,
		items: [{ ID: id, NAME: title, DETAIL_TEXT: JSON.stringify({ status: 'active', points: [{ storeId: -id, storeName: 'Склад' }] }) }],
	}).inventories[0]!;
}

test('inventory parity compares exact normalized state hashes', () => {
	const source = [inventory(1), inventory(2)];
	assert.deepEqual(compareInventorySqlParity(source, structuredClone(source)), {
		matches: true, sourceCount: 2, storedCount: 2, differences: [], totalDifferences: 0,
	});
	const changed = inventory(2, 'Изменённая ревизия');
	const report = compareInventorySqlParity(source, [changed, inventory(3)], 2);
	assert.equal(report.matches, false);
	assert.equal(report.totalDifferences, 3);
	assert.deepEqual(report.differences, ['missing_sql_inventory:1', 'state_hash:2']);
});
