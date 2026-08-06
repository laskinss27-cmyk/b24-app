import { canonicalProductId } from '@b24-app/shared';
import { bx24Auth } from './bitrix-auth.js';
import { call } from './bitrix-client.js';
import type { DealProductRow } from './deal-fulfillment.js';
import type { StoreInfo } from './product-catalog.js';

/** TYPE строки: 1 = товар, 4 = торговое предложение (вариация, ТОЖЕ товар!), 7 = работа/услуга.
 *  Подтверждено живой сделкой 36766: монитор-вариация пришёл с TYPE=4 и выпадал из фильтра
 *  «только TYPE 1». Правило: РАБОТА = TYPE 7, всё остальное = товар. */
export const ROW_TYPE_GOODS = 1;
export const ROW_TYPE_WORK = 7;
export const isWorkRow = (type: number): boolean => type === ROW_TYPE_WORK;

export interface StockAtStore {
	storeId: number;
	amount: number;
}

export interface ProductEnrichment {
	stocks: StockAtStore[];
	/** Нативная закупочная цена каталога. null — не заполнена (источник прибыли уточняем у Володи). */
	purchasingPrice: number | null;
}

// ── Фетчеры ───────────────────────────────────────────────────────────────────

export async function fetchProductRows(dealId: number): Promise<DealProductRow[]> {
	const raw = await call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId });
	return (raw ?? []).map((r) => ({
		id: String(r['ID']),
		productId: canonicalProductId(Number(r['PRODUCT_ID'] ?? 0)),
		name: String(r['PRODUCT_NAME'] ?? ''),
		type: Number(r['TYPE'] ?? 0),
		price: Number(r['PRICE'] ?? 0),
		quantity: Number(r['QUANTITY'] ?? 0),
		discountSum: Number(r['DISCOUNT_SUM'] ?? 0),
		measure: String(r['MEASURE_NAME'] ?? ''),
	}));
}

export async function fetchStores(): Promise<StoreInfo[]> {
	const res = await fetch('/api/catalog/stores', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(bx24Auth()),
	});
	const json = (await res.json()) as { ok?: boolean; error?: string; stores?: StoreInfo[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить склады ядра');
	return json.stores ?? [];
}

/** Коэффициент прибыли работ из app.option (default 0.5). */
export async function fetchProfitCoef(): Promise<number> {
	try {
		const res = await call<Record<string, unknown>>('app.option.get', {});
		const v = res?.['profit_coef'];
		const n = v == null ? NaN : Number(v);
		return Number.isFinite(n) && n > 0 ? n : 0.5;
	} catch {
		return 0.5;
	}
}

/**
 * Для набора товарных productId одним батчем тянем остатки по складам (amount>0)
 * и нативную закупочную цену. Работы (type=7) сюда не передаём — у них нет склада.
 */
export async function fetchStockAndPurchasing(productIds: number[]): Promise<Record<number, ProductEnrichment>> {
	return fetchStockPreferCore(productIds);
}

/** Кэш «название склада ядра → стабильный ID интерфейса». */
let _storeTitleToId: Map<string, number> | null = null;
async function storeTitleToId(): Promise<Map<string, number>> {
	if (_storeTitleToId) return _storeTitleToId;
	const stores = await fetchStores();
	_storeTitleToId = new Map(stores.map((s) => [s.title, s.id]));
	return _storeTitleToId;
}

/**
 * Остатки и закупка только из ЯДРА (ERPNext, /api/catalog/erp-stocks).
 * Склады ядра приходят по имени и маппятся в стабильный ID интерфейса.
 */
export async function fetchStockPreferCore(productIds: number[]): Promise<Record<number, ProductEnrichment>> {
	const ids = productIds.filter((id) => id > 0);
	if (!ids.length) return {};
	try {
		// Таймаут 15с: ядро может быть недоступно — не оставляем загрузку висеть без ограничения.
		const res = await fetch('/api/catalog/erp-stocks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...bx24Auth(), productIds: ids }),
			signal: AbortSignal.timeout(15000),
		});
		const j = (await res.json()) as { ok?: boolean; byProduct?: Record<string, { stocks: Record<string, number>; purchasing: number }> };
		if (j?.ok && j.byProduct) {
			const t2id = await storeTitleToId();
			const out: Record<number, ProductEnrichment> = {};
			for (const [pid, v] of Object.entries(j.byProduct)) {
				const stocks = Object.entries(v.stocks ?? {})
					.map(([title, amount]) => ({ storeId: t2id.get(title) ?? 0, amount: Number(amount) }))
					.filter((s) => s.storeId !== 0 && s.amount > 0);
				out[Number(pid)] = { stocks, purchasingPrice: v.purchasing > 0 ? v.purchasing : null };
			}
			return out;
		}
	} catch { /* ниже возвращается явная ошибка ядра */ }
	throw new Error('не удалось получить остатки ядра');
}
