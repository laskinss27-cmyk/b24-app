/**
 * Отчёт по продажам за период по каждому менеджеру — сборка на БЭКЕНДЕ.
 *
 * Одна строка = одна ВЫИГРАННАЯ сделка (STAGE_SEMANTIC_ID='S') за период (по CLOSEDATE).
 * Колонки: воронка, дата создания, дата перевода в успех, название, ФИО менеджера,
 * сумма товаров, сумма услуг, прибыль товаров, прибыль услуг, позиций без закупки.
 *
 * Прибыль товаров = Σ(цена−закупка)×кол-во ТОЛЬКО по позициям с известной закупкой
 * (catalog.product.purchasingPrice); позиции без закупки считаем в отдельный счётчик
 * (решение Сергея 2026-06-05 — честнее, чем занулять закупку). Прибыль услуг = сумма
 * услуг × коэффициент (app.option profit_coef, дефолт 0.5 — как во вкладке сделки).
 *
 * Тяжёлое (строки + закупки по сотням сделок) — серверным B24Client батчами, как «База».
 */
import { B24Client, type BatchCall } from './client.js';

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
	/** Сырые значения из Б24 (ISO/date) — формат в CSV делает фронт. */
	dateCreate: string;
	dateClosed: string;
	title: string;
	manager: string;
	goodsSum: number;
	worksSum: number;
	goodsProfit: number;
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
		const page = await client.call<Array<Record<string, unknown>>>('crm.deal.list', { filter, select, order: { CLOSEDATE: 'ASC' }, start });
		if (!page || !page.length) break;
		out.push(...page);
		if (page.length < 50) break;
		start += 50;
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

export async function buildSalesReport(client: B24Client, params: SalesReportParams): Promise<SalesReportData> {
	const filter: Record<string, unknown> = {
		STAGE_SEMANTIC_ID: 'S',
		'>=CLOSEDATE': params.from,
		'<=CLOSEDATE': params.to,
	};
	if (params.categoryIds && params.categoryIds.length) filter['CATEGORY_ID'] = params.categoryIds;

	const deals = await pageDeals(client, filter, ['ID', 'TITLE', 'CATEGORY_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'CLOSEDATE', 'OPPORTUNITY']);

	const [categoryNames, coef] = await Promise.all([fetchCategoryNames(client), fetchCoef(client)]);
	const managerNames = await fetchManagerNames(client, deals.map((d) => Number(d['ASSIGNED_BY_ID'])));
	const rowsByDeal = await fetchProductRows(client, deals.map((d) => Number(d['ID'])));

	// все товарные productId (TYPE != 7) — для закупок одним проходом
	const goodsIds: number[] = [];
	for (const rows of rowsByDeal.values()) {
		for (const r of rows) {
			if (Number(r['TYPE']) !== WORK_TYPE) {
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
		let goodsProfit = 0;
		let goodsNoPurchase = 0;
		for (const r of rows) {
			const price = Number(r['PRICE'] ?? 0);
			const qty = Number(r['QUANTITY'] ?? 0);
			const line = price * qty;
			if (Number(r['TYPE']) === WORK_TYPE) {
				worksSum += line;
			} else {
				goodsSum += line;
				const pp = purchasing.get(Number(r['PRODUCT_ID'] ?? 0));
				if (pp == null) goodsNoPurchase++;
				else goodsProfit += (price - pp) * qty;
			}
		}
		return {
			dealId,
			category: categoryNames.get(Number(d['CATEGORY_ID'])) ?? `Воронка ${d['CATEGORY_ID']}`,
			dateCreate: String(d['DATE_CREATE'] ?? ''),
			dateClosed: String(d['CLOSEDATE'] ?? ''),
			title: String(d['TITLE'] ?? `Сделка #${dealId}`),
			manager: managerNames.get(Number(d['ASSIGNED_BY_ID'])) ?? String(d['ASSIGNED_BY_ID'] ?? ''),
			goodsSum,
			worksSum,
			goodsProfit,
			worksProfit: worksSum * coef,
			goodsNoPurchase,
		};
	});

	return { rows: out, coef, generatedAt: new Date().toISOString() };
}
