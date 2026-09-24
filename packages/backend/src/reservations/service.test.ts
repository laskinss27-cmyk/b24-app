import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { B24Client, BatchResult } from '../b24/client.js';
import { ReservationService } from './service.js';
import { ReservationStore } from './store.js';

test('reservation service groups request notifications and does not repeat them', async () => {
	const messages: Array<Record<string, unknown>> = [];
	let reserveEnd = '30.09.2099';
	const client = {
		async callWithMeta(): Promise<{ result: Array<Record<string, unknown>> }> {
			return { result: [{ ID: 42, TITLE: 'Монтаж офиса', ASSIGNED_BY_ID: 7 }] };
		},
		async call(method: string, params: Record<string, unknown>): Promise<unknown> {
			if (method === 'catalog.store.list') return { stores: [{ id: 8, title: 'Максидом Дунайский 64' }] };
			if (method === 'im.message.add') { messages.push(params); return 1; }
			throw new Error(`unexpected call ${method}`);
		},
		async callBatch(calls: Record<string, unknown>): Promise<BatchResult> {
			const keys = Object.keys(calls);
			if (keys[0]?.startsWith('u')) return { result: { u7: [{ NAME: 'Иван', LAST_NAME: 'Иванов' }] }, result_error: {}, result_total: {}, result_next: {} };
			return {
				result: { d42: [
					{ ID: 1, RESERVE_ID: 11, PRODUCT_ID: 100, PRODUCT_NAME: 'Камера', STORE_ID: 8, RESERVE_QUANTITY: 2, DATE_RESERVE_END: reserveEnd },
					{ ID: 2, RESERVE_ID: 12, PRODUCT_ID: 101, PRODUCT_NAME: 'Регистратор', STORE_ID: 8, RESERVE_QUANTITY: 1, DATE_RESERVE_END: reserveEnd },
				] },
				result_error: {}, result_total: {}, result_next: {},
			};
		},
	} as unknown as B24Client;
	const app = {
		config: { portalDomain: 'example.bitrix24.ru' },
		operationLog: { record: async (): Promise<void> => {} },
		log: { warn: (): void => {}, error: (): void => {} },
	} as unknown as FastifyInstance;
	const filePath = join(process.cwd(), '.tmp', `reservation-service-${process.pid}-${Date.now()}.json`);
	const service = new ReservationService(app, new ReservationStore(filePath));

	const first = await service.list(client, true);
	await service.list(client, true);

	assert.equal(first.rows.length, 2);
	assert.equal(messages.length, 1);
	assert.match(String(messages[0]?.['MESSAGE']), /Камера/u);
	assert.match(String(messages[0]?.['MESSAGE']), /Регистратор/u);
	assert.ok(first.rows.every((row) => row.requestNotification === 'sent'));

	reserveEnd = '01.01.2000';
	const expired = await service.list(client, true);
	await service.list(client, true);
	assert.equal(messages.length, 2);
	assert.match(String(messages[1]?.['MESSAGE']), /Резерв закончился/u);
	assert.ok(expired.rows.every((row) => row.expiryNotification === 'sent'));
});
