import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalogMirrorPlan } from './plan.js';
import { catalogMirrorFixture } from './test-fixture.js';
import { applyCatalogMirrorPlan, type CatalogMirrorWriterConnection, type CatalogMirrorWriterPool } from './writer.js';

class FakeConnection implements CatalogMirrorWriterConnection {
	events: string[] = [];
	latestHash: string | null = null;
	reusableCheckpoint = false;
	failOn = '';

	async query<T = unknown>(sql: string, values?: unknown[]): Promise<T> {
		const compact = sql.replace(/\s+/g, ' ').trim();
		this.events.push(compact);
		if (compact.startsWith('SELECT GET_LOCK')) return [{ acquired: 1 }] as T;
		if (compact.startsWith('SELECT id, LOWER(HEX(snapshot_hash))')) return (this.latestHash ? [{ id: 1, snapshot_hash: this.latestHash }] : []) as T;
		if (compact.startsWith('SELECT id FROM catalog_mirror_checkpoints')) return (this.reusableCheckpoint ? [{ id: 2 }] : []) as T;
		if (compact.startsWith('UPDATE catalog_mirror_checkpoints SET last_verified_at')) return {} as T;
		if (compact.startsWith('INSERT INTO catalog_mirror_checkpoints')) return {} as T;
		if (compact.startsWith('UPDATE catalog_mirror_checkpoints SET observed_at')) return {} as T;
		if (compact.startsWith('SELECT RELEASE_LOCK')) return [{ released: 1 }] as T;
		return [] as T;
	}

	async batch(sql: string): Promise<unknown> {
		const table = /INSERT INTO ([a-z_]+)/.exec(sql)?.[1] ?? 'unknown';
		this.events.push(`batch:${table}`);
		if (table === this.failOn) throw new Error(`forced ${table} failure`);
		return {};
	}

	async beginTransaction(): Promise<void> { this.events.push('begin'); }
	async commit(): Promise<void> { this.events.push('commit'); }
	async rollback(): Promise<void> { this.events.push('rollback'); }
	release(): void { this.events.push('release'); }
}

test('catalog mirror writer publishes the checkpoint last and is idempotent', async () => {
	const connection = new FakeConnection();
	const pool = { getConnection: async () => connection } as CatalogMirrorWriterPool;
	const plan = buildCatalogMirrorPlan(catalogMirrorFixture());
	const result = await applyCatalogMirrorPlan(pool, plan);
	assert.equal(result.alreadyApplied, false);
	assert.deepEqual(result.counts, { products: 1, attributes: 1, prices: 2, warehouses: 1, stocks: 1 });
	const batches = connection.events.filter((event) => event.startsWith('batch:'));
	assert.deepEqual(batches, [
		'batch:catalog_mirror_products',
		'batch:catalog_mirror_warehouses',
		'batch:catalog_mirror_attributes',
		'batch:catalog_mirror_prices',
		'batch:catalog_mirror_stocks',
	]);
	assert.ok(connection.events.findIndex((event) => event.startsWith('INSERT INTO catalog_mirror_checkpoints')) > connection.events.indexOf('batch:catalog_mirror_stocks'));
	assert.ok(connection.events.indexOf('commit') > connection.events.findIndex((event) => event.startsWith('INSERT INTO catalog_mirror_checkpoints')));
	assert.ok(connection.events.every((event) => !/\bDELETE\b/i.test(event)));

	const replay = new FakeConnection();
	replay.latestHash = plan.snapshotHash;
	const replayResult = await applyCatalogMirrorPlan({ getConnection: async () => replay }, plan);
	assert.equal(replayResult.alreadyApplied, true);
	assert.ok(replay.events.some((event) => event.startsWith('UPDATE catalog_mirror_checkpoints SET last_verified_at')));
	assert.ok(replay.events.includes('commit'));
	assert.equal(replay.events.some((event) => event.startsWith('batch:')), false);

	const reverted = new FakeConnection();
	reverted.latestHash = 'f'.repeat(64);
	reverted.reusableCheckpoint = true;
	const revertedResult = await applyCatalogMirrorPlan({ getConnection: async () => reverted }, plan);
	assert.equal(revertedResult.alreadyApplied, false);
	assert.ok(reverted.events.some((event) => event.startsWith('batch:')));
	assert.ok(reverted.events.some((event) => event.startsWith('UPDATE catalog_mirror_checkpoints SET observed_at')));
	assert.equal(reverted.events.some((event) => event.startsWith('INSERT INTO catalog_mirror_checkpoints')), false);
});

test('catalog mirror writer rolls the whole transaction back on a child failure', async () => {
	const connection = new FakeConnection();
	connection.failOn = 'catalog_mirror_prices';
	await assert.rejects(
		() => applyCatalogMirrorPlan({ getConnection: async () => connection }, buildCatalogMirrorPlan(catalogMirrorFixture())),
		/forced catalog_mirror_prices failure/,
	);
	assert.ok(connection.events.includes('rollback'));
	assert.equal(connection.events.includes('commit'), false);
	assert.equal(connection.events.some((event) => event.startsWith('INSERT INTO catalog_mirror_checkpoints')), false);
});
