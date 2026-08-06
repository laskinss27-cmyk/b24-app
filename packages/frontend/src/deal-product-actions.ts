import { bx24Auth } from './bitrix-auth.js';

/** Доступ к «Быстрой продаже» (ЗАПИСЬ): Сергей (1858) + Бекасов (986) + Дранишников (1, владелец). */
export const QUICKSALE_USER_IDS = ['1858', '986', '1'];

export interface QuickSaleItem {
	productId: number;
	name: string;
	price: number;
	quantity: number;
	/** Скидка % на эту позицию. */
	discountPercent?: number;
}

export interface QuickSaleOpts {
	assignedById?: string;
	/** Выбранный склад → станет «Источником» сделки (пусто, если «Все склады»). */
	storeId?: number | null;
}

/** Создать сделку «Быстрая продажа» (кат. 6) из корзины → вернуть ID сделки. */
export async function createQuickSale(items: QuickSaleItem[], opts: QuickSaleOpts = {}): Promise<number> {
	const res = await fetch('/api/quicksale/create', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			...bx24Auth(),
			items,
			assignedById: opts.assignedById,
			storeId: opts.storeId ?? undefined,
		}),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; dealId?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось создать продажу');
	return json.dealId ?? 0;
}

/** Поиск товара по названию + розничная цена (для пикера «Добавить товар» в сделке). */
export async function searchDealProducts(q: string): Promise<{ id: number; name: string; price: number }[]> {
	if (q.trim().length < 2) return [];
	const res = await fetch('/api/deal/search-products', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), q }),
	});
	const json = (await res.json()) as { ok: boolean; products?: { id: number; name: string; price: number }[] };
	return json.products ?? [];
}

/** Добавить НЕСКОЛЬКО товаров в сделку за раз (корзина пикера → «Готово»). Возвращает кол-во добавленных. */
export async function addProductsToDeal(dealId: number, items: { productId: number; quantity: number; price?: number; name?: string; isService?: boolean }[], options: { stage?: boolean; stageId?: string; stageName?: string; variantId?: string } = {}): Promise<number> {
	const res = await fetch('/api/deal/add-products', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, items, stage: options.stage === true, ...(options.stageId ? { stageId: options.stageId } : {}), ...(options.stageName ? { stageName: options.stageName } : {}), ...(options.variantId ? { variantId: options.variantId } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; added?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось добавить товары');
	return json.added ?? 0;
}
