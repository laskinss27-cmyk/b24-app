import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import { createTransferData, deleteTransferData, saveTransferData } from '../routes/transfer-storage.js';
import { newTransferData, type StoredTransfer } from './model.js';
import type { TransferSqlWriteRuntime } from './sql-runtime.js';
import {
	markTransferSqlDeleted,
	normalizeTransferSqlState,
	transferSqlStateHash,
	writeTransferSqlRevision,
	type TransferSqlConnection,
	type TransferSqlPool,
} from './sql-store.js';

function storedTransfer(): StoredTransfer {
	const data = newTransferData({
		fromStore: 'Склад А',
		toStore: 'Склад Б',
		lines: [{ productId: 100, name: 'Камера', qty: 2 }],
		createdAt: '2026-09-02T10:00:00+03:00',
		createdById: '1858',
		createdByName: 'Владелец',
	});
	data.collectedLines = [{ productId: 100, name: 'Камера', qty: 2 }];
	data.shippedLines = [{ productId: 100, name: 'Камера', qty: 2 }];
	data.acceptedLines = [{ productId: 100, name: 'Камера', qty: 1 }];
	data.shortageLines = [{ productId: 100, name: 'Камера', qty: 1 }];
	data.correctionIds = [88];
	data.history.push({
		at: '2026-09-02T11:00:00+03:00', status: 'collected', byId: '9', byName: 'Кладовщик', action: 'collected',
		changes: [{ productId: 100, name: 'Камера', field: 'collected', from: 0, to: 2 }],
	});
	return { id: 7, name: 'Перемещение #7', ...data };
}

class FakeConnection implements TransferSqlConnection {
	readonly queries: Array<{ sql: string; values?: unknown[] }> = [];
	readonly batches: Array<{ sql: string; values: unknown[][] }> = [];
	currentHash: Buffer | null = null;
	failBatch = false;
	beginCount = 0;
	commitCount = 0;
	rollbackCount = 0;
	releaseCount = 0;

	async query<T = unknown>(sql: string, values?: unknown[]): Promise<T> {
		this.queries.push(values === undefined ? { sql } : { sql, values });
		if (sql.includes('SELECT id, last_state_hash')) return [{ id: 41, last_state_hash: this.currentHash }] as T;
		if (sql.includes('SELECT revision_no')) return (this.currentHash ? [{ revision_no: 3 }] : []) as T;
		if (sql.includes('INSERT INTO stock_transfer_revisions')) return { insertId: 51 } as T;
		if (sql.includes('UPDATE stock_transfer_records')) return { affectedRows: 1 } as T;
		return {} as T;
	}

	async batch(sql: string, values: unknown[][]): Promise<unknown> {
		this.batches.push({ sql, values });
		if (this.failBatch) throw new Error('child row failed');
		return {};
	}

	async beginTransaction(): Promise<void> { this.beginCount += 1; }
	async commit(): Promise<void> { this.commitCount += 1; }
	async rollback(): Promise<void> { this.rollbackCount += 1; }
	release(): void { this.releaseCount += 1; }
}

function pool(connection: FakeConnection): TransferSqlPool {
	return {
		async getConnection() { return connection; },
		async query<T = unknown>() { return [] as T; },
	};
}

test('transfer SQL writer creates one immutable revision and all normalized children atomically', async () => {
	const connection = new FakeConnection();
	const transfer = storedTransfer();
	const { id, name, ...data } = transfer;
	const result = await writeTransferSqlRevision(pool(connection), { externalId: id, name, data, sourceKind: 'bitrix_dual_write' });
	assert.equal(result.revisionNo, 1);
	assert.equal(result.alreadyCurrent, false);
	assert.match(result.stateHash, /^[a-f0-9]{64}$/);
	assert.equal(connection.beginCount, 1);
	assert.equal(connection.commitCount, 1);
	assert.equal(connection.rollbackCount, 0);
	assert.equal(connection.releaseCount, 1);
	assert.deepEqual(connection.batches.map((batch) => batch.values.length), [5, 2, 1, 1]);
	assert.ok(connection.queries.some(({ sql }) => sql.includes('INSERT INTO stock_transfer_revisions')));
	assert.ok(connection.queries.every(({ sql }) => !/\bDELETE\b/i.test(sql)));
});

