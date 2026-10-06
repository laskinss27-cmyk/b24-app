import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateRepairProfit, readDealRepairProfits } from './repair-profit.js';
import { buildSalesReport } from './b24/sales-report.js';
import type { B24Client } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import Fastify from 'fastify';
import { registerDealCoreRealizationRoute } from './routes/deal-core-realization-route.js';

const card = { dealId: 10, kind: 'client', payType: 'paid', ourPrice: 5000, cost: 3000 };
const composition = { repairRevenue: 5000, repairQty: 1 };

test('paid repair uses the two card prices, including genuine zero and losses', () => {
	assert.equal(calculateRepairProfit(10, composition, [card]).profit, 2000);
	assert.equal(calculateRepairProfit(10, composition, [{ ...card, cost: 0 }]).profit, 5000);
	assert.equal(calculateRepairProfit(10, composition, [{ ...card, cost: 6000 }]).profit, -1000);
	assert.equal(calculateRepairProfit(10, { repairQty: 1, repairRevenue: 0 }, [{ ...card, ourPrice: 0 }]).profit, -3000);
});

test('missing or invalid cost is unknown, not zero; missing client price is unknown too', () => {
	for (const cost of [null, undefined, '', ' ', 'bad', -1, Infinity, false]) {
		const result = calculateRepairProfit(10, composition, [{ ...card, cost }]);
		assert.equal(result.profit, null); assert.equal(result.serviceCost, null); assert.match(result.status, /цена СЦ/);
	}
	assert.equal(calculateRepairProfit(10, composition, [{ ...card, ourPrice: null }]).profit, null);
});

test('warranty, presale, refusal, other deals and ambiguous links cannot contribute paid repair profit', () => {
	for (const cards of [[{ ...card, payType: 'warranty' }], [{ ...card, kind: 'presale' }], [{ ...card, clientRefusal: { reason: 'no' } }], [{ ...card, dealId: 20 }], [card, card], []]) {
		assert.equal(calculateRepairProfit(10, composition, cards).profit, null);
	}
	assert.equal(calculateRepairProfit(10, composition, [{ ...card, kind: undefined }]).profit, 2000);
});

test('plan discount, duplicated quantity or historical reversal cannot silently disagree with repair card', () => {
	for (const c of [{ repairRevenue: 4500, repairQty: 1 }, { ...composition, repairQty: 2 }, { repairRevenue: 0, repairQty: 0 }, { ...composition, repairQty: NaN }, { ...composition, repairRevenue: NaN }]) {
		assert.match(calculateRepairProfit(10, c, [card]).status, /не совпадает/);
	}
});

function b24(cost: unknown = 3000, fail = false): B24Client {
	return {
		async call(method: string, params: Record<string, unknown>) {
			if (method === 'crm.deal.list') { assert.equal((params.filter as Record<string, unknown>).STAGE_SEMANTIC_ID, 'S'); return [{ ID: 10 }]; }
			if (method === 'app.option.get') return { profit_coef: 0.5 };
			if (method === 'crm.category.list' || method === 'crm.status.list') return [];
			throw new Error(`Unexpected ${method}`);
		},
		async callWithMeta(method: string, params: Record<string, unknown>) {
			assert.equal(method, 'entity.item.get'); assert.equal(params.ENTITY, 'ctv_repairs');
			if (fail) throw new Error('No app context');
			if (params.start === 0) return { result: [{ ID: '1', DETAIL_TEXT: JSON.stringify({ ...card, dealId: 20 }) }], next: 50 };
			assert.equal(params.start, 50);
			return { result: [{ ID: '2', DETAIL_TEXT: JSON.stringify({ ...card, cost }) }] };
		},
	} as unknown as B24Client;
}

function erp(plan: boolean, delivered: boolean): ErpClient {
	const items = [{ item_code: '19108', qty: 1, rate: 5000, base_net_amount: 5000, stock_qty: 1 }, { item_code: '9916', qty: 1, rate: 1000, base_net_amount: 1000, stock_qty: 1 }];
	return {
		async list(type: string) {
			if (type === 'Sales Order') return plan ? [{ name: 'SO', b24_deal_id: 10, creation: '2026-10-01' }] : [];
			if (type === 'Delivery Note') return delivered ? [{ name: 'DN' }] : [];
			if (type === 'Stock Ledger Entry') return [];
			if (type === 'Item') return [{ name: '19108', is_stock_item: 0 }, { name: '9916', is_stock_item: 0 }];
			throw new Error(`Unexpected ${type}`);
		},
		async get(type: string) {
			if (type === 'Sales Order') return { name: 'SO', b24_deal_id: 10, docstatus: 0, items };
			if (type === 'Delivery Note') return { name: 'DN', b24_deal_id: 10, docstatus: 1, currency: 'RUB', conversion_rate: 1, items };
			throw new Error(`Unexpected ${type}`);
		},
		async create() { throw new Error('No writes'); }, async update() { throw new Error('No writes'); },
	} as unknown as ErpClient;
}

test('report substitutes repair profit once, preserving ordinary services and legacy no-plan fallback', async () => {
	for (const [plan, delivered] of [[true, false], [true, true], [false, true]]) {
		const report = await buildSalesReport(b24(), { from: '2026-10-01', to: '2026-10-06' }, erp(plan!, delivered!));
		assert.equal(report.rows[0]?.worksSum, 6000);
		assert.equal(report.rows[0]?.worksProfit, 2500); // 5000 - 3000 + 1000 * 0.5
		assert.equal(report.rows[0]?.goodsProfit, 0);
		assert.match(report.rows[0]?.profitStatus ?? '', /Цена клиенту минус цена СЦ/);
	}
});

test('unavailable repair cost or denied app context leaves report profit unknown without hiding goods', async () => {
	for (const client of [b24(null), b24(3000, true)]) {
		const report = await buildSalesReport(client, { from: '2026-10-01', to: '2026-10-06' }, erp(true, false));
		assert.equal(report.rows[0]?.worksProfit, null);
		assert.equal(report.rows[0]?.worksSum, 6000);
		assert.equal(report.rows[0]?.goodsProfit, 0);
	}
});

test('ordinary deals do not scan repairs, and paid repair scans follow all pages once', async () => {
	assert.equal((await readDealRepairProfits({} as B24Client, new Map([[10, {}]]))).size, 0);
	const result = await readDealRepairProfits(b24(), new Map([[10, composition], [20, composition]]));
	assert.equal(result.get(10)?.profit, 2000); assert.equal(result.get(20)?.profit, 2000);
});

test('repair profit HTTP route is read-only, authenticated and independent of realizations', async t => {
	t.mock.method(ErpClient, 'fromEnv', () => erp(true, false));
	const app = Fastify();
	registerDealCoreRealizationRoute(app, body => body.accessToken === 'fixture' ? b24() : null, async () => { throw new Error('Must not sync'); });
	t.after(() => app.close());
	const request = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/deal/repair-profit', payload });
	assert.equal((await request({ dealId: 10 })).statusCode, 403);
	assert.equal((await request({ accessToken: 'fixture', dealId: -1 })).statusCode, 400);
	const response = await request({ accessToken: 'fixture', dealId: 10 });
	assert.equal(response.json().repairProfit.profit, 2000);
	assert.equal(response.json().repairProfit.serviceCost, 3000);
});
