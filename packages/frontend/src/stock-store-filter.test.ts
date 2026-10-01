import assert from 'node:assert/strict';
import test from 'node:test';
import { stockRouteMatchesStore } from './stock-store-filter.js';

test('store selection includes incoming and outgoing transfers, excludes other routes and does not limit old rows', () => {
	const rows = Array.from({ length: 110 }, (_, index) => ({ id: index, fromStore: 'Офис', toStore: 'Измайловский' }));
	rows[99] = { id: 99, fromStore: 'Дунайский', toStore: 'Офис' };
	rows[100] = { id: 100, fromStore: 'Офис', toStore: 'Дунайский' };
	assert.deepEqual(rows.filter((row) => stockRouteMatchesStore(row, 'Дунайский')).map((row) => row.id), [99, 100]);
	assert.equal(rows.filter((row) => stockRouteMatchesStore(row, '')).length, 110);
	assert.equal(stockRouteMatchesStore(rows[99]!, 'Дунайский 64'), false, 'exact title, no substring collision');
});

test('supply requests match destination only, including old records with an irrelevant source', () => {
	assert.equal(stockRouteMatchesStore({ kind: 'supply', fromStore: 'Дунайский', toStore: 'Офис' }, 'Дунайский'), false);
	assert.equal(stockRouteMatchesStore({ kind: 'supply', toStore: 'Дунайский' }, 'Дунайский'), true);
	assert.equal(stockRouteMatchesStore({ kind: 'transfer', fromStore: 'Дунайский', toStore: 'Офис' }, 'Дунайский'), true);
});
