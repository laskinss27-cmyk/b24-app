import assert from 'node:assert/strict';
import test from 'node:test';
import type { ErpClient } from '../erp/client.js';
import { withInventoryUpdateLock } from './api-inventory.js';
import { submitInventoryDocumentSet } from './api-inventory-document-submission.js';
import type { InventoryDocumentSet } from './api-inventory-document-state.js';
import { inventoryStatusForPoints, synchronizeInventoryStatus } from './api-inventory-status.js';

test('inventory updates for one record are serialized without losing another point', async () => {
	const order: string[] = [];
	let releaseFirst = (): void => undefined;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

	const first = withInventoryUpdateLock('inv-1', async () => {
		order.push('first:start');
		await firstGate;
		order.push('first:end');
	});
	const second = withInventoryUpdateLock('inv-1', async () => {
		order.push('second:start');
		order.push('second:end');
	});

	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(order, ['first:start']);
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('a failed inventory update releases the queue', async () => {
	await assert.rejects(() => withInventoryUpdateLock('inv-2', async () => { throw new Error('failed'); }), /failed/);
	const result = await withInventoryUpdateLock('inv-2', async () => 'next');
	assert.equal(result, 'next');
});

test('inventory closes only after every reconciled point has a submitted core document', () => {
	const submitted = { status: 'reconciled', result: { discrepancies: 2 }, erpDoc: { status: 'submitted' } };
	const draft = { status: 'reconciled', result: { discrepancies: 1 }, erpDoc: { status: 'draft' } };
	assert.equal(inventoryStatusForPoints([submitted]), 'closed');
	assert.equal(inventoryStatusForPoints([submitted, draft]), 'active');
	assert.equal(inventoryStatusForPoints([{ ...submitted }, { ...submitted }]), 'closed');
});

test('inventory with separate adjustment documents closes only after every required document is submitted', () => {
	const partial = {
		status: 'reconciled', result: { discrepancies: 2 },
		erpDocs: {
			issue: { name: 'STE-I', status: 'submitted' },
			receipt: { name: 'STE-R', status: 'draft' },
		},
	};
	assert.equal(inventoryStatusForPoints([partial]), 'active');
	assert.equal(inventoryStatusForPoints([{
		...partial,
		erpDocs: {
			issue: { name: 'STE-I', status: 'submitted' },
			receipt: { name: 'STE-R', status: 'submitted' },
		},
	}]), 'closed');
	assert.equal(inventoryStatusForPoints([{
		status: 'reconciled', result: { discrepancies: 1 },
		erpDocs: { issue: { name: 'STE-I', status: 'submitted' } },
	}]), 'closed');
});

test('inventory document retry skips a submitted first document after the second one fails', async () => {
	const documents: InventoryDocumentSet = {
		issue: { name: 'STE-I', status: 'draft', lines: 1 },
		receipt: { name: 'STE-R', status: 'draft', lines: 1 },
	};
	const submitted: string[] = [];
	const persisted: InventoryDocumentSet[] = [];
	let receiptFails = true;
	const erp = {
		get: async (_doctype: string, name: string) => ({ name, docstatus: 0 }),
		submit: async (_doctype: string, name: string) => {
			submitted.push(name);
			if (name === 'STE-R' && receiptFails) throw new Error('receipt failed');
		},
	} as unknown as ErpClient;
	const persist = async (state: InventoryDocumentSet) => { persisted.push(structuredClone(state)); };

	await assert.rejects(submitInventoryDocumentSet(erp, documents, persist), /receipt failed/);
	assert.equal(documents.issue?.status, 'submitted');
	assert.equal(documents.receipt?.status, 'draft');
	assert.deepEqual(persisted.map((state) => [state.issue?.status, state.receipt?.status]), [['submitted', 'draft']]);

	receiptFails = false;
	await submitInventoryDocumentSet(erp, documents, persist);
	assert.deepEqual(submitted, ['STE-I', 'STE-R', 'STE-R']);
	assert.equal(documents.receipt?.status, 'submitted');
	assert.deepEqual(persisted.map((state) => [state.issue?.status, state.receipt?.status]), [
		['submitted', 'draft'],
		['submitted', 'submitted'],
	]);
});

test('reconciled points without discrepancies close without an unnecessary document', () => {
	assert.equal(inventoryStatusForPoints([{ status: 'reconciled', result: { discrepancies: 0 } }]), 'closed');
	assert.equal(inventoryStatusForPoints([{ status: 'in_progress', result: { discrepancies: 0 } }]), 'active');
	assert.equal(inventoryStatusForPoints([]), 'active');
});

test('synchronized inventory status reopens when a point returns to work', () => {
	const data: Record<string, unknown> = { status: 'closed' };
	assert.equal(synchronizeInventoryStatus(data, [{ status: 'in_progress', erpDoc: { status: 'submitted' } }]), 'active');
	assert.equal(data['status'], 'active');
});
