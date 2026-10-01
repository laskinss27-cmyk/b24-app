import assert from 'node:assert/strict';
import test from 'node:test';
import { readClosedDealServices } from './closed-deal-services.js';
import { buildSalesReport } from '../b24/sales-report.js';
import type { ErpClient } from './client.js';
import type { B24Client } from '../b24/client.js';

function fixture(items: Array<Record<string, unknown>>, stages: unknown[] = [], delivered = false): ErpClient {
	const order = { name: 'SO', b24_deal_id: '32686', docstatus: 0, items, b24_deal_stages: JSON.stringify(stages) };
	return {
		async list(type: string) {
			if (type === 'Sales Order') return [{ name: 'SO', b24_deal_id: '32686', creation: '2026-10-01' }];
			if (type === 'Item') return [{ name: '9916', is_stock_item: 0 }, { name: '42', is_stock_item: 1 }, { name: '18816', is_stock_item: 1 }, { name: '9254', is_stock_item: 0 }];
			if (type === 'Delivery Note') return delivered ? [{ name: 'DN' }] : [];
			if (type === 'Stock Ledger Entry') return [];
			throw new Error(`Unexpected ${type}`);
		},
		async get(type: string) {
			if (type === 'Sales Order') return order;
			if (type === 'Delivery Note') return { name: 'DN', b24_deal_id: '32686', docstatus: 1, currency: 'RUB', conversion_rate: 1,
				items: [{ name: 'DN-service', item_code: '9916', base_net_amount: 154000, stock_qty: 1 }] };
			throw new Error(`Unexpected ${type}`);
		},
		async update() { throw new Error('Read-only report must not write'); },
		async create() { throw new Error('Read-only report must not set up fields'); },
	} as unknown as ErpClient;
}

test('services of closed composition respect duplicate lines, discounted stages and pass-through services', async () => {
	const erp = fixture([{ item_code: '9916', qty: 2, rate: 100 }, { item_code: '9916', qty: 3, rate: 200 },
		{ item_code: '42', qty: 2, rate: 1000 }, { item_code: '18816', qty: 1, rate: 30 }, { item_code: '9254', qty: 1, rate: 50 }],
		[{ items: [{ productId: 9916, qty: 3, price: 300, discountPercent: 10 }] }]);
	assert.deepEqual((await readClosedDealServices(erp, [32686])).get(32686), { revenue: 1290, profitBase: 1240, goodsQty: 2, serviceQty: 7 });
});

test('missing composition keeps explicit legacy fallback; corrupted service price or type never becomes zero', async () => {
	const empty = { async list() { return []; } } as unknown as ErpClient;
	assert.equal((await readClosedDealServices(empty, [32686])).get(32686), null);
	await assert.rejects(readClosedDealServices(fixture([{ item_code: '9916', qty: 1, rate: null }]), [32686]), /цена/);
	await assert.rejects(readClosedDealServices(fixture([{ item_code: 'UNKNOWN', qty: 1, rate: 1 }]), [32686]), /тип позиции/);
});

test('success-only report includes services without a delivery and never double counts historical service delivery', async () => {
	const client = {
		async call(method: string, params: Record<string, unknown>) {
			if (method === 'crm.deal.list') { assert.equal((params.filter as Record<string, unknown>).STAGE_SEMANTIC_ID, 'S'); return [{ ID: 32686 }]; }
			if (method === 'app.option.get') return { profit_coef: 0.5 };
			if (method === 'crm.category.list' || method === 'crm.status.list') return [];
			throw new Error(`Unexpected ${method}`);
		},
		async callBatch() { throw new Error('No native collapsed amount or catalog price'); },
	} as unknown as B24Client;
	for (const posted of [false, true]) {
		const report = await buildSalesReport(client, { from: '2026-10-01', to: '2026-10-01' }, fixture([{ item_code: '9916', qty: 1, rate: 154000 }], [], posted));
		assert.equal(report.rows[0]?.worksSum, 154000);
		assert.equal(report.rows[0]?.worksProfit, 77000);
		assert.equal(report.rows[0]?.goodsProfit, 0);
		assert.match(report.rows[0]?.profitStatus ?? '', /услуги по составу закрытой сделки/);
	}
});
