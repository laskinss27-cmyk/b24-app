import assert from 'node:assert/strict';
import test from 'node:test';
import type { ErpClient } from './client.js';
import { listCoreMovements } from './stock-movements.js';
import { listMarketplaceOperations } from './marketplace-operations.js';
import { MARKETPLACE_OPERATION_FIELD } from './marketplace-fields.js';

for (const kind of ['delivery', 'return', 'issue', 'receipt'] as const) {
	test(`${kind}: headers beyond both 50 and 1000 remain available with and without filters`, async () => {
		const client = {
			get: async () => ({ name: 'existing custom field' }),
			list: async (doctype: string, _fields: string[], _filters: unknown[], limit: number, order: string) => {
				assert.equal(order, 'posting_date desc, name desc');
				const rows = Array.from({ length: 1005 }, (_, index) => ({
					name: `${doctype}-${String(1005 - index).padStart(5, '0')}`, posting_date: '2026-09-04',
					docstatus: 1, b24_deal_id: '36058', grand_total: 100,
				}));
				return limit ? rows.slice(0, limit) : rows;
			},
		} as unknown as ErpClient;
		for (const options of [{}, { from: '2026-09-01', to: '2026-09-29', productId: 123 }]) {
			const result = await listCoreMovements(client, kind, options);
			assert.equal(result.length, kind === 'receipt' ? 2010 : 1005);
			assert.ok(result.some((row) => row.name.endsWith('-00001')));
			if (kind === 'receipt') {
				assert.equal(result.filter((row) => row.doctype === 'Purchase Receipt').length, 1005);
				assert.equal(result.filter((row) => row.doctype === 'Stock Entry').length, 1005);
				assert.equal(result[0]?.name, 'Stock Entry-01005');
			}
		}
	});
}

test('marketplace journal includes older operations beyond its former 200-document cap', async () => {
	const client = {
		get: async (doctype: string, name: string) => doctype === 'Custom Field' ? { name } : {
			name, posting_date: '2026-09-04', docstatus: 1, [MARKETPLACE_OPERATION_FIELD]: 'sale', items: [],
		},
		list: async (doctype: string, _fields: string[], _filters: unknown[], limit: number) => {
			if (doctype === 'Company') return [{ name: 'Company', abbr: 'CO' }];
			const rows = Array.from({ length: 205 }, (_, index) => ({ name: `${doctype}-${index}` }));
			return limit ? rows.slice(0, limit) : rows;
		},
	} as unknown as ErpClient;
	assert.equal((await listMarketplaceOperations(client)).length, 410);
	assert.equal((await listMarketplaceOperations(client, { from: '2026-09-01' })).length, 410);
	assert.equal((await listMarketplaceOperations(client, { limit: 50 })).length, 50);
});
