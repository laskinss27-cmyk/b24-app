import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDealActualProfit, readDealsActualProfit } from './deal-profit.js';
import type { ErpClient } from './client.js';
import { buildSalesReport } from '../b24/sales-report.js';
import type { B24Client } from '../b24/client.js';

const item = { name: '101', is_stock_item: 1 };
const line = { name: 'row1', item_code: '101', stock_qty: 3, base_net_amount: 900, warehouse: 'A' };
const doc = { name: 'DN1', docstatus: 1, currency: 'RUB', conversion_rate: 1, b24_deal_id: '1', items: [line] };
const entry = { voucher_no: 'DN1', voucher_detail_no: 'row1', item_code: '101', warehouse: 'A', actual_qty: -3, stock_value_difference: -350, is_cancelled: 0 };

test('actual cost uses signed posted FIFO value across price layers, not current catalog price', () => {
	const result = calculateDealActualProfit([doc], [entry], [{ ...item, valuation_rate: 999, last_purchase_rate: 999 }]);
	assert.equal(result.goodsCost, 350);
	assert.equal(result.goodsProfit, 550); // e.g. 2 x 100 + 1 x 150 consumed
});

test('returns reduce revenue and cost; cancelled and draft deliveries do not contribute', () => {
	const returned = { ...doc, name: 'RET', is_return: 1, items: [{ ...line, name: 'retrow', stock_qty: -1, base_net_amount: -300 }] };
	const retEntry = { ...entry, voucher_no: 'RET', voucher_detail_no: 'retrow', actual_qty: 1, stock_value_difference: 100 };
	const result = calculateDealActualProfit([doc, returned, { ...doc, docstatus: 0 }, { ...doc, docstatus: 2 }], [entry, retEntry, { ...entry, is_cancelled: 1 }], [item]);
	assert.equal(result.documentCount, 2);
	assert.equal(result.goodsRevenue, 600);
	assert.equal(result.goodsCost, 250);
	assert.equal(result.goodsProfit, 350);
});

test('missing, incomplete, cancelled, wrong-warehouse and technical-value ledger cannot become profit', () => {
	for (const entries of [[], [{ ...entry, actual_qty: -2 }], [{ ...entry, is_cancelled: 1 }], [{ ...entry, warehouse: 'B' }], [{ ...entry, stock_value_difference: 0 }], [{ ...entry, stock_value_difference: -0.03 }], [{ ...entry, stock_value_difference: null }]]) {
		const result = calculateDealActualProfit([doc], entries, [item]);
		assert.equal(result.goodsProfit, null);
		assert.equal(result.goodsCost, null);
		assert.equal(result.missingCostLines, 1);
	}
});

test('duplicate product rows are matched by document row, stock units determine coverage', () => {
	const result = calculateDealActualProfit([{ ...doc, items: [line, { ...line, name: 'row2', stock_qty: 10, base_net_amount: 1000 }] }], [entry, { ...entry, voucher_detail_no: 'row2', actual_qty: -10, stock_value_difference: -400 }], [item]);
	assert.equal(result.goodsProfit, 1150);
});

test('consumables remain pass-through, services remain estimates, client repair equipment is excluded', () => {
	const lines = [
		{ ...line, item_code: '18612', base_net_amount: 500 },
		{ ...line, item_code: 'B24-SERVICE-18816', base_net_amount: 1000 },
		{ ...line, item_code: 'REPAIR-1', base_net_amount: 0 },
	];
	const result = calculateDealActualProfit([{ ...doc, items: lines }], [], [
		{ name: '18612', is_stock_item: 1 }, { name: 'B24-SERVICE-18816', is_stock_item: 0 },
		{ name: 'REPAIR-1', is_stock_item: 1, item_group: 'Ремонтное оборудование' },
	]);
	assert.equal(result.goodsRevenue, 500);
	assert.equal(result.goodsProfit, 0);
	assert.equal(result.worksProfitBase, 1000);
});

test('no posted documents has no confirmed profit; unknown commercial codes are not silently discarded', () => {
	assert.equal(calculateDealActualProfit([], [], []).goodsProfit, null);
	assert.equal(calculateDealActualProfit([{ ...doc, items: [{ ...line, item_code: 'UNKNOWN' }] }], [], []).missingCostLines, 1);
});

function erpFixture(): ErpClient {
	return {
		async list(type: string) {
			if (type === 'Sales Order') return [];
			if (type === 'Delivery Note') return [{ name: 'DN1' }];
			if (type === 'Stock Ledger Entry') return [entry];
			if (type === 'Item') return [item];
			throw new Error(`Unexpected read ${type}`);
		},
		async get() { return doc; },
		async update() { throw new Error('Must remain read-only'); },
	} as unknown as ErpClient;
}

test('shared reader includes empty deals and never writes to ERP', async () => {
	const results = await readDealsActualProfit(erpFixture(), [1, 2]);
	assert.equal(results.get(1)?.goodsProfit, 550);
	assert.equal(results.get(2)?.goodsProfit, null);
});

test('sales report uses posted actuals, never native collapsed rows; date end includes the entire day', async () => {
	const client = {
		async call(method: string, params: Record<string, unknown>) {
			if (method === 'crm.deal.list') {
				assert.equal((params.filter as Record<string, unknown>)['<=CLOSEDATE'], '2026-09-30T23:59:59+03:00');
				return [{ ID: 1 }, { ID: 2 }];
			}
			if (method === 'app.option.get') return { profit_coef: 0.5 };
			if (['crm.category.list', 'crm.status.list'].includes(method)) return [];
			throw new Error(`Unexpected ${method}`);
		},
		async callBatch() { throw new Error('No native row or catalog lookup expected'); },
	} as unknown as B24Client;
	const result = await buildSalesReport(client, { from: '2026-09-01', to: '2026-09-30' }, erpFixture());
	assert.equal(result.rows[0]?.goodsProfit, 550);
	assert.equal(result.rows[1]?.goodsProfit, null);
	assert.equal(result.rows[1]?.profitStatus, 'Нет проведённых реализаций');
	await assert.rejects(buildSalesReport(client, { from: '2026-09-01', to: '2026-09-30' }, null), /ядро склада/);
});
