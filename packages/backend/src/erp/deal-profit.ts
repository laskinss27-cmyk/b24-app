import { isPassThroughProduct, type DealActualProfit } from '@b24-app/shared';
import { dealProductIdFromCoreItemCode } from '../deal-service-product-ids.js';
import type { ErpClient } from './client.js';
import { listWithBatchedInFilters as list } from './list-batched.js';

type Row = Record<string, unknown>;
const finite = (value: unknown): number | null => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** Pure calculation: never consult current catalog prices or mutate stock history. */
export function calculateDealActualProfit(documents: Row[], ledger: Row[], items: Row[]): DealActualProfit {
	const posted = documents.filter(d => Number(d.docstatus) === 1);
	const result: DealActualProfit = { documentCount: posted.length, goodsRevenue: 0, worksRevenue: 0, worksProfitBase: 0, goodsCost: null, goodsProfit: null, missingCostLines: 0, issues: [] };
	const catalog = new Map(items.map(i => [String(i.name), i]));
	let cost = 0;
	for (const doc of posted) {
		for (const row of (doc.items ?? []) as Row[]) {
			const code = String(row.item_code);
			const id = dealProductIdFromCoreItemCode(code);
			const item = catalog.get(code);
			const amount = finite(row.base_net_amount);
			const qty = finite(row.stock_qty);
			// Customer-owned equipment is returned to its owner, not sold.
			if (/^REPAIR-\d+$/.test(code) && item?.item_group === 'Ремонтное оборудование' && amount === 0) continue;
			const issue = (reason: string): void => {
				result.missingCostLines++;
				result.issues.push(`${doc.name}/${row.name}: ${reason}`);
			};
			if (amount == null || !item || id == null || String(doc.currency) !== 'RUB' || Number(doc.conversion_rate) !== 1) {
				issue('не подтверждены сумма, валюта или тип строки');
				continue;
			}
			if (Number(item.is_stock_item) === 0) {
				result.worksRevenue += amount;
				if (!isPassThroughProduct(id)) result.worksProfitBase += amount;
				continue;
			}
			result.goodsRevenue += amount;
			// Consumables are explicitly pass-through, irrespective of their stock valuation.
			if (isPassThroughProduct(id)) { cost += amount; continue; }
			const entries = ledger.filter(l => Number(l.is_cancelled) === 0 && l.voucher_no === doc.name && l.voucher_detail_no === row.name && l.item_code === code && l.warehouse === row.warehouse);
			const stockQty = entries.reduce((sum, l) => sum + Number(l.actual_qty), 0);
			const stockValue = entries.reduce((sum, l) => sum + Number(l.stock_value_difference), 0);
			if (!entries.length || qty == null || !Number.isFinite(stockQty) || Math.abs(stockQty + qty) > 0.000001 || entries.some(l => finite(l.stock_value_difference) == null) || !Number.isFinite(stockValue)) {
				issue('нет полной складской проводки');
				continue;
			}
			if (Math.abs(qty) > 0.000001 && (stockValue * qty >= 0 || Math.abs(stockValue / qty) <= 0.010001)) {
				issue('нулевая, техническая или несогласованная себестоимость');
				continue;
			}
			cost -= stockValue;
		}
	}
	result.goodsRevenue = money(result.goodsRevenue);
	result.worksRevenue = money(result.worksRevenue);
	result.worksProfitBase = money(result.worksProfitBase);
	if (posted.length && !result.missingCostLines) {
		result.goodsCost = money(cost);
		result.goodsProfit = money(result.goodsRevenue - cost);
	}
	return result;
}

/** Read-only, shared by deal UI, sales reports and retrospective audits. */
export async function readDealsActualProfit(erp: ErpClient, dealIds: number[]): Promise<Map<number, DealActualProfit>> {
	if (!dealIds.length) return new Map();
	const heads = await list<Row>(erp, 'Delivery Note', ['name'], [['b24_deal_id', 'in', dealIds.map(String)], ['docstatus', '=', 1]]);
	const documents: Row[] = [];
	for (let i = 0; i < heads.length; i += 4) {
		const batch = await Promise.all(heads.slice(i, i + 4).map(h => erp.get<Row>('Delivery Note', String(h.name))));
		for (const document of batch) {
			if (!document || Number(document.docstatus) !== 1) throw new Error('Реализации изменились во время расчёта; обновите отчёт');
			documents.push(document);
		}
	}
	const names = documents.map(d => String(d.name));
	const codes = [...new Set(documents.flatMap(d => ((d.items ?? []) as Row[]).map(i => String(i.item_code))))];
	const [ledger, items] = await Promise.all([
		names.length ? list<Row>(erp, 'Stock Ledger Entry', ['voucher_no', 'voucher_detail_no', 'item_code', 'warehouse', 'actual_qty', 'stock_value_difference', 'is_cancelled'], [['voucher_type', '=', 'Delivery Note'], ['voucher_no', 'in', names], ['is_cancelled', '=', 0]]) : [],
		codes.length ? list<Row>(erp, 'Item', ['name', 'is_stock_item', 'item_group'], [['name', 'in', codes]]) : [],
	]);
	return new Map(dealIds.map(id => [id, calculateDealActualProfit(documents.filter(d => String(d.b24_deal_id) === String(id)), ledger, items)]));
}
