import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import { normalizeInventorySqlState, type InventorySqlRecord } from '../inventory-sql/model.js';
import { inventorySqlRecordToBitrixItem } from '../inventory-sql/read-shadow.js';
import type { InventorySqlWriteRuntime } from '../inventory-sql/runtime.js';
import { loadInventoryItems, updateInventoryData } from './inventory-storage.js';

function fixture() {
	const data = {
		status: 'active', createdById: '1', createdAt: '2026-09-14T08:00:00Z', sectionIds: [0],
		points: [{
			storeId: -100, storeName: 'Склад', status: 'in_progress', responsibleId: '2', responsibleName: 'Менеджер',
			stockSnapshot: { version: 1, capturedAt: '2026-09-14T08:00:00Z', lines: [[10, 3]] },
			draft: { 10: 2 }, comments: { 10: 'Проверено' }, draftSessionId: 's1', draftSequence: 1,
			result: { total: 1, counted: 1, discrepancies: 1, lines: [{ productId: 10, name: 'Товар', book: 3, fact: 2, diff: -1 }] },
		}],
	};
	return { publicId: 42, name: 'Ревизия', data, createdById: '1', createdAt: data.createdAt };
}

function harness() {
	let stored = normalizeInventorySqlState(fixture());
	const commands = new Map<string, { hash: string; mutationId: number }>();
	const writes: string[] = [];
	const calls: string[] = [];
	const mirrored: number[] = [];
	const writer = {
		mode: 'primary', enabled: true,
		async updateNative(input) {
			calls.push(input.idempotencyKey);
			const normalized = normalizeInventorySqlState(input);
			const previous = commands.get(input.idempotencyKey);
			if (previous) {
				assert.equal(previous.hash, normalized.stateHash);
				return { publicId: 42, mutationId: previous.mutationId, mutationNo: previous.mutationId,
					stateHash: previous.hash, alreadyApplied: true, alreadyCurrent: stored.stateHash === previous.hash };
			}
			stored = normalized;
			writes.push(normalized.stateHash);
			commands.set(input.idempotencyKey, { hash: normalized.stateHash, mutationId: writes.length });
			return { publicId: 42, mutationId: writes.length, mutationNo: writes.length,
				stateHash: normalized.stateHash, alreadyApplied: false, alreadyCurrent: false };
		},
		async claimMirror(input) { mirrored.push(input.mutationId); return false; },
		async pendingMirrors() { return []; },
	} satisfies Partial<InventorySqlWriteRuntime>;
	const app = {
		config: { inventorySqlRead: 'primary' }, inventorySqlWriter: writer,
		databaseRuntime: { mode: 'readiness', async readInventoryRecords() { return [structuredClone(stored)]; } },
		log: { info() {}, warn() {} },
	} as unknown as FastifyInstance;
	const client = { async call() { assert.fail('must not write Bitrix in this test'); } } as unknown as B24Client;
	async function save(data: Record<string, unknown>) {
		await updateInventoryData(app, client, { id: 42, name: 'Ревизия', data, sourceItem: inventorySqlRecordToBitrixItem(stored) });
	}
	async function reload(): Promise<Record<string, unknown>> {
		const [item] = await loadInventoryItems(app, client, 'list');
		return JSON.parse(String(item!['DETAIL_TEXT'])) as Record<string, unknown>;
	}
	return { app, client, writer, calls, writes, mirrored, save, reload, stored: (): InventorySqlRecord => stored };
}

test('submit and reopen repeated states survive SQL reload without losing counts', async () => {
	const h = harness();
	const draft = (await h.reload());
	await h.save(draft); // Older completed saveDraft command, as in #21372.
	const submitted = structuredClone(draft);
	const submittedPoint = (submitted['points'] as Array<Record<string, unknown>>)[0]!;
	submittedPoint['status'] = 'submitted';
	submittedPoint['submittedAt'] = '2026-09-14T09:00:00.000Z';
	for (let cycle = 0; cycle < 3; cycle++) {
		await h.save(submitted);
		assert.equal(h.stored().points[0]!.status, 'submitted');
		const reopened = await h.reload();
		const point = (reopened['points'] as Array<Record<string, unknown>>)[0]!;
		point['status'] = 'in_progress'; delete point['submittedAt']; delete point['actAt'];
		await h.save(reopened);
		assert.deepEqual(await h.reload(), draft);
		assert.equal(h.stored().points[0]!.countLines[0]!.factQty, 2);
		assert.equal(h.stored().points[0]!.snapshotLines[0]!.bookQty, 3);
		const writeCount = h.writes.length;
		await h.save(reopened); // A retry of an already-current target remains deduplicated.
		assert.equal(h.writes.length, writeCount);
	}
	assert.equal(h.writes.length, 7);
	assert.equal(h.mirrored.length, h.writes.length);
	assert.equal(new Set(h.calls.filter(key => key.split(':').length === 4)).size, 5);
});

test('reopen does not report success or mirror when retrying a historical state fails', async () => {
	const h = harness();
	await h.save(await h.reload());
	const submitted = await h.reload();
	(submitted['points'] as Array<Record<string, unknown>>)[0]!['status'] = 'submitted';
	await h.save(submitted);
	const originalUpdate = h.writer.updateNative;
	h.writer.updateNative = async input => {
		if (input.idempotencyKey.split(':').length === 4) throw new Error('SQL unavailable');
		return originalUpdate(input);
	};
	await assert.rejects(() => h.save(fixture().data), /SQL unavailable/);
	assert.equal(h.stored().points[0]!.status, 'submitted');
	assert.equal(h.mirrored.length, 2);
});

test('historical replay cannot be acknowledged if writer still says it is not current', async () => {
	const h = harness();
	h.writer.updateNative = async input => ({ publicId: 42, mutationId: 1, mutationNo: 1,
		stateHash: normalizeInventorySqlState(input).stateHash, alreadyApplied: true, alreadyCurrent: false });
	await assert.rejects(() => h.save(fixture().data), /Изменение инвентаризации не сохранено/);
	assert.equal(h.mirrored.length, 0);
});
