import assert from 'node:assert/strict';
import test from 'node:test';
import { supplyMirrorSourceHash } from './supply-backfill-plan.js';
import type { SupplyMirrorPlan } from './supply-backfill-types.js';
import {
	applySupplyMirrorPlan,
	type SupplyMirrorWriterConnection,
	type SupplyMirrorWriterPool,
} from './supply-mirror-writer.js';

const observedAt = '2026-08-21T07:30:00.000Z';
const requestIdentity = 'erpnext:supply_request:MR-1';
const purchaseIdentity = 'erpnext:purchase_order:PO-1';
const requestLineIdentity = `${requestIdentity}:key:MRI-1`;
const purchaseLineIdentity = `${purchaseIdentity}:key:POI-1`;

function readyPlan(): SupplyMirrorPlan {
	return {
		readyToApply: true,
		observedAt,
		sourceStatus: {
			erpnext: { complete: true, records: 2 },
			bitrixTransfers: { complete: true, records: 0 },
			bitrixTransferRequests: { complete: true, records: 0 },
		},
		documents: [
			{
				identity: requestIdentity,
				externalSystem: 'erpnext',
				documentType: 'supply_request',
				externalId: 'MR-1',
				externalRevisionKey: 'MR-1@created',
				externalStatus: 'Pending',
				externalDocstatus: 0,
				bitrixDealId: 42,
				sourceCreatedAt: '2026-08-21 07:00:00.123456',
				sourceModifiedAt: null,
				observedAt,
				sourceHash: supplyMirrorSourceHash({ name: 'MR-1' }),
			},
			{
				identity: purchaseIdentity,
				externalSystem: 'erpnext',
				documentType: 'purchase_order',
				externalId: 'PO-1',
				externalRevisionKey: 'MR-1@created',
				externalStatus: 'ordered',
				externalDocstatus: 0,
				bitrixDealId: 42,
				sourceCreatedAt: null,
				sourceModifiedAt: null,
				observedAt,
				sourceHash: supplyMirrorSourceHash({ name: 'PO-1' }),
			},
		],
		lines: [
			{
				identity: requestLineIdentity,
				documentIdentity: requestIdentity,
				externalLineKey: 'MRI-1',
				lineOrdinal: 1,
				erpItemCode: '100',
				plannedQty: null,
				requestQty: 2,
				actualQty: null,
				sourceWarehouse: null,
				targetWarehouse: 'Target',
				sourceModifiedAt: null,
				observedAt,
				sourceHash: supplyMirrorSourceHash({ name: 'MRI-1' }),
			},
			{
				identity: purchaseLineIdentity,
				documentIdentity: purchaseIdentity,
				externalLineKey: 'POI-1',
				lineOrdinal: 1,
				erpItemCode: '100',
				plannedQty: 2,
				requestQty: 2,
				actualQty: null,
				sourceWarehouse: null,
				targetWarehouse: null,
				sourceModifiedAt: null,
				observedAt,
				sourceHash: supplyMirrorSourceHash({ name: 'POI-1' }),
			},
		],
		links: [{
			identity: `${purchaseIdentity}->${requestIdentity}:ordered_for_request`,
			fromDocumentIdentity: purchaseIdentity,
			toDocumentIdentity: requestIdentity,
			relationType: 'ordered_for_request',
			evidenceKind: 'explicit_external_field',
			evidenceSource: 'b24_supply_request',
			observedAt,
			sourceHash: supplyMirrorSourceHash({ purchase: 'PO-1', request: 'MR-1' }),
		}],
		allocations: [{
			identity: `${requestLineIdentity}->${purchaseLineIdentity}:ordered`,
			sourceLineIdentity: requestLineIdentity,
			targetLineIdentity: purchaseLineIdentity,
			allocationType: 'ordered',
			quantity: 2,
			evidenceKind: 'derived_match',
			evidenceSource: 'item_code+request_qty',
			observedAt,
			sourceHash: supplyMirrorSourceHash({ requestLine: 'MRI-1', purchaseLine: 'POI-1' }),
		}],
		issues: [{ severity: 'warning', code: 'historical_test', identity: 'history:1', message: 'preserved evidence' }],
	};
}

class FakeConnection implements SupplyMirrorWriterConnection {
	readonly queries: string[] = [];
	readonly batches: Array<{ sql: string; values: unknown[][] }> = [];
	checkpointExists = false;
	failOnLineBatch = false;
	beginCount = 0;
	commitCount = 0;
	rollbackCount = 0;
	releaseCount = 0;

