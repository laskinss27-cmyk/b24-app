/**
 * Sales report: successfully closed deals selected by CLOSEDATE. Revenue and goods
 * profit come from posted ERP deliveries net of returns; stock cost is the signed
 * ledger value. Service profit is explicitly estimated using profit_coef.
 * buildPlannedSalesReport retains the old calculation for migration/regression
 * reference; production report routes call buildSalesReport only.
 */
import { B24Client, type BatchCall } from './client.js';
import { dealLinePurchasingPrice, isPassThroughProduct } from '@b24-app/shared';
import { ErpClient } from '../erp/client.js';
import { readConsumablesReportRows } from './sales-report-consumables.js';
import { readDealsActualProfit } from '../erp/deal-profit.js';

/** TYPE строки сделки: 1 = товар, 7 = работа/услуга (как в crm.deal.productrows). */
const WORK_TYPE = 7;

export interface SalesReportParams {
	/** YYYY-MM-DD, включительно (фильтр >=CLOSEDATE). */
	from: string;
	/** YYYY-MM-DD, включительно (фильтр <=CLOSEDATE). */
	to: string;
	/** Воронки (CATEGORY_ID). Пусто/нет — все воронки. */
	categoryIds?: number[];
}

export interface SalesReportRow {
	dealId: number;
	category: string;
	/** Источник сделки (SOURCE_ID) — на какой точке/складе оформлена. */
	source: string;
	/** Сырые значения из Б24 (ISO/date) — формат в CSV делает фронт. */
	dateCreate: string;
	dateClosed: string;
	title: string;
	manager: string;
	goodsSum: number;
	worksSum: number;
	goodsProfit: number | null;
	profitStatus?: string;
	worksProfit: number;
	/** Сколько товарных позиций сделки без заполненной закупки (прибыль по ним не учтена). */
	goodsNoPurchase: number;
}

export interface SalesReportData {
	rows: SalesReportRow[];
	coef: number;
	generatedAt: string;
}

function numOrNull(v: unknown): number | null {
	return v == null || v === '' ? null : Number(v);
}

/** Все страницы crm.deal.list серверным start (OAuth-REST уважает start, в отличие от фронтового BX24). */
async function pageDeals(client: B24Client, filter: Record<string, unknown>, select: string[]): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	let start = 0;
	for (let i = 0; i < 400; i++) {
		const page = await client.call<Array<Record<string, unknown>>>('crm.deal.list', { filter, select, order: { CLOSEDATE: 'ASC', ID: 'ASC' }, start });
		if (!page || !page.length) break;
		out.push(...page);
		if (page.length < 50) break;
		start += 50;
		if (i === 399) throw new Error('Слишком много сделок: сузьте период отчёта; неполный результат не выдан');
	}
	return out;
}

/** Имена воронок: CATEGORY_ID → название (crm.category.list entityTypeId=2). */
async function fetchCategoryNames(client: B24Client): Promise<Map<number, string>> {
	const map = new Map<number, string>();
	try {
		const res = await client.call<{ categories?: Array<Record<string, unknown>> }>('crm.category.list', { entityTypeId: 2 });
		for (const c of res?.categories ?? []) map.set(Number(c['id']), String(c['name'] ?? `Воронка ${c['id']}`));
	} catch {
		/* без имён — покажем id */
	}
	// Воронка 0 «Объекты» в некоторых порталах не возвращается category.list — подстрахуемся.
	if (!map.has(0)) map.set(0, 'Объекты');
	return map;
}

/** ФИО менеджеров по набору ID (батч user.get). */
async function fetchManagerNames(client: B24Client, ids: number[]): Promise<Map<number, string>> {
	const map = new Map<number, string>();
	const uniq = [...new Set(ids.filter((x) => x > 0))];
	if (!uniq.length) return map;
	const calls: Record<string, BatchCall> = {};
	for (const id of uniq) calls[`u${id}`] = { method: 'user.get', params: { ID: id } };
	const res = await client.callBatch(calls);
	for (const id of uniq) {
		const arr = res.result[`u${id}`] as Array<Record<string, unknown>> | undefined;
		const u = Array.isArray(arr) ? arr[0] : undefined;
		const name = u ? `${u['LAST_NAME'] ?? ''} ${u['NAME'] ?? ''}`.trim() : '';
		map.set(id, name || `ID ${id}`);
	}
	return map;
}

