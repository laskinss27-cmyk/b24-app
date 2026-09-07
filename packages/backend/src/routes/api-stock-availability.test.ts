import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import type { ReservationRuntime } from '../reservations/runtime.js';
import { ReservationService } from '../reservations/service.js';
import { validateFreeStock } from './api-stock-availability.js';

const app = { config: { transferSqlRead: 'off' } } as unknown as FastifyInstance;
const client = { callWithMeta: async () => ({ result: [] }) } as unknown as B24Client;
function core(reserved = 0, draft = 0): ErpClient {
	return { list: async (doctype: string) => {
		if (doctype === 'Company') return [{ name: 'Умный дом', abbr: 'УД' }];
		if (doctype === 'Bin') return [{ item_code: '5110', warehouse: 'Склад - УД', actual_qty: 10, reserved_qty: reserved }];
		if (doctype === 'Delivery Note Item') return draft ? [{ item_code: '5110', warehouse: 'Склад - УД', qty: draft, docstatus: 0 }] : [];
		return [];
	} } as unknown as ErpClient;
}
const line = (qty: number) => ({ productId: 5110, qty, fromStore: 'Склад' });

test('condition/quicksale validation combines core and active SQL holds', async (t) => {
	const calls: number[] = [];
	t.mock.method(ReservationService.prototype, 'availabilityForDeal', async (_erp: ErpClient, dealId: number) => {
		calls.push(dealId);
		return [{ productId: 5110, storeTitle: 'Склад', reservedByOthers: 6, reservedByOwnDeal: 0, physicalQuantity: 10, availableForDeal: 4 }];
	});
	const runtime = { canWrite: true } as ReservationRuntime;
	await validateFreeStock(app, client, core(1, 2), [line(1)], runtime, { includeCoreReservations: true });
	await assert.rejects(validateFreeStock(app, client, core(1, 2), [line(2)], runtime, { includeCoreReservations: true }), /свободно 1/);
	assert.deepEqual(calls, [0, 0]);
});

test('aggregates duplicate source rows and does not enforce shadow reservations', async (t) => {
	t.mock.method(ReservationService.prototype, 'availabilityForDeal', async () => { throw Error('shadow must not be enforced'); });
	await assert.rejects(validateFreeStock(app, client, core(), [line(6), line(5)], { canWrite: false } as ReservationRuntime), /свободно 10/);
	await validateFreeStock(app, client, core(), [line(10)], { canWrite: false } as ReservationRuntime);
});

test('SQL lookup failure blocks changing state before a write', async (t) => {
	t.mock.method(ReservationService.prototype, 'availabilityForDeal', async () => { throw Error('reservation database unavailable'); });
	await assert.rejects(validateFreeStock(app, client, core(), [line(1)], { canWrite: true } as ReservationRuntime, { includeCoreReservations: true }), /reservation database unavailable/);
});
