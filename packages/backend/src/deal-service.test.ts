import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from './b24/client.js';
import {
	B24_COLLAPSE_SERVICE_NAME,
	B24_COLLAPSE_SERVICE_PRODUCT_ID,
	PAID_REPAIR_SERVICE_NAME,
	PAID_REPAIR_SERVICE_PRODUCT_ID,
	mergeRepairServiceLine,
	normalizeLegacyB24DealRows,
	setDealB24CollapsedService,
} from './deal-service.js';

test('legacy paid repair row becomes the real non-stock catalog service', () => {
	const rows = normalizeLegacyB24DealRows([
		{ PRODUCT_ID: 0, PRODUCT_NAME: '  Платный   ремонт ', PRICE: 7350, QUANTITY: 1 },
		{ PRODUCT_ID: 15001, PRODUCT_NAME: 'Камера', PRICE: 12000, QUANTITY: 2, TYPE: 1 },
	]);
	assert.deepEqual(rows, [
		{ PRODUCT_ID: 15001, PRODUCT_NAME: 'Камера', PRICE: 12000, QUANTITY: 2, TYPE: 1 },
		{
			PRODUCT_ID: PAID_REPAIR_SERVICE_PRODUCT_ID,
			PRODUCT_NAME: PAID_REPAIR_SERVICE_NAME,
			PRICE: 7350,
			QUANTITY: 1,
			TYPE: 7,
		},
	]);
});

test('zero warranty row and Bitrix collapsed cover are not imported into the core plan', () => {
	assert.deepEqual(normalizeLegacyB24DealRows([
		{ PRODUCT_ID: 0, PRODUCT_NAME: 'Гарантийный ремонт', PRICE: 0, QUANTITY: 1 },
		{ PRODUCT_ID: B24_COLLAPSE_SERVICE_PRODUCT_ID, PRODUCT_NAME: B24_COLLAPSE_SERVICE_NAME, PRICE: 5000, QUANTITY: 1 },
	]), []);
});

test('unknown free rows stay blocked', () => {
	assert.throws(
		() => normalizeLegacyB24DealRows([
			{ PRODUCT_ID: 0, PRODUCT_NAME: 'Монтаж вручную', PRICE: 5000, QUANTITY: 1 },
		]),
		/позиции без карточки товара: Монтаж вручную/,
	);
});

test('ambiguous paid repair duplicates stay blocked instead of doubling the deal total', () => {
	assert.throws(
		() => normalizeLegacyB24DealRows([
			{ PRODUCT_ID: 0, PRODUCT_NAME: 'Платный ремонт', PRICE: 5000, QUANTITY: 1 },
			{ PRODUCT_ID: PAID_REPAIR_SERVICE_PRODUCT_ID, PRODUCT_NAME: 'Платный ремонт', PRICE: 5000, QUANTITY: 1, TYPE: 7 },
		]),
		/одновременно найдены карточка и свободная строка/,
	);
	assert.throws(
		() => normalizeLegacyB24DealRows([
			{ PRODUCT_ID: 0, PRODUCT_NAME: 'Платный ремонт', PRICE: 5000, QUANTITY: 1 },
			{ PRODUCT_ID: 0, PRODUCT_NAME: 'Платный ремонт', PRICE: 5000, QUANTITY: 1 },
		]),
		/несколько свободных строк/,
	);
});

test('non-zero warranty row stays blocked', () => {
	assert.throws(
		() => normalizeLegacyB24DealRows([
			{ PRODUCT_ID: 0, PRODUCT_NAME: 'Гарантийный ремонт', PRICE: 100, QUANTITY: 1 },
		]),
		/ненулевая цена/,
	);
});

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
