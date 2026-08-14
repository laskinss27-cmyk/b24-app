import assert from 'node:assert/strict';
import test from 'node:test';
import { withInventoryUpdateLock } from './api-inventory.js';
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