test('transfer SQL writer does not create a duplicate revision for the current hash', async () => {
	const connection = new FakeConnection();
	const transfer = normalizeTransferSqlState((() => {
		const { id, name, ...data } = storedTransfer();
		return { externalId: id, name, data, sourceKind: 'bitrix_dual_write' as const };
	})());
	connection.currentHash = Buffer.from(transferSqlStateHash(transfer), 'hex');
	const { id, name, ...data } = transfer;
	const result = await writeTransferSqlRevision(pool(connection), { externalId: id, name, data, sourceKind: 'bitrix_dual_write' });
	assert.equal(result.alreadyCurrent, true);
	assert.equal(result.revisionNo, 3);
	assert.equal(connection.batches.length, 0);
	assert.equal(connection.commitCount, 1);
});

test('transfer SQL writer rolls back the whole revision when a child row fails', async () => {
	const connection = new FakeConnection();
	connection.failBatch = true;
	const { id, name, ...data } = storedTransfer();
	await assert.rejects(
		() => writeTransferSqlRevision(pool(connection), { externalId: id, name, data, sourceKind: 'bitrix_dual_write' }),
		/child row failed/,
	);
	assert.equal(connection.commitCount, 0);
	assert.equal(connection.rollbackCount, 1);
	assert.equal(connection.releaseCount, 1);
});

test('transfer deletion is a tombstone update and never physical SQL deletion', async () => {
	const connection = new FakeConnection();
	await markTransferSqlDeleted(pool(connection), { externalId: 7, name: 'Перемещение #7' });
	assert.equal(connection.commitCount, 1);
	assert.ok(connection.queries.some(({ sql }) => sql.includes('deleted_at = VALUES(deleted_at)')));
	assert.ok(connection.queries.every(({ sql }) => !/\bDELETE\b/i.test(sql)));
});

test('transfer timestamps are canonical before hashing and storage', () => {
	const { id, name, ...data } = storedTransfer();
	const normalized = normalizeTransferSqlState({ externalId: id, name, data, sourceKind: 'bitrix_backfill' });
	assert.equal(normalized.createdAt, '2026-09-02T07:00:00.000Z');
	assert.equal(normalized.history[1]?.at, '2026-09-02T08:00:00.000Z');
});

test('Bitrix transfer create, update and delete feed the SQL shadow adapter in order', async () => {
	const trace: string[] = [];
	const writer: TransferSqlWriteRuntime = {
		mode: 'shadow', enabled: true,
		async write(input) {
			trace.push(`sql-write:${input.externalId}`);
			return { externalId: input.externalId, revisionNo: 1, stateHash: '0'.repeat(64), alreadyCurrent: false };
		},
		async markDeleted(input) { trace.push(`sql-delete:${input.externalId}`); },
		async readAll() { return []; }, async read() { return null; }, async ping() {}, async close() {},
	};
	const app = {
		transferSqlWriter: writer,
		log: { debug() {}, warn() {} },
	} as unknown as FastifyInstance;
	const client = {
		async call(method: string) {
			trace.push(`bitrix:${method}`);
			return method === 'entity.item.add' ? 7 : {};
		},
	} as unknown as B24Client;
	const { name, ...withId } = storedTransfer();
	const { id: _id, ...data } = withId;
	const id = await createTransferData(app, client, name, data);
	await saveTransferData(app, client, id, name, data);
	await deleteTransferData(app, client, id, name);
	assert.deepEqual(trace, [
		'bitrix:entity.item.add', 'sql-write:7',
		'bitrix:entity.item.update', 'sql-write:7',
		'bitrix:entity.item.delete', 'sql-delete:7',
	]);
});

test('a failed shadow write does not report a false failure after Bitrix succeeded', async () => {
	let warned = 0;
	const writer: TransferSqlWriteRuntime = {
		mode: 'shadow', enabled: true,
		async write() { throw new Error('SQL unavailable'); },
		async markDeleted() { throw new Error('SQL unavailable'); },
		async readAll() { return []; }, async read() { return null; }, async ping() {}, async close() {},
	};
	const app = {
		transferSqlWriter: writer,
		log: { debug() {}, warn() { warned += 1; } },
	} as unknown as FastifyInstance;
	const client = { async call(method: string) { return method === 'entity.item.add' ? 7 : {}; } } as unknown as B24Client;
	const { name, ...withId } = storedTransfer();
	const { id: _id, ...data } = withId;
	assert.equal(await createTransferData(app, client, name, data), 7);
	await saveTransferData(app, client, 7, name, data);
	await deleteTransferData(app, client, 7, name);
	assert.equal(warned, 3);
});
