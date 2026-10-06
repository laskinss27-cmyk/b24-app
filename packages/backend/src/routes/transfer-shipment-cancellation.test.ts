import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { reverseMistakenShipment } from '../erp/transfer-shipment-cancellation.js';
import { newTransferData, type StoredTransfer } from '../transfers/model.js';
import { registerTransferCancelRoute } from './transfer-cancel-route.js';
import { registerTransferReceiveRoute } from './transfer-receive-route.js';
import { registerTransferDeleteRoute } from './transfer-delete-route.js';
import type { TransferNotificationService } from './transfer-notification-service.js';

function fixture() {
	let transfer: StoredTransfer = { ...newTransferData({ fromStore: 'Source', toStore: 'Destination',
		lines: [{ productId: 101, name: 'Test item', qty: 2 }], createdAt: '2026-01-01', createdById: '1', createdByName: 'Test' }), id: 123, name: 'Test transfer' };
	transfer = { ...transfer, status: 'in_transit', shipEntry: 'SHIP', shippedLines: transfer.lines };
	const ship: Record<string, unknown> = { name: 'SHIP', company: 'Test Co', docstatus: 1, stock_entry_type: 'Material Transfer',
		b24_transfer_document: '123', b24_transfer_phase: 'ship',
		items: [{ item_code: '101', qty: 2, s_warehouse: 'Source - TC', t_warehouse: 'Transit - TC' }] };
	const entries = new Map<string, Record<string, unknown>>([['SHIP', ship]]);
	const writes: string[] = [];
	let failSubmit = false, failSave = false, userId = '1', failCreateResponse = false;
	const erp = {
		list: async (type: string) => type === 'Company' ? [{ name: 'Test Co', abbr: 'TC' }] : [...entries.values()],
		get: async (type: string, name: string) => type === 'Warehouse' ? { warehouse_type: 'Transit', company: 'Test Co' } : entries.get(name),
		create: async (type: string, data: Record<string, unknown>) => {
			writes.push(`create:${type}`); const entry = { ...data, name: 'REVERSE', docstatus: 0 }; entries.set('REVERSE', entry);
			if (failCreateResponse) { failCreateResponse = false; throw new Error('unknown create response'); }
			return entry;
		},
		submit: async (type: string, name: string, options: unknown) => {
			writes.push(`submit:${name}`); assert.deepEqual(options, { useCurrentPostingTime: true });
			if (failSubmit) throw new Error('ERP unavailable');
			entries.get(name)!['docstatus'] = 1;
		},
	} as unknown as ErpClient;
	const client = { callWithMeta: async () => ({ result: [{ ID: transfer.id, NAME: transfer.name, DETAIL_TEXT: JSON.stringify(transfer) }] }), call: async (method: string, args: Record<string, unknown>) => {
		if (method === 'user.current') return { ID: userId, NAME: 'Test' };
		if (method === 'entity.item.get') return [{ ID: transfer.id, NAME: transfer.name, DETAIL_TEXT: JSON.stringify(transfer) }];
		if (method === 'entity.item.update') {
			const next = JSON.parse(String(args['DETAIL_TEXT'])) as StoredTransfer;
			if (failSave && next.status === 'canceled') throw new Error('B24 save unavailable');
			transfer = next; writes.push(`save:${next.status}`); return true;
		}
		throw new Error(`Unexpected B24 write: ${method}`);
	} } as unknown as B24Client;
	return { erp, client, entries, writes, ship, get transfer() { return transfer; }, set transfer(value) { transfer = value; },
		set failSubmit(value: boolean) { failSubmit = value; }, set failSave(value: boolean) { failSave = value; },
		set userId(value: string) { userId = value; }, set failCreateResponse(value: boolean) { failCreateResponse = value; } };
}

const payload = { id: 123, reason: 'Shipment entered by mistake', goodsStayedAtSource: true };

