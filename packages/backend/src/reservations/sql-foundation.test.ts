import assert from 'node:assert/strict';
import test from 'node:test';
import {
	beginReservationCommand,
	finishReservationCommand,
	lockAvailabilityKeys,
	normalizeAvailabilityKeys,
	type ReservationSqlConnection,
	type ReservationSqlResult,
} from './sql-foundation.js';

class FakeConnection implements ReservationSqlConnection {
	readonly calls: Array<{ sql: string; values: unknown[] }> = [];
	insertAffectedRows = 1;
	commandRow: Record<string, unknown> = {
		id: 7n,
		request_hash: Buffer.alloc(32, 0xaa),
		status: 'started',
		external_doctype: null,
		external_document_name: null,
	};
	lockedRows: Array<Record<string, unknown>> = [];
	finishAffectedRows = 1;

	async query<T = unknown>(sql: string, values: unknown[] = []): Promise<T> {
		this.calls.push({ sql, values });
		if (sql.includes('INSERT IGNORE INTO stock_availability_keys')) return { affectedRows: 1 } as T;
		if (sql.includes('FROM stock_availability_keys')) return this.lockedRows as T;
		if (sql.includes('INSERT IGNORE INTO stock_reservation_commands')) return { affectedRows: this.insertAffectedRows } as T;
		if (sql.includes('FROM stock_reservation_commands')) return [this.commandRow] as T;
		if (sql.includes('UPDATE stock_reservation_commands')) return { affectedRows: this.finishAffectedRows } as T;
		return {} as T;
	}
}

test('availability locks deduplicate and use binary deterministic key order', async () => {
	const keys = normalizeAvailabilityKeys([
		{ erpWarehouseName: 'Склад Б', itemCode: '2' },
		{ erpWarehouseName: 'Склад А', itemCode: '9' },
		{ erpWarehouseName: 'Склад А', itemCode: '1' },
		{ erpWarehouseName: 'Склад А', itemCode: '1' },
	]);
	assert.deepEqual(keys, [
		{ erpWarehouseName: 'Склад А', itemCode: '1' },
		{ erpWarehouseName: 'Склад А', itemCode: '9' },
		{ erpWarehouseName: 'Склад Б', itemCode: '2' },
	]);

	const connection = new FakeConnection();
	connection.lockedRows = keys.map((key) => ({ erp_warehouse_name: key.erpWarehouseName, item_code: key.itemCode }));
	assert.deepEqual(await lockAvailabilityKeys(connection, [...keys].reverse()), keys);
	assert.match(connection.calls[0]!.sql, /INSERT IGNORE INTO stock_availability_keys/);
	assert.deepEqual(connection.calls[0]!.values, ['Склад А', '1', 'Склад А', '9', 'Склад Б', '2']);
	assert.match(connection.calls[1]!.sql, /ORDER BY erp_warehouse_name COLLATE utf8mb4_bin, item_code COLLATE utf8mb4_bin\s+FOR UPDATE/);
});

test('availability lock fails closed when a requested key is missing', async () => {
	const connection = new FakeConnection();
	await assert.rejects(
		() => lockAvailabilityKeys(connection, [{ erpWarehouseName: 'Склад', itemCode: 'CAM-1' }]),
		/Could not lock every availability key/,
	);
});

test('idempotent command starts once, reports in-progress, and replays a terminal result', async () => {
	const connection = new FakeConnection();
	const input = {
		idempotencyKey: 'approve:deal:501:rev-1',
		commandType: 'approve_reserve',
		requestHash: Buffer.alloc(32, 0xaa),
		actorId: 'supply:2',
	};
	assert.equal((await beginReservationCommand(connection, input)).disposition, 'start');

	connection.insertAffectedRows = 0;
	assert.equal((await beginReservationCommand(connection, input)).disposition, 'in_progress');
	connection.commandRow['status'] = 'applied';
	assert.equal((await beginReservationCommand(connection, input)).disposition, 'replay');
});

test('idempotency key reuse with another payload is rejected', async () => {
	const connection = new FakeConnection();
	connection.insertAffectedRows = 0;
	await assert.rejects(
		() => beginReservationCommand(connection, {
			idempotencyKey: 'approve:deal:501:rev-1',
			commandType: 'approve_reserve',
			requestHash: Buffer.alloc(32, 0xbb),
			actorId: 'supply:2',
		}),
		/Idempotency key conflicts/,
	);
});

test('command completion is guarded by its current state', async () => {
	const connection = new FakeConnection();
	await finishReservationCommand(connection, 7n, 'applied', { doctype: 'Delivery Note', documentName: 'DN-1' });
	const values = connection.calls.at(-1)!.values;
	assert.equal(values[0], 'applied');
	assert.deepEqual(values.slice(1, 3), ['Delivery Note', 'DN-1']);
	assert.ok(values[3] instanceof Date);

	connection.finishAffectedRows = 0;
	await assert.rejects(() => finishReservationCommand(connection, 7n, 'failed'), /lost optimistic ownership/);
});

test('SQL result shape remains compatible with the MariaDB connector', () => {
	const result: ReservationSqlResult = { affectedRows: 1, insertId: 7n };
	assert.equal(result.affectedRows, 1);
});
