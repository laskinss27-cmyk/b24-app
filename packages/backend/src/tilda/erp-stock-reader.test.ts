import assert from 'node:assert/strict';
import test from 'node:test';
import type { ErpClient } from '../erp/client.js';
import { fetchCompleteTildaErpStocks } from './erp-stock-reader.js';

function fakeErp(items: string[]): ErpClient {
	return {
		async list(doctype: string) {
			if (doctype === 'Item') return items.map((name) => ({ name }));
			if (doctype === 'Company') return [{ name: 'Company', abbr: 'UD' }];
			if (doctype === 'Bin') return [{ item_code: '18178', warehouse: 'Main - UD', actual_qty: 4 }];
			throw new Error(`Unexpected ERP doctype: ${doctype}`);
		},
	} as unknown as ErpClient;
}

test('Tilda ERP stock reader distinguishes a valid zero-stock Item from a missing Item', async () => {
	const stocks = await fetchCompleteTildaErpStocks(fakeErp(['18178', '18184']), [18178, 18184]);
	assert.deepEqual(stocks.get(18178), { Main: 4 });
	assert.deepEqual(stocks.get(18184), {});

	await assert.rejects(
		fetchCompleteTildaErpStocks(fakeErp(['18178']), [18178, 18184]),
		/Confirmed ERP Items are missing or disabled: 18184/u,
	);
});
