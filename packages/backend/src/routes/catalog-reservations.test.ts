import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReservationRuntime } from '../reservations/sql-runtime.js';
import { catalogReservations } from './catalog-reservations.js';

test('catalog reads fresh active reservations without modifying physical stock or cached rows', async () => {
	let quantity = '8.000000000';
	let reads = 0;
	const runtime = { canWrite: true, async query(work: (connection: unknown) => Promise<unknown>) {
		reads++;
		return work({ async query(sql: string) {
			assert.match(sql, /^SELECT/);
			assert.match(sql, /rl.active_qty > 0/);
			assert.match(sql, /r.status IN \('active', 'shortfall'\)/);
			assert.match(sql, /r.expires_at IS NULL OR r.expires_at > NOW\(6\)/);
			assert.doesNotMatch(sql, /UPDATE|INSERT|DELETE|FOR UPDATE/);
			return [{ item_code: '100', erp_warehouse_name: 'Warehouse - CO', quantity },
				{ item_code: '100', erp_warehouse_name: 'Other - CO', quantity: '2.5' }];
		} });
	} } as unknown as ReservationRuntime;
	const rows = [{ id: 100, total: 8, stockByStore: { 10: 8 } }, { id: 200, total: 1, stockByStore: { 10: 1 } }];
	const stores = new Map([['Warehouse - CO', 10], ['Other - CO', 11]]);
	const first = await catalogReservations(rows, runtime, stores);
	assert.deepEqual(first[0]?.reservedByStore, { 10: 8, 11: 2.5 });
	assert.equal(first[0]?.total, 8);
	assert.deepEqual(first[0]?.stockByStore, { 10: 8 });
	assert.deepEqual(first[1]?.reservedByStore, {});
	assert.equal('reservedByStore' in rows[0]!, false);
	quantity = '3';
	assert.equal((await catalogReservations(rows, runtime, stores))[0]?.reservedByStore?.[10], 3);
	assert.equal(reads, 2);
});

test('catalog skips disabled/shadow reservations and never silently turns a SQL failure into zero', async () => {
	const rows = [{ id: 100 }];
	assert.equal(await catalogReservations(rows, null, new Map()), rows);
	assert.equal(await catalogReservations(rows, { canWrite: false } as ReservationRuntime, new Map()), rows);
	await assert.rejects(catalogReservations(rows, { canWrite: true, async query() { throw new Error('offline'); } } as unknown as ReservationRuntime, new Map()), /offline/);
});
