import assert from 'node:assert/strict';
import test from 'node:test';
import type { ErpClient } from '../erp/client.js';
import { readRepairStockDocuments } from './repair-diagnostics-readers.js';

test('repair documents load full child rows when Frappe list returns only their names', async () => {
	const calls: string[] = [];
	const erp = {
		list: async (doctype: string) => {
			calls.push(`list:${doctype}`);
			return doctype === 'Purchase Receipt Item' ? [{ name: 'child-1' }, { name: 'child-2' }] : [];
		},
		get: async (doctype: string, name: string) => {
			calls.push(`get:${doctype}:${name}`);
			if (doctype === 'Purchase Receipt Item') {
				return { parent: 'MAT-PRE-0001', qty: 1, warehouse: 'Измайловский 18Д - UD' };
			}
			if (doctype === 'Purchase Receipt') {
				return { docstatus: 1, posting_date: '2026-08-12', posting_time: '10:30:00', creation: '2026-08-12 10:29:00' };
			}
			return null;
		},
	} as unknown as ErpClient;

	const documents = await readRepairStockDocuments(erp, 'REPAIR-142');

	assert.deepEqual(documents, [{
		type: 'Purchase Receipt',
		name: 'MAT-PRE-0001',
		docstatus: 1,
		postingDate: '2026-08-12 10:30:00',
		creation: '2026-08-12 10:29:00',
		qty: 1,
		fromStore: '',
		toStore: 'Измайловский 18Д',
		dealId: '',
	}]);
	assert.deepEqual(calls, [
		'list:Purchase Receipt Item',
		'get:Purchase Receipt Item:child-1',
		'get:Purchase Receipt:MAT-PRE-0001',
		'get:Purchase Receipt Item:child-2',
		'list:Stock Entry Detail',
		'list:Delivery Note Item',
	]);
});
