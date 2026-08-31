import assert from 'node:assert/strict';
import test from 'node:test';
import { readTildaPublicStockRows } from './public-catalog.js';

const endpoint = 'https://store.tildaapi.com/api/getproductslist/?storepartuid=1&slice=1&size=1';

test('Tilda public catalog reader follows server pagination and preserves zero stock', async () => {
	const seen: string[] = [];
	const fetchPage = async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(String(input));
		seen.push(url.searchParams.get('slice') ?? '');
		const slice = Number(url.searchParams.get('slice'));
		return Response.json(slice === 1 ? {
			total: 2, slice: 1, nextslice: 2,
			products: [{ uid: 'parent-1', externalid: 'external-1', title: 'First', characteristics: [{ title: 'Наличие', value: 'Под заказ' }], editions: [{ uid: 'uid-1', sku: 'old-1', quantity: '0', price: '2150.00' }] }],
		} : {
			total: 2, slice: 2,
			products: [{ uid: 'parent-2', externalid: 'external-2', title: 'Second', characteristics: [{ title: 'Наличие', value: 'В наличии' }], editions: [{ uid: 'uid-2', sku: 'old-2', quantity: '7', price: '' }] }],
		});
	};
	const result = await readTildaPublicStockRows(endpoint, fetchPage as typeof fetch);
	assert.deepEqual(seen, ['1', '2']);
	assert.equal(result.parentCount, 2);
	assert.deepEqual(result.rows, [
		{ tildaUid: 'uid-1', sku: 'old-1', quantity: 0, price: 2150 },
		{ tildaUid: 'uid-2', sku: 'old-2', quantity: 7, price: null },
	]);
	assert.deepEqual(result.availabilityRows, [
		{ tildaUid: 'parent-1', externalId: 'external-1', title: 'First', availability: 'Под заказ', editionUids: ['uid-1'] },
		{ tildaUid: 'parent-2', externalId: 'external-2', title: 'Second', availability: 'В наличии', editionUids: ['uid-2'] },
	]);
	assert.match(result.contentHash, /^[a-f0-9]{64}$/u);
	assert.match(result.protectedContentHash, /^[a-f0-9]{64}$/u);
	assert.match(result.availabilityProtectedContentHash, /^[a-f0-9]{64}$/u);
});

test('Tilda public catalog reader preserves unlimited stock as an explicit null', async () => {
	const result = await readTildaPublicStockRows(endpoint, async () => Response.json({
		total: 1, slice: 1,
		products: [{ uid: 'parent', externalid: 'external', title: 'Product', editions: [{ uid: 'uid', sku: 'old', quantity: '', price: '100' }] }],
	}));
	assert.deepEqual(result.rows, [{ tildaUid: 'uid', sku: 'old', quantity: null, price: 100 }]);
});

test('Tilda public hashes protect card content while allowing only the enabled mutable fields', async () => {
	const page = (quantity: string, price: string, descr: string, availability = 'В наличии', brand = 'Shelly') => ({
		total: 1, slice: 1,
		products: [{ uid: 'parent', externalid: 'external', title: 'Title', descr, quantity, price, characteristics: [{ title: 'Наличие', value: availability }, { title: 'Бренд', value: brand }], editions: [{ uid: 'uid', sku: 'old', quantity, price }] }],
	});
	const first = await readTildaPublicStockRows(endpoint, async () => Response.json(page('1', '100', 'Description')));
	const stockOnly = await readTildaPublicStockRows(endpoint, async () => Response.json(page('9', '100', 'Description')));
	const changedPrice = await readTildaPublicStockRows(endpoint, async () => Response.json(page('9', '120', 'Description')));
	const changedCard = await readTildaPublicStockRows(endpoint, async () => Response.json(page('9', '120', 'Changed description')));
	const changedAvailability = await readTildaPublicStockRows(endpoint, async () => Response.json(page('9', '120', 'Description', 'Под заказ')));
	const changedOtherCharacteristic = await readTildaPublicStockRows(endpoint, async () => Response.json(page('9', '120', 'Description', 'В наличии', 'Other')));
	assert.equal(first.contentHash, stockOnly.contentHash);
	assert.notEqual(first.contentHash, changedPrice.contentHash);
	assert.equal(first.protectedContentHash, changedPrice.protectedContentHash);
	assert.notEqual(first.contentHash, changedCard.contentHash);
	assert.notEqual(first.protectedContentHash, changedCard.protectedContentHash);
	assert.equal(first.availabilityProtectedContentHash, changedAvailability.availabilityProtectedContentHash);
	assert.notEqual(first.availabilityProtectedContentHash, changedOtherCharacteristic.availabilityProtectedContentHash);
	assert.notEqual(first.availabilityProtectedContentHash, changedCard.availabilityProtectedContentHash);
});

test('Tilda public reader fails closed for ambiguous availability', async () => {
	await assert.rejects(() => readTildaPublicStockRows(endpoint, async () => Response.json({
		total: 1, slice: 1,
		products: [{
			uid: 'parent', externalid: 'external', title: 'Product',
			characteristics: [{ title: 'Наличие', value: 'Скоро' }],
			editions: [{ uid: 'uid', sku: 'old', quantity: '0', price: '100' }],
		}],
	})), /invalid availability/u);
});