test('mistaken shipment reverses exactly once and keeps original ledger and audit', async (t) => {
	const f = fixture(), original = structuredClone(f.ship), app = Fastify(), locks = new Set<string>();
	t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	registerTransferCancelRoute(app, () => f.client, locks);
	t.after(() => app.close());
	const result = await app.inject({ method: 'POST', url: '/api/transfers/cancel', payload });
	assert.equal(result.json().ok, true);
	assert.equal(f.transfer.status, 'canceled');
	assert.equal(f.transfer.shipmentCancellation?.entry, 'REVERSE');
	assert.match(f.transfer.history.at(-1)!.note!, /Shipment entered by mistake/);
	assert.deepEqual(f.entries.get('REVERSE')!['items'], [{ item_code: '101', qty: 2, s_warehouse: 'Transit - TC', t_warehouse: 'Source - TC' }]);
	assert.deepEqual(f.ship, original);
	assert.deepEqual(f.writes, ['save:in_transit', 'create:Stock Entry', 'submit:REVERSE', 'save:canceled']);
	assert.equal((await app.inject({ method: 'POST', url: '/api/transfers/cancel', payload })).json().ok, true);
	assert.equal(f.writes.filter(w => w.startsWith('create')).length, 1);
	assert.equal(locks.size, 0);
});

test('permission, physical confirmation, reason and acceptance guards prevent any write', async (t) => {
	for (const scenario of ['permission', 'confirmation', 'reason', 'accepted', 'zero acceptance', 'receipt', 'correction']) {
		const f = fixture(), app = Fastify();
		t.mock.method(ErpClient, 'fromEnv', () => f.erp);
		registerTransferCancelRoute(app, () => f.client);
		if (scenario === 'permission') f.userId = '77';
		if (scenario === 'accepted') f.transfer.status = 'accepted';
		if (scenario === 'zero acceptance') f.transfer.acceptedLines = [{ productId: 101, name: 'Test', qty: 0 }];
		if (scenario === 'receipt') f.transfer.receiveEntry = 'RECEIVE';
		if (scenario === 'correction') f.transfer.correctionIds = [999];
		const result = await app.inject({ method: 'POST', url: '/api/transfers/cancel', payload: { ...payload,
			...(scenario === 'confirmation' ? { goodsStayedAtSource: false } : {}), ...(scenario === 'reason' ? { reason: '' } : {}) } });
		assert.equal(result.json().ok, false, scenario); assert.deepEqual(f.writes, [], scenario);
		await app.close();
	}
});

test('ERP preflight rejects incompatible records without persisting cancellation intent', async () => {
	for (const scenario of ['other operation', 'quantity', 'source', 'foreign transfer', 'serial bundle']) {
		const f = fixture(); let intents = 0;
		const items = f.ship['items'] as Record<string, unknown>[];
		if (scenario === 'other operation') f.entries.set('RECEIVE', { name: 'RECEIVE', b24_transfer_phase: 'receive', docstatus: 0 });
		if (scenario === 'quantity') items[0]!['qty'] = 3;
		if (scenario === 'source') items[0]!['s_warehouse'] = 'Other - TC';
		if (scenario === 'foreign transfer') f.ship['b24_transfer_document'] = '999';
		if (scenario === 'serial bundle') items[0]!['serial_and_batch_bundle'] = 'BUNDLE';
		await assert.rejects(reverseMistakenShipment(f.erp, f.transfer, async () => { intents++; }));
		assert.equal(intents, 0, scenario); assert.deepEqual(f.writes, [], scenario);
	}
});

