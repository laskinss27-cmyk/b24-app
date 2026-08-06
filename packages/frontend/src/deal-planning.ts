import { bx24Auth } from './bitrix-auth.js';

/** Строка плана сделки из ядра (черновик Sales Order). delivered — сколько уже отгружено. */
export interface DealPlanItem {
	productId: number;
	itemName: string;
	qty: number;
	/** Итоговая цена за ед. (после скидки) — ERPNext считает из базы и скидки. */
	rate: number;
	/** Базовая цена за ед. (до скидки). */
	priceListRate: number;
	/** Скидка, %. */
	discountPercent: number;
	delivered: number;
	isService?: boolean;
	lineKey?: string;
}

export interface DealStageItem { productId: number; itemName: string; qty: number; price: number; discountPercent?: number; isService: boolean }
export interface DealStage { id: string; name?: string; at: string; byId: string; byName: string; items: DealStageItem[] }
export interface DealQuoteVariantItem { productId: number; itemName: string; qty: number; priceListRate: number; discountPercent: number; isService?: boolean }
export interface DealQuoteVariant { id: string; name: string; createdAt: string; createdById: string; createdByName: string; items: DealQuoteVariantItem[] }
export interface DealQuoteVariants { enabled: boolean; selectedId: string | null; variants: DealQuoteVariant[] }

/** Состав сделки из ЯДРА (реальные товары — план). Источник правды для вкладки, мимо подмены Б24. */
export async function fetchDealPlan(dealId: number): Promise<DealPlanItem[]> {
	const res = await fetch('/api/deal/plan', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; items?: DealPlanItem[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось загрузить состав сделки из ядра');
	return json.items ?? [];
}

/** Перезаписать состав сделки в ядре (план = Sales Order) целиком — правка/удаление строк из вкладки.
 *  Б24 пересчитывается в одну «Выезд инженера». Возвращает итоговую сумму. */
export async function setDealPlan(dealId: number, items: DealPlanItem[], variantId?: string): Promise<number> {
	const res = await fetch('/api/deal/plan-set', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, items, ...(variantId ? { variantId } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; total?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить состав сделки');
	return json.total ?? 0;
}

/** Свернуть сделку в одну услугу «Выезд инженера» на полную сумму (товарный состав живёт в ядре,
 *  Б24-карточка несёт только сумму). Возвращает итоговую сумму услуги. */
export async function collapseDealToService(dealId: number): Promise<number> {
	const res = await fetch('/api/deal/collapse-service', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; total?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось свернуть сделку в услугу');
	return json.total ?? 0;
}

/** Удалить ОДНУ строку товара из сделки по её rowId. */
export async function removeDealProduct(dealId: number, rowId: number): Promise<void> {
	const res = await fetch('/api/deal/remove-product', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, rowId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить товар из сделки');
}

/** Изменить кол-во, БАЗОВУЮ цену и скидку % одной строки сделки по её rowId. */
export async function updateDealProduct(dealId: number, rowId: number, quantity: number, price: number, discountRate: number): Promise<void> {
	const res = await fetch('/api/deal/update-product', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, rowId, quantity, price, discountRate }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось изменить позицию');
}


export async function replaceDealPlanProduct(dealId: number, oldProductId: number, next: { productId: number; name: string }): Promise<number> {
	const res = await fetch('/api/deal/replace-plan-product', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, oldProductId, newProductId: next.productId, newItemName: next.name }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; total?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось заменить товар');
	return Number(json.total ?? 0);
}

/** Изменить одну строку конкретного этапа и синхронно пересчитать общий план сделки. */
export async function updateDealStageItem(dealId: number, stageId: string, productId: number, quantity: number, price: number, discountPercent: number): Promise<number> {
	const res = await fetch('/api/deal/stage-item-update', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, stageId, productId, quantity, price, discountPercent }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; total?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить строку этапа');
	return json.total ?? 0;
}

/** Удалить одну позицию из конкретного этапа, не затрагивая тот же товар в других этапах. */
export async function removeDealStageItem(dealId: number, stageId: string, productId: number): Promise<number> {
	const res = await fetch('/api/deal/stage-item-remove', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, stageId, productId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; total?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить строку этапа');
	return json.total ?? 0;
}

export async function renameDealStage(dealId: number, stageId: string, name: string): Promise<DealStage[]> {
	const res = await fetch('/api/deal/stage-rename', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, stageId, name }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; stages?: DealStage[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось переименовать этап');
	return json.stages ?? [];
}

export async function fetchDealStages(dealId: number): Promise<DealStage[]> {
	const res = await fetch('/api/deal/stages', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; stages?: DealStage[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось загрузить этапы сделки из ядра');
	return json.stages ?? [];
}

async function dealVariantMutation(path: string, body: Record<string, unknown>): Promise<DealQuoteVariants> {
	const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bx24Auth(), ...body }) });
	const json = (await res.json()) as { ok: boolean; error?: string; variants?: DealQuoteVariants };
	if (!json.ok || !json.variants) throw new Error(json.error ?? 'не удалось изменить варианты КП');
	return json.variants;
}

export async function fetchDealQuoteVariants(dealId: number): Promise<DealQuoteVariants> {
	const res = await fetch('/api/deal/variants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bx24Auth(), dealId }) });
	const json = (await res.json()) as { ok: boolean; error?: string; variants?: DealQuoteVariants };
	if (!json.ok || !json.variants) throw new Error(json.error ?? 'не удалось загрузить варианты КП из ядра');
	return json.variants;
}

export async function createDealQuoteVariant(dealId: number, name: string, sourceVariantId?: string): Promise<DealQuoteVariants> {
	return dealVariantMutation('/api/deal/variant-create', { dealId, name, ...(sourceVariantId ? { sourceVariantId } : {}) });
}

export async function renameDealQuoteVariant(dealId: number, variantId: string, name: string): Promise<DealQuoteVariants> {
	return dealVariantMutation('/api/deal/variant-rename', { dealId, variantId, name });
}

export async function deleteDealQuoteVariant(dealId: number, variantId: string): Promise<DealQuoteVariants> {
	return dealVariantMutation('/api/deal/variant-delete', { dealId, variantId });
}

export async function selectDealQuoteVariant(dealId: number, variantId: string): Promise<DealQuoteVariants> {
	return dealVariantMutation('/api/deal/variant-select', { dealId, variantId });
}

export async function cancelDealQuoteVariantSelection(dealId: number): Promise<DealQuoteVariants> {
	return dealVariantMutation('/api/deal/variant-selection-cancel', { dealId });
}
