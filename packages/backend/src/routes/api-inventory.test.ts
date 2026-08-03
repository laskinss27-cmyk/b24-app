import assert from 'node:assert/strict';
import test from 'node:test';
import { withInventoryUpdateLock } from './api-inventory.js';

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
