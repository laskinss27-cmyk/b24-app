import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import type { RepairSqlWriteRuntime } from '../repair-sql/runtime.js';
import type { RepairData } from './repair-record.js';
import { assignRepairIdentity, createRepairData, deleteRepairData, loadRepairItems, updateRepairData } from './repair-storage.js';

function data(taskId: number | null = null): RepairData {
	return {
		kind: 'client', status: 'received_tt', repairNo: 134,
		client: { contactId: null, name: 'Иван', phone: '' }, device: 'Камера', model: '', serial: '',
		point: 'Дунайский', appearance: '', defect: '', payType: 'warranty', cost: null, ourPrice: null,
		dealId: null, taskId, clientRefusal: null, repairItemCode: null, repairStore: null, issueStore: null,
		repairDeliveryNote: null, productId: null, sourceStore: null, comment: '', internalComment: '', photos: [], files: [],
		createdAt: '2026-09-06T08:00:00.000Z', createdById: '1', createdByName: 'Owner', history: [],
	};
}

test('repair storage mirrors every successful Bitrix mutation to normalized SQL', async () => {
	const trace: string[] = [];
	const writer = {
		mode: 'shadow', enabled: true,
		async write(record: { id: number; taskId: number | null }) { trace.push(`sql-write:${record.id}:${record.taskId ?? 0}`); return { changed: true }; },
		async markDeleted({ externalId }: { externalId: number }) { trace.push(`sql-delete:${externalId}`); return { alreadyDeleted: false }; },
		async ping() {}, async close() {},
	} as unknown as RepairSqlWriteRuntime;
	const app = {
		config: { repairSqlRead: 'off' }, repairSqlWriter: writer, databaseRuntime: null,
		log: { debug() {}, info() {}, warn() {} },
	} as unknown as FastifyInstance;
	const client = {
		async call(method: string) {
			trace.push(`bitrix:${method}`);
			return method === 'entity.item.add' ? 501 : {};
		},
	} as unknown as B24Client;

	const id = await createRepairData(app, client, { name: 'Камера', data: data() });
	await updateRepairData(app, client, { id, name: 'Камера', data: data(77) });
	await deleteRepairData(app, client, id);
	assert.deepEqual(trace, [
		'bitrix:entity.item.add', 'sql-write:501:0',
		'bitrix:entity.item.update', 'sql-write:501:77',
		'bitrix:entity.item.delete', 'sql-delete:501',
	]);
});

test('repair verified list serves SQL reconstruction only after exact parity', async () => {
	const source = { ID: '501', NAME: 'Камера', DETAIL_TEXT: JSON.stringify(data()) };
	const { parseRepairBitrixItem } = await import('../repair-sql/model.js');
	const record = parseRepairBitrixItem(source).record!;
	const database = { mode: 'readiness', async readRepairRecords() { return [record]; } } as unknown as DatabaseRuntime;
	const app = {
		config: { repairSqlRead: 'verified' }, repairSqlWriter: null, databaseRuntime: database,
		log: { debug() {}, info() {}, warn() {} },
	} as unknown as FastifyInstance;
	let called = false;
	const client = {
		async call() {
			if (called) return [];
			called = true;
			return [source];
		},
	} as unknown as B24Client;
	const items = await loadRepairItems(app, client, 'test');
	assert.equal(items.length, 1);
	assert.equal(JSON.parse(String(items[0]!['DETAIL_TEXT'])).repairNo, 134);
});

test('repair primary creation commits SQL before its compatibility mirror', async () => {
	const trace: string[] = [];
	const writer = {
		mode: 'primary', enabled: true,
		async reserveIdentity() { return { publicId: 700, repairNo: 135, requestHash: 'a'.repeat(64), alreadyAllocated: false }; },
		async createNative() { trace.push('sql-create'); return { publicId: 700, repairNo: 135, mutationId: 9, mutationNo: 1, stateHash: 'b'.repeat(64), alreadyCurrent: false, alreadyApplied: false }; },
		async pendingMirrors() { return []; },
		async claimMirror() { trace.push('sql-claim'); return true; },
		async bitrixExternalId() { return null; },
		async markMirrorDelivered() { trace.push('sql-delivered'); },
		async recordMirrorFailure() {}, async markDeleteDelivered() {}, async write() { throw new Error('unused'); },
		async updateNative() { throw new Error('unused'); }, async deleteNative() { throw new Error('unused'); },
		async markDeleted() { throw new Error('unused'); }, async ping() {}, async close() {},
	} as unknown as RepairSqlWriteRuntime;
	const app = {
		config: { repairSqlRead: 'primary' }, repairSqlWriter: writer,
		databaseRuntime: { mode: 'readiness', async readRepairRecords() { return []; } },
		log: { debug() {}, info() {}, warn() {} },
	} as unknown as FastifyInstance;
	const client = {
		async call(method: string) {
			trace.push(`bitrix:${method}`);
			return method === 'entity.item.add' ? 900 : [];
		},
	} as unknown as B24Client;
	const assigned = await assignRepairIdentity(app, client, app.log, { idempotencyKey: 'repair:create:test', request: { device: 'Камера' } });
	const repair = data(); repair.repairNo = assigned.repairNo;
	assert.equal(await createRepairData(app, client, { name: 'Камера', data: repair, identity: assigned.identity! }), 700);
	assert.deepEqual(trace, ['sql-create', 'sql-claim', 'bitrix:entity.item.get', 'bitrix:entity.item.add', 'sql-delivered']);
});
