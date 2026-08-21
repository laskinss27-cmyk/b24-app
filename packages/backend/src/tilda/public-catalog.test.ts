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
			products: [{ uid: 'parent-1', editions: [{ uid: 'uid-1', sku: 'old-1', quantity: '0' }] }],
		} : {
			total: 2, slice: 2,
			products: [{ uid: 'parent-2', editions: [{ uid: 'uid-2', sku: 'old-2', quantity: '7' }] }],
		});
	};
	const result = await readTildaPublicStockRows(endpoint, fetchPage as typeof fetch);
	assert.deepEqual(seen, ['1', '2']);
	assert.equal(result.parentCount, 2);
	assert.deepEqual(result.rows, [
			{ tildaUid: 'uid-1', sku: 'old-1', quantity: 0 },
			{ tildaUid: 'uid-2', sku: 'old-2', quantity: 7 },
	]);
	assert.match(result.contentHash, /^[a-f0-9]{64}$/u);
});

test('Tilda public catalog reader preserves unlimited stock as an explicit null', async () => {
	const result = await readTildaPublicStockRows(endpoint, async () => Response.json({
		total: 1, slice: 1,
		products: [{ uid: 'parent', editions: [{ uid: 'uid', sku: 'old', quantity: '' }] }],
	}));
	assert.deepEqual(result.rows, [{ tildaUid: 'uid', sku: 'old', quantity: null }]);
});

test('Tilda public content hash ignores stock but detects card content changes', async () => {
	const page = (quantity: string, descr: string) => ({
		total: 1, slice: 1,
		products: [{ uid: 'parent', title: 'Title', descr, quantity, editions: [{ uid: 'uid', sku: 'old', quantity }] }],
	});
	const first = await readTildaPublicStockRows(endpoint, async () => Response.json(page('1', 'Description')));
	const stockOnly = await readTildaPublicStockRows(endpoint, async () => Response.json(page('9', 'Description')));
	const changedCard = await readTildaPublicStockRows(endpoint, async () => Response.json(page('9', 'Changed description')));
	assert.equal(first.contentHash, stockOnly.contentHash);
	assert.notEqual(first.contentHash, changedCard.contentHash);
});
