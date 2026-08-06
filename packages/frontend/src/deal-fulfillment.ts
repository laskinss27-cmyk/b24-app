import { bx24Auth } from './bitrix-auth.js';
import { withTimeout } from './bitrix-client.js';

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

export interface RealizeItem {
	rowId: number;
	productId: number;
	/** Кол-во ЭТОЙ партии (может быть меньше количества в строке сделки). */
	quantity: number;
	/** Полное кол-во строки сделки (таким создаётся строка корзины заказа). */
	rowQuantity: number;
	price: number;
	name: string;
	/** Склад из нашего селектора — пишется в crm-строку сделки (storeId) перед созданием черновика. */
	storeId?: number | undefined;
	/** Имя склада — для памяти партий (Битрикс склад черновика наружу не отдаёт). */
	storeName?: string | undefined;
}

export interface RealizeResult {
	orderId: number;
	orderReused: boolean;
	shipmentId: number;
	accountNumber: string;
	dupRemoved: number | null;
}

export interface DealShipment {
	id: number;
	accountNumber: string;
	deducted: boolean;
	/** rowId строки сделки → кол-во в этой партии (для расщепления строк в таблице). */
	items: Record<string, number>;
	/** rowId → имя склада партии из нашей памяти (entity); нет записи — склад смотреть в карточке. */
	stores?: Record<string, string>;
}

export interface SupplyCard {
	id: number;
	title: string;
	stageId: string;
	source?: 'b24' | 'core';
	productIds?: number[];
	date?: string;
	deadline?: string;
	toStore?: string;
	note?: string;
	items?: Array<{ productId: number; itemName: string; qty: number; note: string }>;
}

export interface DealShippedInfo {
	orderId: number | null;
	/** rowId строки сделки → суммарно отгружено партиями (черновики + проведённые). */
	shipped: Record<string, number>;
	/** rowId → склады из резервов корзины (склад, выбранный в ЧЕРНОВИКЕ — живьём из документа). */
	reserves: Record<string, number[]>;
	shipments: DealShipment[];
	/** Оплата заказа сделки: total = сумма, paid = оплачено (платежи paid='Y'). null — заказа/оплаты нет. */
	payment: { total: number; paid: number } | null;
	/** Склад-источник сделки (преобладающий в резервах заказа) — дефолт «Склада реализации». null — нет. */
	sourceStoreId: number | null;
	/** Заявки снабжения сделки (смарт-процесс «Снабжение»). */
	supply: SupplyCard[];
	/** Строки сделки серверным клиентом (BX24 на фронте флапает). null — бэкенд не отдал, фолбэк на BX24. */
	rows: DealProductRow[] | null;
}

/** Что уже отгружено по строкам сделки (партии заказа, привязанного через crm.orderentity). */
export async function fetchDealShipped(dealId: number): Promise<DealShippedInfo> {
	const res = await fetch('/api/deal/shipped', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & Partial<DealShippedInfo>;
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить отгрузки сделки');
	return { orderId: json.orderId ?? null, shipped: json.shipped ?? {}, reserves: json.reserves ?? {}, shipments: json.shipments ?? [], payment: json.payment ?? null, sourceStoreId: json.sourceStoreId ?? null, supply: json.supply ?? [], rows: json.rows ?? null };
}

/** Повторитель для флапающих BX24-вызовов: каждая попытка со своим таймаутом. */
export async function withRetry<T>(fn: () => Promise<T>, attempts: number, ms: number, label: string): Promise<T> {
	let last: unknown;
	for (let a = 1; a <= attempts; a++) {
		try { return await withTimeout(fn(), ms, label); }
		catch (e) { last = e; }
	}
	throw last;
}

/** Товар «нет на складах» → заявка снабжения (создаёт карточку «Поставка № …» или дополняет открытую).
 *  storeToName — «куда привезти»: уедет в поле «Склад поставки» заявки (если справочник читается)
 *  и строкой в перечень. */
export async function requestSupply(dealId: number, items: { name: string; quantity: number; measure?: string }[], storeToName?: string): Promise<{ mode: 'created' | 'appended' | 'exists'; cardId: number; title: string }> {
	const res = await fetch('/api/deal/supply-request', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, items, storeToName }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; mode?: 'created' | 'appended' | 'exists'; cardId?: number; title?: string };
	if (!json.ok || json.cardId == null) throw new Error(json.error ?? 'не удалось создать заявку снабжения');
	return { mode: json.mode ?? 'created', cardId: json.cardId, title: json.title ?? '' };
}

/** Открыть карточку заявки снабжения (смарт-процесс 1110) слайдером. */
export function openSupplyCard(cardId: number): void {
	const path = `/crm/type/1110/details/${cardId}/`;
	const bx = window.BX24;
	if (bx && typeof bx.openPath === 'function') bx.openPath(path);
	else {
		const a = bx ? bx.getAuth() : false;
		window.open(`https://${a ? (a.domain ?? '') : ''}${path}`, '_blank');
	}
}

/** Черновик РЕАЛИЗАЦИИ по отмеченным строкам сделки (склад НЕ списывается — проводит менеджер). */
export async function realizeDeal(dealId: number, items: RealizeItem[]): Promise<RealizeResult> {
	const res = await fetch('/api/deal/realize', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, items }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & Partial<RealizeResult>;
	if (!json.ok || !json.shipmentId) throw new Error(json.error ?? 'не удалось создать черновик реализации');
	return { orderId: json.orderId ?? 0, orderReused: json.orderReused ?? false, shipmentId: json.shipmentId, accountNumber: json.accountNumber ?? '', dupRemoved: json.dupRemoved ?? null };
}
