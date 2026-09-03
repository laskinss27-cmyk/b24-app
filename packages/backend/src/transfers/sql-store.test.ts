import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import { createTransferData, deleteTransferData, loadTransfer, loadTransfers, saveTransferData } from '../routes/transfer-storage.js';
import { newTransferData, parseTransferItem, type StoredTransfer } from './model.js';
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
		changes: [
			{ productId: 100, name: 'Камера', field: 'collected', from: 0, to: 2 },
			{ productId: 100, name: 'Камера', field: 'planned', from: '', to: 2 },
		],
	});
	return { id: 7, name: 'Перемещение #7', ...data };
}

class FakeConnection implements TransferSqlConnection {
	readonly queries: Array<{ sql: string; values?: unknown[] }> = [];
	readonly batches: Array<{ sql: string; values: unknown[][] }> = [];
	currentHash: Buffer | null = null;
	currentFormatVersion = 2;
	failBatch = false;
	beginCount = 0;
	commitCount = 0;
	rollbackCount = 0;
	releaseCount = 0;

	async query<T = unknown>(sql: string, values?: unknown[]): Promise<T> {
		this.queries.push(values === undefined ? { sql } : { sql, values });
		if (sql.includes('SELECT public_id, legacy_bitrix_external_id')) return [{ public_id: 7, legacy_bitrix_external_id: 7 }] as T;
		if (sql.includes('SELECT id, public_id, last_state_hash')) return [{ id: 41, public_id: 7, last_state_hash: this.currentHash }] as T;
		if (sql.includes('SELECT id, revision_no')) return (this.currentHash ? [{ id: 50, revision_no: 3, state_format_version: this.currentFormatVersion }] : []) as T;
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
	assert.equal(result.revisionId, 51);
	assert.equal(result.alreadyCurrent, false);
	assert.match(result.stateHash, /^[a-f0-9]{64}$/);
	assert.equal(connection.beginCount, 1);
	assert.equal(connection.commitCount, 1);
	assert.equal(connection.rollbackCount, 0);
	assert.equal(connection.releaseCount, 1);
	assert.deepEqual(connection.batches.map((batch) => batch.values.length), [5, 2, 2, 1]);
	assert.deepEqual(connection.batches[2]?.values[0]?.slice(-4), ['0', 'number', '2', 'number']);
	assert.deepEqual(connection.batches[2]?.values[1]?.slice(-4), ['', 'string', '2', 'number']);
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

test('transfer SQL writer upgrades a legacy untyped revision without deleting it', async () => {
	const connection = new FakeConnection();
	const transfer = normalizeTransferSqlState((() => {
		const { id, name, ...data } = storedTransfer();
		return { externalId: id, name, data, sourceKind: 'bitrix_backfill' as const };
	})());
	connection.currentHash = Buffer.from(transferSqlStateHash(transfer), 'hex');
	connection.currentFormatVersion = 1;
	const { id, name, ...data } = transfer;
	const result = await writeTransferSqlRevision(pool(connection), { externalId: id, name, data, sourceKind: 'repair' });
	assert.equal(result.alreadyCurrent, false);
	assert.equal(result.revisionNo, 4);
	assert.ok(connection.queries.some(({ sql }) => sql.includes('INSERT INTO stock_transfer_revisions')));
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
	data.history.push({ at: '', status: 'draft', byId: '1', byName: '', note: '', changes: [] });
	const normalized = normalizeTransferSqlState({ externalId: id, name, data, sourceKind: 'bitrix_backfill' });
	assert.equal(normalized.createdAt, '2026-09-02T07:00:00.000Z');
	assert.equal(normalized.history[1]?.at, '2026-09-02T08:00:00.000Z');
	assert.deepEqual(normalized.history[2], { at: '', status: 'draft', byId: '1' });
});

test('Bitrix transfer create, update and delete feed the SQL shadow adapter in order', async () => {
	const trace: string[] = [];
	const writer: TransferSqlWriteRuntime = {
		mode: 'shadow', enabled: true,
		async write(input) {
			trace.push(`sql-write:${input.externalId}`);
			return { externalId: input.externalId, revisionId: 1, revisionNo: 1, stateHash: '0'.repeat(64), alreadyCurrent: false };
		},
		async createNative() { throw new Error('unused'); }, async updateNative() { throw new Error('unused'); },
		async pendingMirrors() { return []; }, async claimMirror() { throw new Error('unused'); }, async bitrixExternalId() { return null; },
		async markMirrorDelivered() {}, async recordMirrorFailure() {},
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
	const { id } = await createTransferData(app, client, name, data);
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
		async createNative() { throw new Error('unused'); }, async updateNative() { throw new Error('unused'); },
		async pendingMirrors() { return []; }, async claimMirror() { throw new Error('unused'); }, async bitrixExternalId() { return null; },
		async markMirrorDelivered() {}, async recordMirrorFailure() {},
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
	assert.deepEqual(await createTransferData(app, client, name, data), { id: 7, alreadyApplied: false });
	await saveTransferData(app, client, 7, name, data);
	await deleteTransferData(app, client, 7, name);
	assert.equal(warned, 3);
});

test('Bitrix compatibility mirrors expose the SQL public number to every legacy parser', () => {
	const { id: _id, name, ...data } = storedTransfer();
	const parsed = parseTransferItem({ ID: 900, NAME: name, DETAIL_TEXT: JSON.stringify({ ...data, sqlPublicId: 42 }) });
	assert.equal(parsed?.id, 42);
});

test('SQL-primary create commits the document before its recoverable Bitrix mirror', async () => {
	const trace: string[] = [];
	const writer: TransferSqlWriteRuntime = {
		mode: 'primary', enabled: true,
		async write() { throw new Error('unused'); },
		async createNative() {
			trace.push('sql-create');
			return { publicId: 42, revisionId: 71, revisionNo: 1, stateHash: '1'.repeat(64), alreadyCurrent: false, alreadyApplied: false };
		},
		async updateNative() { throw new Error('unused'); },
		async pendingMirrors() { return []; },
		async claimMirror() { trace.push('sql-claim'); return true; },
		async bitrixExternalId() { trace.push('sql-identity'); return null; },
		async markMirrorDelivered(input) { trace.push(`sql-delivered:${input.bitrixExternalId}`); },
		async recordMirrorFailure() { trace.push('sql-failed'); },
		async markDeleted() { throw new Error('unused'); }, async readAll() { return []; }, async read() { return null; },
		async ping() {}, async close() {},
	};
	const app = { transferSqlWriter: writer, log: { debug() {}, warn() {} } } as unknown as FastifyInstance;
	const client = {
		async call(method: string, params: Record<string, unknown>) {
			trace.push(`bitrix:${method}`);
			if (method === 'entity.item.add') {
				const detail = JSON.parse(String(params['DETAIL_TEXT'])) as Record<string, unknown>;
				assert.equal(detail['sqlPublicId'], 42);
				return 900;
			}
			return {};
		},
		async callWithMeta() { trace.push('bitrix:scan'); return { result: [] }; },
	} as unknown as B24Client;
	const { name, ...withId } = storedTransfer();
	const { id: _id, ...data } = withId;
	assert.deepEqual(await createTransferData(app, client, name, data, 'test:create:42'), { id: 42, alreadyApplied: false });
	assert.deepEqual(trace, ['sql-create', 'sql-claim', 'sql-identity', 'bitrix:scan', 'bitrix:entity.item.add', 'sql-delivered:900']);
});

test('SQL-primary create stays successful when Bitrix is down and leaves the outbox pending', async () => {
	let recorded = '';
	const writer: TransferSqlWriteRuntime = {
		mode: 'primary', enabled: true,
		async write() { throw new Error('unused'); },
		async createNative() {
			return { publicId: 42, revisionId: 71, revisionNo: 1, stateHash: '1'.repeat(64), alreadyCurrent: false, alreadyApplied: false };
		},
		async updateNative() { throw new Error('unused'); },
		async pendingMirrors() { return []; },
		async claimMirror() { return true; },
		async bitrixExternalId() { return null; }, async markMirrorDelivered() { throw new Error('unused'); },
		async recordMirrorFailure(input) { recorded = input.error; },
		async markDeleted() { throw new Error('unused'); }, async readAll() { return []; }, async read() { return null; },
		async ping() {}, async close() {},
	};
	const app = { transferSqlWriter: writer, log: { debug() {}, warn() {} } } as unknown as FastifyInstance;
	const client = {
		async call() { throw new Error('Bitrix unavailable'); },
		async callWithMeta() { throw new Error('Bitrix unavailable'); },
	} as unknown as B24Client;
	const { name, ...withId } = storedTransfer();
	const { id: _id, ...data } = withId;
	assert.deepEqual(await createTransferData(app, client, name, data, 'test:create:42'), { id: 42, alreadyApplied: false });
	assert.match(recorded, /Bitrix unavailable/);
});

test('SQL-primary retry discovers its public marker and updates instead of duplicating a Bitrix mirror', async () => {
	const calls: string[] = [];
	const writer: TransferSqlWriteRuntime = {
		mode: 'primary', enabled: true, async write() { throw new Error('unused'); },
		async createNative() {
			return { publicId: 42, revisionId: 71, revisionNo: 1, stateHash: '1'.repeat(64), alreadyCurrent: true, alreadyApplied: true };
		},
		async updateNative() { throw new Error('unused'); },
		async pendingMirrors() { return [{ publicId: 42, bitrixExternalId: null, revisionId: 71, attemptCount: 1 }]; },
		async claimMirror() { return true; },
		async bitrixExternalId() { return null; },
		async markMirrorDelivered(input) { calls.push(`delivered:${input.bitrixExternalId}`); },
		async recordMirrorFailure() { throw new Error('unexpected'); }, async markDeleted() { throw new Error('unused'); },
		async readAll() { return []; }, async read() { return { ...storedTransfer(), id: 42 }; }, async ping() {}, async close() {},
	};
	const { id: _id, name, ...data } = storedTransfer();
	const app = { transferSqlWriter: writer, log: { debug() {}, warn() {} } } as unknown as FastifyInstance;
	const client = {
		async call(method: string, params: Record<string, unknown>) { calls.push(`${method}:${String(params['ID'] ?? '')}`); return {}; },
		async callWithMeta() {
			return { result: [{ ID: 900, NAME: name, DETAIL_TEXT: JSON.stringify({ ...data, sqlPublicId: 42 }) }] };
		},
	} as unknown as B24Client;
	assert.deepEqual(await createTransferData(app, client, name, data, 'test:create:42'), { id: 42, alreadyApplied: true });
	assert.deepEqual(calls, ['entity.item.update:900', 'delivered:900']);
});

function transferReadApp(
	mode: 'off' | 'shadow' | 'verified' | 'primary',
	sqlTransfers: StoredTransfer[] | Error,
): FastifyInstance {
	const databaseRuntime: DatabaseRuntime = {
		mode: 'readiness',
		async ping() {},
		async readLatestSupplyMirrorSnapshot() { return null; },
		async readCurrentTransfer(externalId) {
			if (sqlTransfers instanceof Error) throw sqlTransfers;
			return sqlTransfers.find((transfer) => transfer.id === externalId) ?? null;
		},
		async readCurrentTransfers() {
			if (sqlTransfers instanceof Error) throw sqlTransfers;
			return sqlTransfers;
		},
		async close() {},
	};
	return {
		config: { transferSqlRead: mode },
		databaseRuntime,
		log: { info() {}, warn() {} },
	} as unknown as FastifyInstance;
}

function transferReadClient(transfers: StoredTransfer[]): B24Client {
	const items = transfers.map(({ id, name, ...data }) => ({ ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) }));
	return {
		async call(_method: string, params: Record<string, unknown>) {
			const id = Number((params['FILTER'] as Record<string, unknown> | undefined)?.['ID']);
			return id ? items.filter((item) => item.ID === id) : items;
		},
		async callWithMeta() { return { result: items }; },
	} as unknown as B24Client;
}

test('verified transfer reads return canonical SQL only after exact live parity', async () => {
	const legacy = storedTransfer();
	legacy.history[0]!.changes = [];
	const sql = normalizeTransferSqlState((() => {
		const { id, name, ...data } = legacy;
		return { externalId: id, name, data, sourceKind: 'bitrix_backfill' as const };
	})());
	const app = transferReadApp('verified', [sql]);
	const client = transferReadClient([legacy]);
	const single = await loadTransfer(app, client, legacy.id);
	assert.ok(single);
	assert.equal('changes' in single.history[0]!, false);
	assert.deepEqual((await loadTransfers(app, client)).map((transfer) => transfer.id), [legacy.id]);
});

test('verified transfer reads preserve Bitrix on mismatch or SQL failure', async () => {
	const legacy = storedTransfer();
	const mismatch = structuredClone(legacy);
	mismatch.lines[0]!.qty += 1;
	const client = transferReadClient([legacy]);
	assert.equal((await loadTransfer(transferReadApp('verified', [mismatch]), client, legacy.id))?.lines[0]?.qty, 2);
	assert.equal((await loadTransfer(transferReadApp('verified', new Error('SQL unavailable')), client, legacy.id))?.lines[0]?.qty, 2);
});

test('shadow transfer reads compare SQL but always preserve the Bitrix object form', async () => {
	const legacy = storedTransfer();
	legacy.history[0]!.changes = [];
	const sql = normalizeTransferSqlState((() => {
		const { id, name, ...data } = legacy;
		return { externalId: id, name, data, sourceKind: 'bitrix_backfill' as const };
	})());
	const result = await loadTransfer(transferReadApp('shadow', [sql]), transferReadClient([legacy]), legacy.id);
	assert.ok(result);
	assert.deepEqual(result.history[0]?.changes, []);
});

test('primary transfer reads use SQL without touching Bitrix', async () => {
	const sql = storedTransfer();
	const client = {
		async call() { throw new Error('Bitrix must not be read'); },
		async callWithMeta() { throw new Error('Bitrix must not be read'); },
	} as unknown as B24Client;
	assert.equal((await loadTransfer(transferReadApp('primary', [sql]), client, sql.id))?.id, sql.id);
	assert.deepEqual((await loadTransfers(transferReadApp('primary', [sql]), client)).map((item) => item.id), [sql.id]);
});

test('primary transfer fallback recovers the public number from the Bitrix compatibility marker', async () => {
	const legacy = storedTransfer();
	const { id: _id, name, ...data } = legacy;
	const item = { ID: 900, NAME: name, DETAIL_TEXT: JSON.stringify({ ...data, sqlPublicId: 42 }) };
	const client = {
		async call() { return []; },
		async callWithMeta() { return { result: [item] }; },
	} as unknown as B24Client;
	assert.equal((await loadTransfer(transferReadApp('primary', new Error('SQL unavailable')), client, 42))?.id, 42);
	assert.deepEqual((await loadTransfers(transferReadApp('primary', new Error('SQL unavailable')), client)).map((transfer) => transfer.id), [42]);
});
