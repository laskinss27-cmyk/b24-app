import assert from 'node:assert/strict';
import test from 'node:test';
import { newTransferData, type StoredTransfer } from './model.js';
import { compareTransferSqlParity } from './sql-compare.js';

function transfer(id: number, qty = 1): StoredTransfer {
	return {
		id, name: `Перемещение #${id}`,
		...newTransferData({
			fromStore: 'А', toStore: 'Б', lines: [{ productId: 1, name: 'Товар', qty }],
			createdAt: '2026-09-02T07:00:00.000Z', createdById: '1', createdByName: 'Менеджер',
		}),
	};
}

test('transfer parity compares canonical state by external id deterministically', () => {
	assert.deepEqual(compareTransferSqlParity([transfer(2), transfer(1)], [transfer(1), transfer(2)]), {
		matches: true, legacyCount: 2, sqlCount: 2, differences: [],
	});
	const report = compareTransferSqlParity([transfer(1), transfer(2)], [transfer(2, 3), transfer(3)]);
	assert.equal(report.matches, false);
	assert.deepEqual(report.differences.map((difference) => [difference.kind, difference.externalId]), [
		['missing_in_sql', 1], ['state_mismatch', 2], ['unexpected_in_sql', 3],
	]);
});

test('transfer parity rejects duplicate identities in either source', () => {
	assert.throws(() => compareTransferSqlParity([transfer(1), transfer(1)], []), /Duplicate transfer 1/);
});

test('transfer parity treats legacy empty optional history fields as canonical absence', () => {
	const legacy = transfer(1);
	legacy.history[0]!.changes = [];
	const sql = transfer(1);
	assert.deepEqual(compareTransferSqlParity([legacy], [sql]), {
		matches: true, legacyCount: 1, sqlCount: 1, differences: [],
	});
});
