import assert from 'node:assert/strict';
import test from 'node:test';
import type { ErpClient } from '../erp/client.js';
import type { SupplyRequest } from '../erp/operations.js';
import { listPurchaseChildren } from './api-supply-request-progress.js';

const requests = Array.from({ length: 53 }, (_, index) => {
	const name = `MR-${index + 1}`;
	return { name, requestKey: `${name}@created`, items: [] } as unknown as SupplyRequest;
});

test('linked supply purchases load in bounded batches instead of disappearing for a long request list', async () => {
	const batchSizes: number[] = [];
	const erp = {
		async list(doctype: string, _fields: string[], filters?: unknown[]) {
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			const names = (filters?.[0] as unknown[])?.[2] as string[];
			batchSizes.push(names.length);
			if (doctype === 'Purchase Receipt') return [];
			return names.includes('MR-53') ? [{ name: 'PO-53', b24_supply_request: 'MR-53', supplier: 'Vendor', status: 'Draft' }] : [];
		},
		async get(doctype: string, name: string) {
			if (doctype !== 'Purchase Order' || name !== 'PO-53') return null;
			return { name, b24_supply_request_key: 'MR-53@created', items: [{ item_code: '101', item_name: 'Product', qty: 2, rate: 5 }] };
		},
	} as unknown as ErpClient;
	const children = await listPurchaseChildren(erp, requests);
	assert.deepEqual(batchSizes, [25, 25, 3, 25, 25, 3]);
	assert.equal(children.get('MR-53@created')?.[0]?.name, 'PO-53');
});

test('failed supply document loading surfaces an error instead of marking requests unprocessed', async () => {
	const erp = {
		async list(doctype: string) {
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Purchase Receipt') return [];
			throw new Error('purchase read failed');
		},
	} as unknown as ErpClient;
	await assert.rejects(listPurchaseChildren(erp, requests.slice(0, 1)), /Не удалось загрузить документы заявок снабжения: purchase read failed/);
});
