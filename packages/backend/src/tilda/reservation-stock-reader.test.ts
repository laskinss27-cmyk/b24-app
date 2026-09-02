import assert from 'node:assert/strict';
import test from 'node:test';
import { readActiveTildaReservationTotals } from './reservation-stock-reader.js';

test('Tilda reservation reader aggregates only active unexpired reservations for one ERP warehouse', async () => {
	const calls: Array<{ sql: string; values?: unknown[] }> = [];
	const totals = await readActiveTildaReservationTotals({
		async query<T>(sql: string, values?: unknown[]): Promise<T> {
			calls.push({ sql, ...(values ? { values } : {}) });
			return [
				{ item_code: '18178', active_qty: '2.000000' },
				{ item_code: '18184', active_qty: 1 },
			] as T;
		},
	}, 'Shelly - УД', [18178, 18184, 18178]);

	assert.deepEqual(totals, new Map([[18178, 2], [18184, 1]]));
	assert.deepEqual(calls[0]?.values, ['Shelly - УД', '18178', '18184']);
	assert.match(calls[0]?.sql ?? '', /r\.status IN \('active', 'shortfall'\)/u);
	assert.match(calls[0]?.sql ?? '', /r\.expires_at IS NULL OR r\.expires_at > NOW\(6\)/u);
});

test('Tilda reservation reader skips SQL for an empty projection and fails closed on invalid rows', async () => {
	let called = false;
	const pool = {
		async query<T>(): Promise<T> {
			called = true;
			return [{ item_code: '999', active_qty: '1' }] as T;
		},
	};
	assert.deepEqual(await readActiveTildaReservationTotals(pool, 'Shelly - УД', []), new Map());
	assert.equal(called, false);
	await assert.rejects(
		readActiveTildaReservationTotals(pool, 'Shelly - УД', [18178]),
		/unexpected ERP Item code/u,
	);
});