test('partial failures block reception and resume without another movement', async (t) => {
	for (const scenario of ['submit failure', 'final save failure', 'unknown create response']) {
		const f = fixture(), app = Fastify(), locks = new Set<string>();
		t.mock.method(ErpClient, 'fromEnv', () => f.erp);
		registerTransferCancelRoute(app, () => f.client, locks);
		registerTransferReceiveRoute(app, () => f.client, {} as TransferNotificationService, locks);
		f.failSubmit = scenario === 'submit failure'; f.failSave = scenario === 'final save failure'; f.failCreateResponse = scenario === 'unknown create response';
		assert.equal((await app.inject({ method: 'POST', url: '/api/transfers/cancel', payload })).json().ok, false);
		assert.ok(f.transfer.shipmentCancellation);
		assert.equal((await app.inject({ method: 'POST', url: '/api/transfers/receive', payload: { id: 123, lines: [] } })).statusCode, 409);
		f.failSubmit = false; f.failSave = false;
		assert.equal((await app.inject({ method: 'POST', url: '/api/transfers/cancel', payload })).json().ok, true);
		assert.equal(f.writes.filter(w => w.startsWith('create')).length, 1, scenario);
		assert.equal(f.transfer.status, 'canceled'); assert.equal(locks.size, 0);
		await app.close();
	}
});

test('cancellation and reception share a lock and cancellation releases it after errors', async (t) => {
	const f = fixture(), app = Fastify(), locks = new Set(['transfer:123']);
	t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	registerTransferCancelRoute(app, () => f.client, locks);
	registerTransferReceiveRoute(app, () => f.client, {} as TransferNotificationService, locks);
	t.after(() => app.close());
	for (const action of ['cancel', 'receive']) assert.equal((await app.inject({ method: 'POST', url: `/api/transfers/${action}`, payload })).statusCode, 409);
	assert.deepEqual(f.writes, []);
	locks.clear(); f.failSubmit = true;
	await app.inject({ method: 'POST', url: '/api/transfers/cancel', payload });
	assert.equal(locks.size, 0);
});

test('condition warehouses and shipment units survive reversal; incompatible saved reversal is rejected', async () => {
	const f = fixture();
	f.transfer.fromStore = 'Source [Брак]';
	const items = f.ship['items'] as Record<string, unknown>[];
	items[0] = { ...items[0], s_warehouse: 'Source [Брак] - TC', t_warehouse: 'Transit [Брак] - TC', uom: 'Box', conversion_factor: 5 };
	await reverseMistakenShipment(f.erp, f.transfer, async () => {});
	const reversed = f.entries.get('REVERSE')!['items'] as Record<string, unknown>[];
	assert.equal(reversed[0]!['s_warehouse'], 'Transit [Брак] - TC');
	assert.equal(reversed[0]!['t_warehouse'], 'Source [Брак] - TC');
	assert.equal(reversed[0]!['conversion_factor'], 5);
	assert.equal(reversed[0]!['uom'], 'Box');
	reversed[0]!['qty'] = 3;
	await assert.rejects(reverseMistakenShipment(f.erp, f.transfer, async () => {}), /не соответствует отправке/);
});

test('failed durable intent save never starts an ERP write', async () => {
	const f = fixture();
	await assert.rejects(reverseMistakenShipment(f.erp, f.transfer, async () => { throw new Error('B24 unavailable'); }), /B24 unavailable/);
	assert.deepEqual(f.writes, []);
});

test('old draft cancellation still releases reservation without ERP; reverse audit cannot be deleted', async (t) => {
	const f = fixture(), app = Fastify();
	t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	registerTransferCancelRoute(app, () => f.client);
	registerTransferDeleteRoute(app, () => f.client, new Set());
	t.after(() => app.close());
	f.transfer.status = 'draft';
	assert.equal((await app.inject({ method: 'POST', url: '/api/transfers/cancel', payload: { id: 123 } })).json().ok, true);
	assert.deepEqual(f.writes, ['save:canceled']);
	f.userId = '1858'; f.transfer.shipmentCancellation = { reason: 'Test reason', at: '2026-01-01', byId: '1', byName: 'Test', entry: 'REVERSE' };
	assert.equal((await app.inject({ method: 'POST', url: '/api/transfers/delete', payload: { id: 123 } })).statusCode, 409);
});
