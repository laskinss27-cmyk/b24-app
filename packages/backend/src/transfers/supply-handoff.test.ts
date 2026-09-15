import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffSupplyRequest, validateSupplyHandoff, type SupplyHandoffPorts } from './supply-handoff.js';
import { newSupplyRequestData, parseTransferRequestItem, type StoredTransferRequest } from './request-model.js';
import { normalizeTransferRequestSqlState, transferRequestSqlStateHash } from './request-sql-store.js';

function fixture(): StoredTransferRequest {
	return { id: 21388, name: 'Заявка', ...newSupplyRequestData({ toStore: 'Точка', note: 'Уточнить сроки', createdAt: '2026-09-15T00:00:00Z', createdById: '22', createdByName: 'Автор', lines: [{ productId: 10, name: 'Камера', qty: 2, link: '', note: '' }, { productId: null, name: 'По ссылке', qty: 3, link: 'https://example.test/item', note: 'Белая' }] }) };
}
const input = { toStore: 'Точка', deadline: '2026-09-20', productIds: [10, 10] };
const actor = { id: '1858', name: 'Снабжение' };
function setup() {
	let stored = fixture(); let creates = 0; let found: Record<string, unknown>[] = [];
	const ports: SupplyHandoffPorts = {
		prepare: async args => ({ ...args, items: args.lines }),
		save: async value => { stored = normalizeTransferRequestSqlState({ externalId: value.id, name: value.name, data: value, sourceKind: 'sql_native' }); },
		create: async payload => { creates++; assert.ok(stored.supplyHandoff); found = [{ name: 'MR-1', title: payload['title'], docstatus: 0 }]; return found[0]!; },
		find: async title => found.filter(row => row['title'] === title),
	};
	return { ports, get stored() { return stored; }, get creates() { return creates; }, set found(value: Record<string, unknown>[]) { found = value; } };
}
test('mapped request reaches existing supply workflow; source rows, notes and quantities survive SQL serialization', async () => {
	const s = setup(); const original = s.stored;
	const result = await handoffSupplyRequest(original, input, actor, s.ports);
	assert.equal(result.supplyRequestName, 'MR-1'); assert.equal(result.status, 'converted');
	assert.deepEqual(result.supplyLines, original.supplyLines); assert.equal(result.note, original.note);
	assert.equal(result.convertedById, actor.id);
	const lines = s.stored.supplyHandoff!.payload['items'] as Array<{ qty: number; note: string }>;
	assert.equal(lines.length, 1); assert.equal(lines[0]!.qty, 5); assert.match(lines[0]!.note, /https:\/\/example.test\/item/);
	assert.equal(s.stored.supplyRequestName, 'MR-1');
	await handoffSupplyRequest(s.stored, input, actor, s.ports); assert.equal(s.creates, 1);
});
test('lost ERP response followed by restart recovers saved intent without second POST', async () => {
	const s = setup(); const create = s.ports.create;
	s.ports.create = async payload => { await create(payload); throw new Error('connection lost'); };
	await assert.rejects(handoffSupplyRequest(s.stored, input, actor, s.ports), /connection lost/);
	const restarted = parseTransferRequestItem({ ID: s.stored.id, NAME: s.stored.name, DETAIL_TEXT: JSON.stringify(s.stored) })!;
	const recovered = await handoffSupplyRequest(restarted, input, actor, s.ports);
	assert.equal(recovered.supplyRequestName, 'MR-1'); assert.equal(s.creates, 1);
});
test('failed result persistence recovers existing document', async () => {
	const s = setup(); const save = s.ports.save;
	s.ports.save = async request => { if (request.status === 'converted') throw new Error('SQL unavailable'); await save(request); };
	await assert.rejects(handoffSupplyRequest(s.stored, input, actor, s.ports), /SQL unavailable/);
	s.ports.save = save;
	await handoffSupplyRequest(s.stored, input, actor, s.ports); assert.equal(s.creates, 1);
});
test('unknown missing or ambiguous result never retries ERP creation', async () => {
	const s = setup(); s.ports.create = async () => { throw new Error('timeout'); };
	await assert.rejects(handoffSupplyRequest(s.stored, input, actor, s.ports));
	await assert.rejects(handoffSupplyRequest(s.stored, input, actor, s.ports), /сверки/);
	s.found = [{ name: 'A', title: s.stored.supplyHandoff!.title }, { name: 'B', title: s.stored.supplyHandoff!.title }];
	await assert.rejects(handoffSupplyRequest(s.stored, input, actor, s.ports), /сверки/);
	assert.equal(s.creates, 0);
});
test('cannot create before durable intent is saved', async () => {
	const s = setup(); s.ports.save = async () => { throw new Error('write failed'); };
	await assert.rejects(handoffSupplyRequest(s.stored, input, actor, s.ports)); assert.equal(s.creates, 0);
});
test('reject missing mapping, fractional ID, impossible date, canceled source and transfer kind', async () => {
	for (const patch of [{ productIds: [10, 0] }, { productIds: [10] }, { productIds: [10, 1.2] }, { deadline: '2026-02-30' }, { deadline: '2026-99-99' }, { toStore: '' }]) assert.throws(() => validateSupplyHandoff(fixture(), { ...input, ...patch }));
	const s = setup();
	await assert.rejects(handoffSupplyRequest({ ...fixture(), status: 'canceled' }, input, actor, s.ports));
	await assert.rejects(handoffSupplyRequest({ ...fixture(), kind: 'transfer' }, input, actor, s.ports)); assert.equal(s.creates, 0);
});
test('historical records omit new fields; metadata changes participate in SQL hashes', async () => {
	const s = setup(); const before = transferRequestSqlStateHash(s.stored);
	assert.equal(Object.hasOwn(s.stored, 'supplyHandoff'), false);
	await handoffSupplyRequest(s.stored, input, actor, s.ports);
	assert.notEqual(transferRequestSqlStateHash(s.stored), before);
	assert.notEqual(transferRequestSqlStateHash({ ...s.stored, supplyRequestName: 'OTHER' }), transferRequestSqlStateHash(s.stored));
});
