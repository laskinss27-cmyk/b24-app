import assert from 'node:assert/strict';
import test from 'node:test';
import { backfillTildaProductMappings, type TildaMappingBackfillConnection } from './product-mapping-backfill.js';
import type { TildaProductMappingSeedRow } from './product-mapping-seed.js';

const row = (patch: Partial<TildaProductMappingSeedRow> = {}): TildaProductMappingSeedRow => ({
	tildaUid: 'uid-1',
	tildaExternalId: 'external-1',
	tildaSku: 'old-1',
	tildaTitle: 'Product',
	rowKind: 'parent',
	parentTildaUid: null,
	variantLabel: null,
	erpItemCode: '18178',
	mappingStatus: 'confirmed',
	auditSource: 'test',
	sourceSeenAt: '2026-08-20 11:04:00.000000',
	confirmedAt: '2026-08-21 13:38:53.246000',
	...patch,
});

class FakeConnection implements TildaMappingBackfillConnection {
	readonly calls: string[] = [];
	readonly batches: unknown[][][] = [];
	existing: Array<Record<string, unknown>> = [];
	transaction = false;
	committed = false;
	rolledBack = false;

	async query<T>(sql: string): Promise<T> {
		this.calls.push(sql);
		if (sql.includes('GET_LOCK')) return [{ acquired: 1 }] as T;
		if (sql.includes('FROM tilda_product_mappings')) return this.existing as T;
		if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }] as T;
		throw new Error(`Unexpected query: ${sql}`);
	}

	async batch(_sql: string, values: unknown[][]): Promise<void> { this.batches.push(values); }
	async beginTransaction(): Promise<void> { this.transaction = true; }
	async commit(): Promise<void> { this.committed = true; this.transaction = false; }
	async rollback(): Promise<void> { this.rolledBack = true; this.transaction = false; }
}

test('Tilda mapping backfill is locked, transactional and idempotent-upsert shaped', async () => {
	const connection = new FakeConnection();
	const result = await backfillTildaProductMappings(connection, [
		row(),
		row({ tildaUid: 'uid-2', tildaExternalId: 'external-2', tildaSku: 'old-2', erpItemCode: null, mappingStatus: 'ignored', confirmedAt: null }),
	]);
	assert.deepEqual(result, { rows: 2, confirmed: 1, ignored: 1, unresolved: 0 });
	assert.equal(connection.committed, true);
	assert.equal(connection.rolledBack, false);
	assert.equal(connection.batches[0]?.length, 2);
	assert.ok(connection.calls.some((sql) => sql.includes('GET_LOCK')));
	assert.ok(connection.calls.some((sql) => sql.includes('RELEASE_LOCK')));
});

test('Tilda mapping backfill refuses an existing UID/External ID conflict before DML', async () => {
	const connection = new FakeConnection();
	connection.existing = [{ tilda_uid: 'uid-1', tilda_external_id: 'different-external' }];
	await assert.rejects(() => backfillTildaProductMappings(connection, [row()]), /identity conflicts/u);
	assert.equal(connection.batches.length, 0);
	assert.equal(connection.committed, false);
	assert.ok(connection.calls.some((sql) => sql.includes('RELEASE_LOCK')));
});
