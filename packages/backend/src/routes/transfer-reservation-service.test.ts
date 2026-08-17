import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { newTransferData } from '../transfers/model.js';
import { errInfo } from './api-supply-route-helpers.js';
import { validateTransferReservation } from './transfer-reservation-service.js';

function erpWithStock(productId: number, qty: number): ErpClient {
	return {
		list: async (doctype: string) => {
			if (doctype === 'Company') return [{ name: 'Умный дом', abbr: 'УД' }];
			if (doctype === 'Bin') return [{ item_code: String(productId), warehouse: 'Склад Прихода - УД', actual_qty: qty }];
			return [];
		},
	} as unknown as ErpClient;
}

function transferItem(id: number, productId: number, qty: number, status: 'draft' | 'collected' | 'canceled'): Record<string, unknown> {
	const data = newTransferData({
		fromStore: 'Склад Прихода',
		toStore: 'Измайловский 18Д',
		lines: [{ productId, name: 'Тестовый товар', qty }],
		createdAt: '2026-08-17T00:00:00.000Z',
		createdById: '1',
		createdByName: 'Тест',
	});
	data.status = status;
	return { ID: id, NAME: `Перемещение #${id}`, DETAIL_TEXT: JSON.stringify(data) };
}

function clientWithTransfers(items: Record<string, unknown>[]): B24Client {
	return { call: async () => items } as unknown as B24Client;
}

test('transfer reservation rejects a repeated document when source stock is already gone', async () => {
	await assert.rejects(
		validateTransferReservation(
			erpWithStock(14428, 0),
			clientWithTransfers([]),
			0,
			'Склад Прихода',
			[{ productId: 14428, name: 'УЗО 2П40А', qty: 1 }],
		),
		/доступно 0, требуется 1.*Если товар уже перемещён, отмени повторный документ/,
	);
});

test('supply API shows an actionable error without the technical Error prefix', () => {
	assert.equal(errInfo(new Error('Проверь склад-источник')), 'Проверь склад-источник');
});

test('transfer reservation excludes the current document but protects stock reserved by another one', async () => {
	const erp = erpWithStock(14428, 2);
	const client = clientWithTransfers([
		transferItem(10, 14428, 1, 'collected'),
		transferItem(11, 14428, 1, 'canceled'),
	]);

	await validateTransferReservation(erp, client, 10, 'Склад Прихода', [{ productId: 14428, name: 'УЗО 2П40А', qty: 2 }]);
	await assert.rejects(
		validateTransferReservation(erp, client, 12, 'Склад Прихода', [{ productId: 14428, name: 'УЗО 2П40А', qty: 2 }]),
		/доступно 1, требуется 2/,
	);
});