/** Источники сделок: SOURCE_ID → название (crm.status.list ENTITY_ID='SOURCE'). У портала
 *  источники = точки продаж/склады (см. маппинг быстрой продажи). */
async function fetchSourceNames(client: B24Client): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	try {
		const res = await client.call<Array<Record<string, unknown>>>('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' }, order: { SORT: 'ASC' } });
		for (const s of res ?? []) map.set(String(s['STATUS_ID']), String(s['NAME'] ?? s['STATUS_ID']));
	} catch {
		/* без имён — покажем код источника */
	}
	return map;
}

/** Коэффициент прибыли услуг (app.option profit_coef, дефолт 0.5). */
async function fetchCoef(client: B24Client): Promise<number> {
	try {
		const res = await client.call<Record<string, unknown>>('app.option.get', {});
		const n = Number(res?.['profit_coef']);
		return Number.isFinite(n) && n > 0 ? n : 0.5;
	} catch {
		return 0.5;
	}
}

/** Строки товаров по сделкам: dealId → массив строк (батч crm.deal.productrows.get). */
async function fetchProductRows(client: B24Client, dealIds: number[]): Promise<Map<number, Array<Record<string, unknown>>>> {
	const map = new Map<number, Array<Record<string, unknown>>>();
	if (!dealIds.length) return map;
	const calls: Record<string, BatchCall> = {};
	for (const id of dealIds) calls[`d${id}`] = { method: 'crm.deal.productrows.get', params: { id } };
	const res = await client.callBatch(calls);
	for (const id of dealIds) {
		const rows = res.result[`d${id}`];
		map.set(id, Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []);
	}
	return map;
}

/** Закупочные цены товаров: productId → purchasingPrice|null (батч catalog.product.get). */
async function fetchPurchasing(client: B24Client, productIds: number[]): Promise<Map<number, number | null>> {
	const map = new Map<number, number | null>();
	const uniq = [...new Set(productIds.filter((x) => x > 0))];
	if (!uniq.length) return map;
	const calls: Record<string, BatchCall> = {};
	for (const id of uniq) calls[`p${id}`] = { method: 'catalog.product.get', params: { id } };
	const res = await client.callBatch(calls);
	for (const id of uniq) {
		const p = (res.result[`p${id}`] as { product?: Record<string, unknown> } | undefined)?.product;
		map.set(id, p ? numOrNull(p['purchasingPrice']) : null);
	}
	return map;
}

