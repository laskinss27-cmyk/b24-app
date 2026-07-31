import assert from 'node:assert/strict';
import test from 'node:test';
import { B24ApiError, type B24Client } from './b24/client.js';
import {
	B24_COLLAPSE_SERVICE_NAME,
	B24_COLLAPSE_SERVICE_PRODUCT_ID,
	PAID_REPAIR_SERVICE_NAME,
	PAID_REPAIR_SERVICE_PRODUCT_ID,
	mergeRepairServiceLine,
	setDealB24CollapsedService,
} from './deal-service.js';

test('repair price update preserves all equipment and replaces only service 19108', () => {
	const equipment = {
		productId: 15001,
		itemName: 'Камера',
		qty: 2,
		priceListRate: 12000,
		discountPercent: 5,
		isService: false,
	};
	assert.deepEqual(mergeRepairServiceLine([
		equipment,
		{
			productId: PAID_REPAIR_SERVICE_PRODUCT_ID,
			itemName: PAID_REPAIR_SERVICE_NAME,
			qty: 1,
			priceListRate: 5000,
			discountPercent: 0,
			isService: true,
		},
	], 'paid', 7350), [
		equipment,
		{
			productId: PAID_REPAIR_SERVICE_PRODUCT_ID,
			itemName: PAID_REPAIR_SERVICE_NAME,
			qty: 1,
			priceListRate: 7350,
			discountPercent: 0,
			isService: true,
		},
	]);
});

test('switching repair to warranty removes only paid repair service', () => {
	const equipment = {
		productId: 15001,
		itemName: 'Камера',
		qty: 2,
		priceListRate: 12000,
		discountPercent: 0,
		isService: false,
	};
	assert.deepEqual(mergeRepairServiceLine([
		equipment,
		{
			productId: PAID_REPAIR_SERVICE_PRODUCT_ID,
			itemName: PAID_REPAIR_SERVICE_NAME,
			qty: 1,
			priceListRate: 5000,
			discountPercent: 0,
			isService: true,
		},
	], 'warranty', 0), [equipment]);
});

test('Bitrix receives one collapsed service row with the core total', async () => {
	const calls: Array<{ method: string; params: unknown }> = [];
	const client = {
		call: async (method: string, params: unknown) => {
			calls.push({ method, params });
			return null;
		},
	} as unknown as B24Client;

	await setDealB24CollapsedService(client, 501, 7350);
	await setDealB24CollapsedService(client, 502, 0);

	assert.deepEqual(calls, [
		{
			method: 'crm.deal.productrows.set',
			params: {
				id: 501,
				rows: [{
					PRODUCT_ID: B24_COLLAPSE_SERVICE_PRODUCT_ID,
					PRODUCT_NAME: B24_COLLAPSE_SERVICE_NAME,
					PRICE: 7350,
					QUANTITY: 1,
					MEASURE_CODE: 796,
				}],
			},
		},
		{
			method: 'crm.deal.productrows.set',
			params: { id: 502, rows: [] },
		},
	]);
});

test('legacy shipped Bitrix rows stay as history and the deal receives the core total', async () => {
	const calls: Array<{ method: string; params: unknown }> = [];
	const client = {
		call: async (method: string, params: unknown) => {
			calls.push({ method, params });
			if (method === 'crm.deal.productrows.set') {
				throw new B24ApiError(
					method,
					'ERROR_CORE',
					'Невозможно удалить отгруженный товар "Карта памяти microSD 64Gb"',
					200,
				);
			}
			return null;
		},
	} as unknown as B24Client;

	await setDealB24CollapsedService(client, 37142, 126000);

	assert.deepEqual(calls, [
		{
			method: 'crm.deal.productrows.set',
			params: {
				id: 37142,
				rows: [{
					PRODUCT_ID: B24_COLLAPSE_SERVICE_PRODUCT_ID,
					PRODUCT_NAME: B24_COLLAPSE_SERVICE_NAME,
					PRICE: 126000,
					QUANTITY: 1,
					MEASURE_CODE: 796,
				}],
			},
		},
		{
			method: 'crm.deal.update',
			params: {
				id: 37142,
				fields: {
					IS_MANUAL_OPPORTUNITY: 'Y',
					OPPORTUNITY: 126000,
				},
			},
		},
	]);
});
