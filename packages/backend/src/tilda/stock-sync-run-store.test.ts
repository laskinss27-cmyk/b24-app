import assert from 'node:assert/strict';
import test from 'node:test';
import { TildaStockSyncRunStore, withTildaSyncLock, type TildaSyncQueryConnection } from './stock-sync-run-store.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

class FakeConnection implements TildaSyncQueryConnection {
	queries: Array<{ sql: string; values?: unknown[] }> = [];
	released = false;
	lock = 1;
	latest: Array<Record<string, unknown>> = [];
	affectedRows = 1;

	async query<T>(sql: string, values?: unknown[]): Promise<T> {
		this.queries.push(values === undefined ? { sql } : { sql, values });
		if (sql.includes('GET_LOCK')) return [{ acquired: this.lock }] as T;
		if (sql.includes('SELECT status')) return this.latest as T;
		if (sql.includes('UPDATE tilda_stock_sync_runs') && sql.includes('WHERE run_uuid')) {
			return { affectedRows: this.affectedRows } as T;
		}
		return { affectedRows: 1 } as T;
	}

	release(): void { this.released = true; }
}

const metrics = {
	projectionHash: HASH_A,
	contentHashBefore: HASH_B,
	targetCount: 132,
	differenceCountBefore: 3,
	blockedCount: 2,
};

test('Tilda sync lock is connection scoped and always released', async () => {
	const connection = new FakeConnection();
	const result = await withTildaSyncLock({ getConnection: async () => connection }, async () => 'done');
	assert.deepEqual(result, { acquired: true, value: 'done' });
	assert.match(connection.queries.at(-1)?.sql ?? '', /RELEASE_LOCK/u);
	assert.equal(connection.released, true);
});

test('Tilda sync does no work when the SQL lock is held', async () => {
	const connection = new FakeConnection();
	connection.lock = 0;
	let called = false;
	const result = await withTildaSyncLock({ getConnection: async () => connection }, async () => { called = true; });
	assert.deepEqual(result, { acquired: false });
	assert.equal(called, false);
	assert.equal(connection.queries.some(({ sql }) => sql.includes('RELEASE_LOCK')), false);
	assert.equal(connection.released, true);
});

test('Tilda sync audit starts and finalizes a verified run', async () => {
	const connection = new FakeConnection();
	const store = new TildaStockSyncRunStore(connection);
	const runUuid = await store.start('scheduled', metrics);
	assert.match(runUuid, /^[a-f0-9-]{36}$/u);
	await store.finishVerified(runUuid, {
		contentHashAfter: HASH_B,
		differenceCountAfter: 0,
		catalogXmlHash: HASH_A,
		projectionXmlHash: HASH_B,
		rollbackXmlHash: HASH_A,
	});
	assert.equal(connection.queries.length, 2);
	assert.match(connection.queries[0]?.sql ?? '', /INSERT INTO tilda_stock_sync_runs/u);
	assert.match(connection.queries[1]?.sql ?? '', /status = 'verified'/u);
});

test('identical successful no-op is not written every two minutes', async () => {
	const connection = new FakeConnection();
	connection.latest = [{ status: 'verified', projection_hash: HASH_A, content_hash: HASH_B }];
	const store = new TildaStockSyncRunStore(connection);
	assert.equal(await store.recordNoopIfChanged('scheduled', { ...metrics, differenceCountBefore: 0 }), false);
	assert.equal(connection.queries.length, 1);
	connection.latest = [{ status: 'failed', projection_hash: null, content_hash: null }];
	assert.equal(await store.recordNoopIfChanged('scheduled', { ...metrics, differenceCountBefore: 0 }), true);
	assert.equal(connection.queries.length, 3);
});

test('audit errors redact credentials and interrupted runs are closed', async () => {
	const connection = new FakeConnection();
	const store = new TildaStockSyncRunStore(connection);
	await store.recoverInterruptedRuns();
	await store.recordPreparationFailure('manual', new Error('token=secret https://private.example/path'));
	const values = connection.queries[1]?.values ?? [];
	assert.equal(String(values.at(-1)).includes('secret'), false);
	assert.equal(String(values.at(-1)).includes('private.example'), false);
	assert.match(connection.queries[0]?.sql ?? '', /status = 'running'/u);
});
