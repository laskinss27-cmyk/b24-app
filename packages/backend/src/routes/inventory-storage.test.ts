import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import { buildInventorySqlBackfillPlan } from '../inventory-sql/backfill-plan.js';
import { parseInventoryBitrixItem } from '../inventory-sql/model.js';
import type { InventorySqlWriteRuntime } from '../inventory-sql/runtime.js';
import { createInventoryData, deleteInventoryData, loadInventoryItems, updateInventoryData } from './inventory-storage.js';

function data(): Record<string, unknown> {
	return {
		status: 'active', createdById: '1', createdAt: '2026-09-05T08:00:00Z', stockSnapshotAt: '2026-09-05T08:00:00Z', sectionIds: [0],
		points: [{
			storeId: -100, storeName: 'Склад', status: 'in_progress', responsibleId: '2', responsibleName: 'Менеджер',
			stockSnapshot: { version: 1, capturedAt: '2026-09-05T08:00:00Z', lines: [[10, 3]] },
			draft: { 10: 2 }, comments: {}, draftSessionId: 's1', draftSequence: 1,
		}],
	};
}

function runtime(trace: string[], failure?: Error): InventorySqlWriteRuntime {
	return {
		mode: 'shadow', enabled: true,
		async write(inventory) {
			trace.push(`sql-write:${inventory.bitrixExternalId}:${inventory.points[0]?.countLines[0]?.factQty}`);
			if (failure) throw failure;
			return { changed: true };
		},
		async createNative() { throw new Error('unused'); },
		async updateNative() { throw new Error('unused'); },
		async deleteNative() { throw new Error('unused'); },
		async pendingMirrors() { return []; },
		async claimMirror() { throw new Error('unused'); },
		async bitrixExternalId() { return null; },
		async markMirrorDelivered() { throw new Error('unused'); },
		async markDeleteDelivered() { throw new Error('unused'); },
		async recordMirrorFailure() { throw new Error('unused'); },
		async markDeleted(input) {
			trace.push(`sql-delete:${input.externalId}`);
			if (failure) throw failure;
			return { alreadyDeleted: false };
		},
		async ping() {}, async close() {},
	};
}

function app(trace: string[], failure?: Error): FastifyInstance {
	return {
		inventorySqlWriter: runtime(trace, failure),
		log: {
			debug(values: Record<string, unknown>) { trace.push(`debug:${String(values['id'] ?? '')}`); },
			warn(values: Record<string, unknown>) { trace.push(`warn:${String(values['id'] ?? '')}`); },
		},
	} as unknown as FastifyInstance;
}

test('inventory create and update commit Bitrix first and then normalize the SQL shadow', async () => {
	const trace: string[] = [];
	const client = {
		async call(method: string) {
			trace.push(`bitrix:${method}`);
			return method === 'entity.item.add' ? { ID: '42' } : true;
		},
	} as unknown as B24Client;
	await createInventoryData(app(trace), client, { name: 'Ревизия', data: data(), createdById: '1', createdAt: '2026-09-05T08:00:00Z' });
	await updateInventoryData(app(trace), client, { id: 42, name: 'Ревизия', data: data(), sourceItem: { CREATED_BY: '1', DATE_CREATE: '2026-09-05T08:00:00Z' } });
	assert.deepEqual(trace.filter((entry) => !entry.startsWith('debug:')), [
		'bitrix:entity.item.add', 'sql-write:42:2',
		'bitrix:entity.item.update', 'sql-write:42:2',
	]);
});

test('a failed SQL shadow never changes a successful Bitrix response', async () => {
	const trace: string[] = [];
	const client = { async call(method: string) { trace.push(`bitrix:${method}`); return true; } } as unknown as B24Client;
	await assert.doesNotReject(() => updateInventoryData(app(trace, new Error('SQL down')), client, {
		id: 42, name: 'Ревизия', data: data(), sourceItem: { CREATED_BY: '1', DATE_CREATE: '2026-09-05T08:00:00Z' },
	}));
	assert.deepEqual(trace, ['bitrix:entity.item.update', 'sql-write:42:2', 'warn:42']);
});

