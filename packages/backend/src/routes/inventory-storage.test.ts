import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import type { InventorySqlWriteRuntime } from '../inventory-sql/runtime.js';
import { createInventoryData, deleteInventoryData, updateInventoryData } from './inventory-storage.js';

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
