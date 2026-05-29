/**
 * Тонкая промис-обёртка над BX24.js + доменные фетчеры для вкладки товаров.
 * Всё ЧТЕНИЕ. Запись (создание документов реализации) — отдельная фаза, не здесь.
 *
 * BX24 работает на колбэках; оборачиваем в Promise, чтобы грузить данные async/await.
 * Запросы идут токеном смотрящего пользователя — права Битрикса соблюдаются автоматически.
 */

import type { BX24Sdk } from './b24-context.js';

function getBx24(): BX24Sdk {
	const bx = window.BX24;
	if (!bx) {
		throw new Error('BX24 SDK не загружен (нет <script src="//api.bitrix24.com/api/v1/"> в HTML).');
	}
	return bx;
}

/** Один вызов метода Б24 → Promise. */
export function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
	return new Promise((resolve, reject) => {
		getBx24().callMethod(method, params, (res) => {
			const err = res.error();
			if (err) {
				reject(new Error(`${method}: ${typeof err === 'object' ? JSON.stringify(err) : String(err)}`));
				return;
			}
			resolve(res.data() as T);
		});
	});
}

/**
 * Пакетный вызов (до 50 операций за раз). Ошибку отдельного вызова не валит весь
 * батч — такой ключ просто получит null.
 */
export function callBatch(calls: Record<string, [string, Record<string, unknown>]>): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		getBx24().callBatch(calls, (results) => {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(calls)) {
				const r = results[key];
				out[key] = r && !r.error() ? r.data() : null;
			}
			resolve(out);
		});
	});
}

/** Promise с таймаутом — чтобы зависший BX24-вызов не вешал UI навечно. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`таймаут: ${label} (>${Math.round(ms / 1000)}с)`)), ms);
	});
	return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

// ── Доменные типы ─────────────────────────────────────────────────────────────

/** TYPE строки: 1 = товар, 7 = работа/услуга (подтверждено разведкой портала). */
export const ROW_TYPE_GOODS = 1;
export const ROW_TYPE_WORK = 7;

export interface DealProductRow {
	id: string;
	productId: number;
	name: string;
	type: number;
	price: number;
	quantity: number;
	discountSum: number;
	measure: string;
}

export interface StoreInfo {
	id: number;
	title: string;
	active: boolean;
}

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
		productId: Number(r['PRODUCT_ID'] ?? 0),
		name: String(r['PRODUCT_NAME'] ?? ''),
		type: Number(r['TYPE'] ?? 0),
		price: Number(r['PRICE'] ?? 0),
		quantity: Number(r['QUANTITY'] ?? 0),
		discountSum: Number(r['DISCOUNT_SUM'] ?? 0),
		measure: String(r['MEASURE_NAME'] ?? ''),
	}));
}

export async function fetchStores(): Promise<StoreInfo[]> {
	const res = await call<{ stores?: Array<Record<string, unknown>> }>('catalog.store.list', {
		select: ['id', 'title', 'active'],
		order: { id: 'ASC' },
	});
	return (res?.stores ?? []).map((s) => ({
		id: Number(s['id']),
		title: String(s['title'] ?? `Склад #${s['id']}`),
		active: s['active'] === 'Y',
	}));
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
	const out: Record<number, ProductEnrichment> = {};
	const ids = productIds.filter((id) => id > 0).slice(0, 24); // ≤24 товаров = ≤48 операций в батче (лимит 50)
	if (!ids.length) return out;

	const calls: Record<string, [string, Record<string, unknown>]> = {};
	for (const pid of ids) {
		calls[`stock_${pid}`] = ['catalog.storeproduct.list', { filter: { productId: pid }, select: ['storeId', 'amount'] }];
		calls[`prod_${pid}`] = ['catalog.product.get', { id: pid }];
	}
	const res = await callBatch(calls);

	for (const pid of ids) {
		const stockRes = res[`stock_${pid}`] as { storeProducts?: Array<Record<string, unknown>> } | null;
		const prodRes = res[`prod_${pid}`] as { product?: Record<string, unknown> } | null;
		const stocks = (stockRes?.storeProducts ?? [])
			.map((s) => ({ storeId: Number(s['storeId']), amount: Number(s['amount'] ?? 0) }))
			.filter((s) => s.amount > 0);
		const pp = prodRes?.product?.['purchasingPrice'];
		out[pid] = { stocks, purchasingPrice: pp == null || pp === '' ? null : Number(pp) };
	}
	return out;
}

/** Канареечный доступ к новым экранам — пока только Сергей Ласкин (Bitrix ID 1858). */
export const BETA_USER_IDS = ['1858'];

/** ID текущего пользователя, который смотрит (для канареечного гейта). */
export async function fetchCurrentUserId(): Promise<string> {
	const u = await call<{ ID?: string | number }>('user.current');
	return String(u?.ID ?? '');
}

export interface InvLine {
	productId: number;
	name: string;
	/** Учётный остаток на складе (что система думает, есть). */
	book: number;
}

/**
 * Все остатки склада (с пагинацией) + имена товаров — для отчёта инвентаризации.
 * Учёт = amount из catalog.storeproduct.list, имя — из catalog.product.get (батчами).
 */