/** Retained solely as an explicit preliminary calculation and migration reference. */
export async function buildPlannedSalesReport(client: B24Client, params: SalesReportParams, erp: ErpClient | null = ErpClient.fromEnv()): Promise<SalesReportData> {
	const filter: Record<string, unknown> = {
		STAGE_SEMANTIC_ID: 'S',
		'>=CLOSEDATE': params.from,
		'<=CLOSEDATE': params.to,
	};
	if (params.categoryIds && params.categoryIds.length) filter['CATEGORY_ID'] = params.categoryIds;

	const deals = await pageDeals(client, filter, ['ID', 'TITLE', 'CATEGORY_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'CLOSEDATE', 'OPPORTUNITY', 'SOURCE_ID']);

	const [categoryNames, sourceNames, coef] = await Promise.all([fetchCategoryNames(client), fetchSourceNames(client), fetchCoef(client)]);
	const managerNames = await fetchManagerNames(client, deals.map((d) => Number(d['ASSIGNED_BY_ID'])));
	const rowsByDeal = await fetchProductRows(client, deals.map((d) => Number(d['ID'])));
	for (const [dealId, rows] of rowsByDeal) {
		const coreRows = await readConsumablesReportRows(erp, dealId, rows);
		if (coreRows) rowsByDeal.set(dealId, coreRows);
	}

	// все товарные productId (TYPE != 7) — для закупок одним проходом
	const goodsIds: number[] = [];
	for (const rows of rowsByDeal.values()) {
		for (const r of rows) {
			if (Number(r['TYPE']) !== WORK_TYPE && !('CORE_PURCHASING_PRICE' in r) && !isPassThroughProduct(Number(r['PRODUCT_ID']))) {
				const pid = Number(r['PRODUCT_ID'] ?? 0);
				if (pid > 0) goodsIds.push(pid);
			}
		}
	}
	const purchasing = await fetchPurchasing(client, goodsIds);

	const out: SalesReportRow[] = deals.map((d) => {
		const dealId = Number(d['ID']);
		const rows = rowsByDeal.get(dealId) ?? [];
		let goodsSum = 0;
		let worksSum = 0;
		let worksProfit = 0;
		let goodsProfit = 0;
		let goodsNoPurchase = 0;
		for (const r of rows) {
			const price = Number(r['PRICE'] ?? 0);
			const qty = Number(r['QUANTITY'] ?? 0);
			const line = price * qty;
			if (Number(r['TYPE']) === WORK_TYPE) {
				worksSum += line;
				if (!isPassThroughProduct(Number(r['PRODUCT_ID']))) worksProfit += line * coef;
			} else {
				goodsSum += line;
				const productId = Number(r['PRODUCT_ID'] ?? 0);
				const catalogPurchase = 'CORE_PURCHASING_PRICE' in r ? numOrNull(r.CORE_PURCHASING_PRICE) : purchasing.get(productId);
				const pp = dealLinePurchasingPrice(productId, price, catalogPurchase);
				if (pp == null) goodsNoPurchase++;
				else goodsProfit += (price - pp) * qty;
			}
		}
		return {
			dealId,
			category: categoryNames.get(Number(d['CATEGORY_ID'])) ?? `Воронка ${d['CATEGORY_ID']}`,
			source: d['SOURCE_ID'] ? (sourceNames.get(String(d['SOURCE_ID'])) ?? String(d['SOURCE_ID'])) : '',
			dateCreate: String(d['DATE_CREATE'] ?? ''),
			dateClosed: String(d['CLOSEDATE'] ?? ''),
			title: String(d['TITLE'] ?? `Сделка #${dealId}`),
			manager: managerNames.get(Number(d['ASSIGNED_BY_ID'])) ?? String(d['ASSIGNED_BY_ID'] ?? ''),
			goodsSum,
			worksSum,
			goodsProfit,
			worksProfit,
			goodsNoPurchase,
		};
	});

	return { rows: out, coef, generatedAt: new Date().toISOString() };
}

/** Actual posted sales; current catalog prices and native collapsed rows are never used. */
export async function buildSalesReport(client: B24Client, params: SalesReportParams, erp: ErpClient | null = ErpClient.fromEnv()): Promise<SalesReportData> {
	if (!erp) throw new Error('Фактическая прибыль недоступна: ядро склада не подключено');
	const filter: Record<string, unknown> = {
		STAGE_SEMANTIC_ID: 'S',
		'>=CLOSEDATE': `${params.from}T00:00:00+03:00`,
		'<=CLOSEDATE': `${params.to}T23:59:59+03:00`,
	};
	if (params.categoryIds?.length) filter.CATEGORY_ID = params.categoryIds;
	const deals = await pageDeals(client, filter, ['ID', 'TITLE', 'CATEGORY_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'CLOSEDATE', 'SOURCE_ID']);
	const [categories, sources, coef, managers, profits] = await Promise.all([
		fetchCategoryNames(client), fetchSourceNames(client), fetchCoef(client),
		fetchManagerNames(client, deals.map(d => Number(d.ASSIGNED_BY_ID))),
		readDealsActualProfit(erp, deals.map(d => Number(d.ID))),
	]);
	return { coef, generatedAt: new Date().toISOString(), rows: deals.map(d => {
		const dealId = Number(d.ID);
		const profit = profits.get(dealId)!;
		return {
			dealId, category: categories.get(Number(d.CATEGORY_ID)) ?? `Воронка ${d.CATEGORY_ID}`,
			source: sources.get(String(d.SOURCE_ID ?? '')) ?? String(d.SOURCE_ID ?? ''),
			dateCreate: String(d.DATE_CREATE ?? ''), dateClosed: String(d.CLOSEDATE ?? ''),
			title: String(d.TITLE ?? `Сделка #${dealId}`), manager: managers.get(Number(d.ASSIGNED_BY_ID)) ?? String(d.ASSIGNED_BY_ID ?? ''),
			goodsSum: profit.goodsRevenue, worksSum: profit.worksRevenue,
			goodsProfit: profit.goodsProfit, worksProfit: Math.round(profit.worksProfitBase * coef * 100) / 100,
			goodsNoPurchase: profit.missingCostLines,
			profitStatus: !profit.documentCount ? 'Нет проведённых реализаций' : profit.missingCostLines ? `Неполные данные: ${profit.missingCostLines} строк` : 'По проведённым реализациям и возвратам',
		};
	}) };
}