	async query<T = unknown>(sql: string): Promise<T> {
		this.queries.push(sql);
		if (sql.includes('GET_LOCK')) return [{ acquired: 1 }] as T;
		if (sql.includes('FROM supply_mirror_checkpoints')) return (this.checkpointExists ? [{ id: 1 }] : []) as T;
		if (sql.includes('SELECT id, external_system')) {
			return [
				{ id: 10, external_system: 'erpnext', document_type: 'supply_request', external_id: 'MR-1' },
				{ id: 20, external_system: 'erpnext', document_type: 'purchase_order', external_id: 'PO-1' },
			] as T;
		}
		if (sql.includes('FROM workflow_document_lines l')) {
			return [
				{ id: 100, external_line_key: 'MRI-1', line_ordinal: 1, external_system: 'erpnext', document_type: 'supply_request', external_id: 'MR-1' },
				{ id: 200, external_line_key: 'POI-1', line_ordinal: 1, external_system: 'erpnext', document_type: 'purchase_order', external_id: 'PO-1' },
			] as T;
		}
		if (sql.includes('INSERT INTO supply_mirror_checkpoints')) this.checkpointExists = true;
		if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }] as T;
		return {} as T;
	}

	async batch(sql: string, values: unknown[][]): Promise<unknown> {
		this.batches.push({ sql, values });
		if (this.failOnLineBatch && sql.includes('workflow_document_lines')) throw new Error('line batch failed');
		return {};
	}

	async beginTransaction(): Promise<void> { this.beginCount += 1; }
	async commit(): Promise<void> { this.commitCount += 1; }
	async rollback(): Promise<void> { this.rollbackCount += 1; }
	release(): void { this.releaseCount += 1; }
}

function fakePool(connection: FakeConnection): SupplyMirrorWriterPool {
	return { async getConnection() { return connection; } };
}

test('atomic supply mirror writer upserts the graph and records one checkpoint', async () => {
	const connection = new FakeConnection();
	const result = await applySupplyMirrorPlan(fakePool(connection), readyPlan());
	assert.equal(result.alreadyApplied, false);
	assert.deepEqual(result.counts, { documents: 2, lines: 2, links: 1, allocations: 1, warnings: 1 });
	assert.match(result.planHash, /^[a-f0-9]{64}$/);
	assert.equal(connection.beginCount, 1);
	assert.equal(connection.commitCount, 1);
	assert.equal(connection.rollbackCount, 0);
	assert.equal(connection.releaseCount, 1);
	assert.deepEqual(connection.batches.map((batch) => batch.values.length), [2, 2, 1, 1]);
	assert.ok(connection.batches.every((batch) => batch.sql.includes('ON DUPLICATE KEY UPDATE')));
	assert.ok(connection.queries.some((sql) => sql.includes('INSERT INTO supply_mirror_checkpoints')));
	assert.equal(connection.batches[0]!.values[0]![7], '2026-08-21 07:00:00.123456');
	assert.equal(connection.batches[0]!.values[0]![9], '2026-08-21 07:30:00.000000');
	assert.ok(Buffer.isBuffer(connection.batches[0]!.values[0]![10]));
});

test('reapplying the same plan is a checkpointed no-op', async () => {
	const connection = new FakeConnection();
	const pool = fakePool(connection);
	const first = await applySupplyMirrorPlan(pool, readyPlan());
	const batchCount = connection.batches.length;
	const second = await applySupplyMirrorPlan(pool, readyPlan());
	assert.equal(first.planHash, second.planHash);
	assert.equal(second.alreadyApplied, true);
	assert.equal(connection.batches.length, batchCount);
	assert.equal(connection.commitCount, 1);
	assert.equal(connection.rollbackCount, 1);
	assert.equal(connection.releaseCount, 2);
});

test('writer refuses a blocked plan before opening SQL', async () => {
	const plan = readyPlan();
	plan.readyToApply = false;
	plan.issues.push({ severity: 'error', code: 'blocked', identity: 'source', message: 'incomplete' });
	let connections = 0;
	const pool: SupplyMirrorWriterPool = { async getConnection() { connections += 1; return new FakeConnection(); } };
	await assert.rejects(() => applySupplyMirrorPlan(pool, plan), /not ready to apply/);
	assert.equal(connections, 0);
});

test('writer rolls the whole transaction back on a row failure', async () => {
	const connection = new FakeConnection();
	connection.failOnLineBatch = true;
	await assert.rejects(() => applySupplyMirrorPlan(fakePool(connection), readyPlan()), /line batch failed/);
	assert.equal(connection.commitCount, 0);
	assert.equal(connection.rollbackCount, 1);
	assert.equal(connection.releaseCount, 1);
	assert.equal(connection.checkpointExists, false);
});