export async function fetchStoreInventory(storeId: number): Promise<InvLine[]> {
	const rows: Array<{ productId: number; amount: number }> = [];
	let start = 0;
	for (let page = 0; page < 20; page++) {
		// до 20 страниц по 50 = кап 1000 позиций на склад
		const res = await call<{ storeProducts?: Array<Record<string, unknown>>; next?: number }>('catalog.storeproduct.list', {
			filter: { storeId },
			select: ['productId', 'amount'],
			start,
		});
		for (const r of res?.storeProducts ?? []) rows.push({ productId: Number(r['productId']), amount: Number(r['amount'] ?? 0) });
		if (res?.next == null) break;
		start = res.next;
	}

	const ids = [...new Set(rows.map((r) => r.productId).filter((x) => x > 0))];
	const names = new Map<number, string>();
	for (let i = 0; i < ids.length; i += 40) {
		const chunk = ids.slice(i, i + 40);
		const calls: Record<string, [string, Record<string, unknown>]> = {};
		for (const id of chunk) calls[`p${id}`] = ['catalog.product.get', { id }];
		const res = await callBatch(calls);
		for (const id of chunk) {
			const p = (res[`p${id}`] as { product?: Record<string, unknown> } | null)?.product;
			names.set(id, p ? String(p['name'] ?? `#${id}`) : `#${id}`);
		}
	}

	return rows
		.filter((r) => r.productId > 0)
		.map((r) => ({ productId: r.productId, name: names.get(r.productId) ?? `#${r.productId}`, book: r.amount }));
}

// ── Инвентаризация: хранилище (entity.*) + инициаторы (app.option) ────────────
// ВАЖНО: entity.* и app.option.* работают только в контексте приложения (iframe), не через вебхук.

const ENT_INV = 'ctv_inv';

// Хранилище (entity ctv_inv) создаётся на БЭКЕНДЕ (placement.ts → ensureInventoryEntity),
// т.к. entity.add — админская операция, и фронтовый BX24 вешается на вложенном ACCESS.
// Фронт только читает/пишет записи (entity.item.*), без вложенных параметров.

/** Инициаторы по умолчанию: Дранишников (1), Бекасов (986). Дальше ведут сами через app.option. */
const DEFAULT_INITIATORS = ['1', '986'];

export async function getInitiators(): Promise<string[]> {
	try {
		const opts = await call<Record<string, unknown>>('app.option.get', {});
		const raw = opts?.['inv_initiators'];
		if (typeof raw === 'string' && raw) {
			const arr = JSON.parse(raw) as unknown;
			if (Array.isArray(arr) && arr.length) return arr.map(String);
		}
	} catch {
		/* настройки нет — дефолт */
	}
	return DEFAULT_INITIATORS;
}
export async function setInitiators(ids: string[]): Promise<void> {
	await call('app.option.set', { options: { inv_initiators: JSON.stringify([...new Set(ids)]) } });
}

export interface InvPoint {
	storeId: number;
	storeName: string;
	responsibleId: string;
	responsibleName: string;
}
export interface Inventory {
	id: string;
	title: string;
	status: string;
	points: InvPoint[];
	createdById: string;
	createdAt: string;
}

interface RawEntityItem {
	ID?: string;
	NAME?: string;
	DETAIL_TEXT?: string;
	DATE_CREATE?: string;
	CREATED_BY?: string;
}

export async function listInventories(): Promise<Inventory[]> {
	const items = await call<RawEntityItem[]>('entity.item.get', { ENTITY: ENT_INV });
	return (items ?? []).map((it) => {
		let body: Record<string, unknown> = {};
		try {
			body = it.DETAIL_TEXT ? (JSON.parse(it.DETAIL_TEXT) as Record<string, unknown>) : {};
		} catch {
			/* битый JSON — пропускаем */
		}
		return {
			id: String(it.ID ?? ''),
			title: String(it.NAME ?? ''),
			status: String(body['status'] ?? 'active'),
			points: Array.isArray(body['points']) ? (body['points'] as InvPoint[]) : [],
			createdById: String(body['createdById'] ?? it.CREATED_BY ?? ''),
			createdAt: String(body['createdAt'] ?? it.DATE_CREATE ?? ''),
		};
	});
}

export async function createInventory(title: string, points: InvPoint[], createdById: string, createdAt: string): Promise<void> {
	await call('entity.item.add', {
		ENTITY: ENT_INV,
		NAME: title,
		DETAIL_TEXT: JSON.stringify({ status: 'active', points, createdById, createdAt }),
	});
}

export interface SimpleUser {
	id: string;
	name: string;
}
/** Активные сотрудники — для назначения ответственных (v1: первая страница ~50). */
export async function fetchUsers(): Promise<SimpleUser[]> {
	const users = await call<Array<Record<string, unknown>>>('user.get', { FILTER: { ACTIVE: true }, SORT: 'LAST_NAME', ORDER: 'ASC' });
	return (users ?? []).map((u) => ({
		id: String(u['ID']),
		name: `${u['LAST_NAME'] ?? ''} ${u['NAME'] ?? ''}`.trim() || String(u['ID']),
	}));
}
