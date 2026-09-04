import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import type { StoredTransferRequest } from '../transfers/request-model.js';
import type { TransferRequestSqlWriteRuntime } from '../transfers/request-sql-runtime.js';
import { createTransferRequestData, loadTransferRequests, saveTransferRequest } from './transfer-request-storage.js';

function request(id: number, note = ''): StoredTransferRequest {
	return {
		id, name: `Заявка #${id}`, kind: 'transfer', fromStore: 'A', toStore: 'B',
		lines: [{ productId: 100, name: 'Камера', qty: 1 }], supplyLines: [], note,
		status: 'pending', createdAt: '2026-09-04T08:00:00.000Z', createdById: '1', createdByName: 'Менеджер',
		convertedAt: '', convertedById: '', convertedByName: '', transferId: null, taskId: null,
		canceledAt: '', canceledById: '', canceledByName: '',
	};
}

function raw(value: StoredTransferRequest): Record<string, unknown> {
	const { id, name, ...data } = value;
	return { ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) };
}

function app(mode: 'off' | 'shadow' | 'verified' | 'primary', sql: StoredTransferRequest[] = []): FastifyInstance {
	return {
		config: { transferRequestSqlRead: mode },
		databaseRuntime: {
			mode: 'readiness',
			async readCurrentTransferRequests() { return sql; },
		},
		transferRequestSqlWriter: null,
		log: { info() {}, warn() {}, debug() {} },
	} as unknown as FastifyInstance;
}

test('transfer request list follows every Bitrix page instead of stopping at 50', async () => {
	const values = Array.from({ length: 51 }, (_, index) => request(index + 1));
	const starts: number[] = [];
	const client = {
		async callWithMeta(_method: string, params: Record<string, unknown>) {
			const start = Number(params['start'] ?? 0);
			starts.push(start);
			return start === 0
				? { result: values.slice(0, 50).map(raw), next: 50 }
				: { result: values.slice(50).map(raw) };
		},
	} as unknown as B24Client;
	assert.equal((await loadTransferRequests(app('off'), client)).length, 51);
	assert.deepEqual(starts, [0, 50]);
});

test('verified request read returns SQL only after exact parity', async () => {
	const legacy = request(7);
	const client = {
		async callWithMeta() { return { result: [raw(legacy)] }; },
	} as unknown as B24Client;
	assert.deepEqual(await loadTransferRequests(app('verified', [legacy]), client), [legacy]);
	assert.deepEqual(await loadTransferRequests(app('verified', [request(7, 'другое')]), client), [legacy]);
});

test('shadow write cannot turn a successful Bitrix update into a user-visible failure', async () => {
	const value = request(9);
	let updated = false;
	const client = { async call() { updated = true; } } as unknown as B24Client;
	const fakeApp = app('shadow');
	fakeApp.transferRequestSqlWriter = {
		mode: 'shadow', enabled: true,
		async write() { throw new Error('SQL unavailable'); },
		async createNative() { throw new Error('unused'); },
		async updateNative() { throw new Error('unused'); },
		async deleteNative() { throw new Error('unused'); },
		async pendingMirrors() { return []; },
		async claimMirror() { return false; },
		async bitrixExternalId() { return null; },
		async markMirrorDelivered() {},
		async markDeleteDelivered() {},
		async recordMirrorFailure() {},
		async markDeleted() {}, async ping() {}, async close() {},
	};
	await saveTransferRequest(fakeApp, client, value);
	assert.equal(updated, true);
});

test('primary request list reads SQL without loading Bitrix', async () => {
	const sql = [request(42)];
	const client = { async callWithMeta() { throw new Error('Bitrix must not be read'); } } as unknown as B24Client;
	assert.deepEqual(await loadTransferRequests(app('primary', sql), client), sql);
});

test('primary request fallback recovers the SQL public number from the Bitrix marker', async () => {
	const value = request(42);
	const { id: _id, name, ...data } = value;
	const fakeApp = app('primary');
	fakeApp.databaseRuntime!.readCurrentTransferRequests = async () => { throw new Error('SQL down'); };
	const client = {
		async callWithMeta() { return { result: [{ ID: 900, NAME: name, DETAIL_TEXT: JSON.stringify({ ...data, sqlPublicId: 42 }) }] }; },
	} as unknown as B24Client;
	assert.deepEqual(await loadTransferRequests(fakeApp, client), [value]);
});

test('SQL-primary create allocates the request without depending on Bitrix', async () => {
	const trace: string[] = [];
	const writer = {
		mode: 'primary', enabled: true,
		async write() { throw new Error('unused'); },
		async createNative() { trace.push('sql-create'); return { publicId: 42, revisionId: 71, revisionNo: 1, stateHash: '1'.repeat(64), alreadyCurrent: false, alreadyApplied: false }; },
		async updateNative() { throw new Error('unused'); }, async deleteNative() { throw new Error('unused'); },
		async pendingMirrors() { return []; }, async claimMirror() { return false; }, async bitrixExternalId() { return null; },
		async markMirrorDelivered() {}, async markDeleteDelivered() {}, async recordMirrorFailure() {}, async markDeleted() {}, async ping() {}, async close() {},
	} satisfies TransferRequestSqlWriteRuntime;
	const fakeApp = { transferRequestSqlWriter: writer, log: { warn() {}, debug() {} } } as unknown as FastifyInstance;
	const client = { async call() { trace.push('bitrix'); throw new Error('must not call Bitrix'); } } as unknown as B24Client;
	const value = request(42);
	const { id: _id, name, ...data } = value;
	assert.deepEqual(await createTransferRequestData(fakeApp, client, name, data, 'request:create:42'), { id: 42, alreadyApplied: false });
	assert.deepEqual(trace, ['sql-create']);
});

test('SQL-primary update commits before a recoverable Bitrix mirror failure', async () => {
	const trace: string[] = [];
	const writer = {
		mode: 'primary', enabled: true,
		async write() { throw new Error('unused'); }, async createNative() { throw new Error('unused'); },
		async updateNative() { trace.push('sql-update'); return { publicId: 42, revisionId: 72, revisionNo: 2, stateHash: '2'.repeat(64), alreadyCurrent: false, alreadyApplied: false }; },
		async deleteNative() { throw new Error('unused'); }, async pendingMirrors() { return []; },
		async claimMirror() { trace.push('sql-claim'); return true; }, async bitrixExternalId() { return null; },
		async markMirrorDelivered() { throw new Error('unused'); }, async markDeleteDelivered() {},
		async recordMirrorFailure() { trace.push('sql-pending'); }, async markDeleted() {}, async ping() {}, async close() {},
	} satisfies TransferRequestSqlWriteRuntime;
	const fakeApp = { transferRequestSqlWriter: writer, databaseRuntime: { async readCurrentTransferRequest() { return null; } }, log: { warn() {}, debug() {} } } as unknown as FastifyInstance;
	const client = { async call() { trace.push('bitrix-call'); throw new Error('Bitrix down'); }, async callWithMeta() { trace.push('bitrix-scan'); throw new Error('Bitrix down'); } } as unknown as B24Client;
	await saveTransferRequest(fakeApp, client, request(42));
	assert.deepEqual(trace, ['sql-update', 'sql-claim', 'bitrix-scan', 'sql-pending']);
});
