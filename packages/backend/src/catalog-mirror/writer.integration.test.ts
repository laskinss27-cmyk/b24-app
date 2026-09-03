import assert from 'node:assert/strict';
import test from 'node:test';
import mariadb from 'mariadb';
import { buildCatalogMirrorPlan } from './plan.js';
import { readLatestCatalogMirrorPlan } from './reader.js';
import { catalogMirrorFixture } from './test-fixture.js';
import { applyCatalogMirrorPlan } from './writer.js';

const enabled = process.env['CATALOG_MIRROR_INTEGRATION'] === '1';

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for catalog mirror integration test`);
	return value;
}

test('catalog mirror publishes and rereads atomic snapshots in MariaDB, including a prior-state reversion', { skip: !enabled }, async () => {
	const pool = mariadb.createPool({
		host: requiredEnv('B24_APP_DB_HOST'),
		port: Number(requiredEnv('B24_APP_DB_PORT')),
		database: requiredEnv('B24_APP_DB_NAME'),
		user: requiredEnv('B24_APP_CATALOG_SYNC_DB_USER'),
		password: requiredEnv('B24_APP_CATALOG_SYNC_DB_PASSWORD'),
		connectionLimit: 2,
	});
	try {
		const original = catalogMirrorFixture();
		const first = buildCatalogMirrorPlan(original);
		assert.equal((await applyCatalogMirrorPlan(pool, first)).alreadyApplied, false);
		assert.equal((await applyCatalogMirrorPlan(pool, first)).alreadyApplied, true);
		assert.equal((await readLatestCatalogMirrorPlan(pool))?.snapshotHash, first.snapshotHash);

		const changedSnapshot = catalogMirrorFixture();
		changedSnapshot.observedAt = '2026-09-03T16:01:00.000Z';
		changedSnapshot.products[0]!.itemName = 'Монитор изменённый';
		const changed = buildCatalogMirrorPlan(changedSnapshot);
		assert.equal((await applyCatalogMirrorPlan(pool, changed)).alreadyApplied, false);
		assert.equal((await readLatestCatalogMirrorPlan(pool))?.products[0]?.itemName, 'Монитор изменённый');

		const revertedSnapshot = catalogMirrorFixture();
		revertedSnapshot.observedAt = '2026-09-03T16:02:00.000Z';
		const reverted = buildCatalogMirrorPlan(revertedSnapshot);
		assert.equal(reverted.snapshotHash, first.snapshotHash);
		assert.equal((await applyCatalogMirrorPlan(pool, reverted)).alreadyApplied, false);
		const stored = await readLatestCatalogMirrorPlan(pool);
		assert.equal(stored?.snapshotHash, first.snapshotHash);
		assert.equal(stored?.products[0]?.itemName, 'Монитор');
		const checkpointRows = await pool.query<Array<{ count: bigint }>>('SELECT COUNT(*) AS count FROM catalog_mirror_checkpoints');
		assert.equal(Number(checkpointRows[0]?.count), 2);
	} finally {
		await pool.end();
	}
});
