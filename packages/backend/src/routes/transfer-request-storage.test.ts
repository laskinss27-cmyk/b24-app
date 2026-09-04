import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import type { StoredTransferRequest } from '../transfers/request-model.js';
import { loadTransferRequests, saveTransferRequest } from './transfer-request-storage.js';

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

function app(mode: 'off' | 'shadow' | 'verified', sql: StoredTransferRequest[] = []): FastifyInstance {
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
		async markDeleted() {}, async ping() {}, async close() {},
	};
	await saveTransferRequest(fakeApp, client, value);
	assert.equal(updated, true);
});