test('inventory delete tombstones SQL only after Bitrix succeeds', async () => {
	const trace: string[] = [];
	const client = { async call(method: string) { trace.push(`bitrix:${method}`); return true; } } as unknown as B24Client;
	await deleteInventoryData(app(trace), client, 42);
	assert.deepEqual(trace.filter((entry) => !entry.startsWith('debug:')), ['bitrix:entity.item.delete', 'sql-delete:42']);

	const failedTrace: string[] = [];
	const failedClient = { async call() { failedTrace.push('bitrix:failed'); throw new Error('Bitrix down'); } } as unknown as B24Client;
	await assert.rejects(() => deleteInventoryData(app(failedTrace), failedClient, 42), /Bitrix down/);
	assert.deepEqual(failedTrace, ['bitrix:failed']);
});

test('inventory SQL-primary create commits before a recoverable Bitrix mirror failure', async () => {
	const trace: string[] = [];
	const primary = {
		...runtime(trace), mode: 'primary' as const,
		async createNative() {
			trace.push('sql-create');
			return { publicId: 84, mutationId: 7, mutationNo: 1, stateHash: '1'.repeat(64), alreadyCurrent: false, alreadyApplied: false };
		},
		async pendingMirrors() { return []; },
		async claimMirror() { trace.push('sql-claim'); return true; },
		async bitrixExternalId() { return null; },
		async recordMirrorFailure() { trace.push('sql-pending'); },
	} satisfies InventorySqlWriteRuntime;
	const primaryApp = {
		inventorySqlWriter: primary,
		log: { warn() {}, debug() {}, info() {} },
	} as unknown as FastifyInstance;
	const client = {
		async callWithMeta() { trace.push('bitrix-list'); throw new Error('Bitrix down'); },
	} as unknown as B24Client;
	const result = await createInventoryData(primaryApp, client, {
		name: 'Ревизия', data: data(), createdById: '1', createdAt: '2026-09-05T08:00:00Z', idempotencyKey: 'inventory-create:test',
	});
	assert.deepEqual(result, { id: 84, alreadyApplied: false });
	assert.deepEqual(trace, ['sql-create', 'sql-claim', 'bitrix-list', 'sql-pending']);
});

test('inventory shadow read returns the complete Bitrix objects even when SQL differs', async () => {
	const bitrixItem = {
		ID: '42', NAME: 'Ревизия', CREATED_BY: '1', DATE_CREATE: '2026-09-05T08:00:00Z', DETAIL_TEXT: JSON.stringify(data()),
	};
	const sqlData = data();
	((sqlData['points'] as Array<Record<string, unknown>>)[0]!['draft'] as Record<string, unknown>)['10'] = 1;
	const sqlItem = { ...bitrixItem, DETAIL_TEXT: JSON.stringify(sqlData) };
	const sqlRecords = buildInventorySqlBackfillPlan({
		observedAt: '2026-09-05T09:00:00Z', sourceComplete: true, sourceRecordCount: 1, items: [sqlItem],
	}).inventories;
	const trace: string[] = [];
	const readApp = {
		config: { inventorySqlRead: 'shadow' },
		databaseRuntime: { mode: 'readiness', async readInventoryRecords() { trace.push('sql-read'); return sqlRecords; } } as DatabaseRuntime,
		log: {
			info(values: Record<string, unknown>) { trace.push(`info:${String(values['status'])}`); },
			warn(values: Record<string, unknown>) { trace.push(`warn:${String(values['status'])}`); },
		},
	} as unknown as FastifyInstance;
	const client = {
		async callWithMeta(method: string) {
			trace.push(`bitrix:${method}`);
			return { result: [bitrixItem], next: null };
		},
	} as unknown as B24Client;

	const loaded = await loadInventoryItems(readApp, client, 'list');
	assert.strictEqual(loaded[0], bitrixItem);
	assert.deepEqual(trace, ['bitrix:entity.item.get', 'sql-read', 'warn:mismatch']);
});

test('inventory verified read returns SQL only after exact live parity', async () => {
	const bitrixItem = {
		ID: '42', NAME: 'Ревизия', CREATED_BY: '1', DATE_CREATE: '2026-09-05T08:00:00Z', DETAIL_TEXT: JSON.stringify(data()),
	};
	const sqlRecords = buildInventorySqlBackfillPlan({
		observedAt: '2026-09-05T09:00:00Z', sourceComplete: true, sourceRecordCount: 1, items: [bitrixItem],
	}).inventories;
	const trace: string[] = [];
	const readApp = {
		config: { inventorySqlRead: 'verified' },
		databaseRuntime: { mode: 'readiness', async readInventoryRecords() { trace.push('sql-read'); return sqlRecords; } } as DatabaseRuntime,
		log: {
			info(values: Record<string, unknown>) { trace.push(`info:${String(values['status'])}:${String(values['responseSource'])}`); },
			warn(values: Record<string, unknown>) { trace.push(`warn:${String(values['status'])}`); },
		},
	} as unknown as FastifyInstance;
	const client = {
		async callWithMeta(method: string) {
			trace.push(`bitrix:${method}`);
			return { result: [bitrixItem], next: null };
		},
	} as unknown as B24Client;

	const loaded = await loadInventoryItems(readApp, client, 'list');
	assert.notStrictEqual(loaded[0], bitrixItem);
	assert.equal(parseInventoryBitrixItem(loaded[0]!).inventory?.stateHash, sqlRecords[0]?.stateHash);
	assert.deepEqual(trace, ['bitrix:entity.item.get', 'sql-read', 'info:match:sql']);
});

test('inventory primary read never loads Bitrix JSON', async () => {
	const bitrixItem = {
		ID: '42', NAME: 'Ревизия', CREATED_BY: '1', DATE_CREATE: '2026-09-05T08:00:00Z', DETAIL_TEXT: JSON.stringify(data()),
	};
	const sqlRecords = buildInventorySqlBackfillPlan({
		observedAt: '2026-09-05T09:00:00Z', sourceComplete: true, sourceRecordCount: 1, items: [bitrixItem],
	}).inventories;
	const trace: string[] = [];
	const readApp = {
		config: { inventorySqlRead: 'primary' },
		databaseRuntime: { mode: 'readiness', async readInventoryRecords() { trace.push('sql-read'); return sqlRecords; } } as DatabaseRuntime,
		log: { info(values: Record<string, unknown>) { trace.push(`info:${String(values['status'])}:${String(values['responseSource'])}`); } },
	} as unknown as FastifyInstance;
	const client = {
		async callWithMeta() { trace.push('bitrix-read'); throw new Error('Bitrix must not be read'); },
	} as unknown as B24Client;

	const loaded = await loadInventoryItems(readApp, client, 'list');
	assert.equal(parseInventoryBitrixItem(loaded[0]!).inventory?.stateHash, sqlRecords[0]?.stateHash);
	assert.deepEqual(trace, ['sql-read', 'info:primary:sql']);
});

test('inventory primary read exposes SQL failure without falling back to Bitrix', async () => {
	const trace: string[] = [];
	const readApp = {
		config: { inventorySqlRead: 'primary' },
		databaseRuntime: { mode: 'readiness', async readInventoryRecords() { trace.push('sql-read'); throw new Error('SQL down'); } } as unknown as DatabaseRuntime,
		log: { info() {} },
	} as unknown as FastifyInstance;
	const client = {
		async callWithMeta() { trace.push('bitrix-read'); return { result: [], next: null }; },
	} as unknown as B24Client;

	await assert.rejects(() => loadInventoryItems(readApp, client, 'list'), /SQL down/);
	assert.deepEqual(trace, ['sql-read']);
});
