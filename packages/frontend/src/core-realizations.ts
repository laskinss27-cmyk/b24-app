import { bx24Auth } from './bitrix-auth.js';

export interface CoreRealizationItem {
	productId: number;
	itemName: string;
	qty: number;
	/** Строка состава сделки: base или stage:<id>. */
	segmentId?: string;
	/** Цена продажи за единицу, зафиксированная в документе реализации. */
	rate: number;
	/** Склад списания — название склада Б24 (наш UI оперирует ими). */
	storeTitle: string;
}
export interface CoreRealization {
	/** Имя документа ядра (напр. MAT-DN-2026-00270). */
	name: string;
	postingDate: string;
	/** true = проведён (остаток ядра списан), false = черновик. */
	submitted: boolean;
	/** true — это возврат от клиента (Delivery Note is_return), а не отгрузка. */
	isReturn?: boolean;
	/** Имя исходной реализации, которую сторнирует возврат. */
	returnAgainst?: string;
	grandTotal: number;
	items: CoreRealizationItem[];
}

/** Что уже реализовано по сделке — из ЯДРА (черновики + проведённые). */
export async function fetchDealRealizationsCore(dealId: number): Promise<CoreRealization[]> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'list', dealId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; realizations?: CoreRealization[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось загрузить реализации сделки из ядра');
	return json.realizations ?? [];
}

export interface RealizeCoreGroup {
	/** Название склада Б24. Для отдельной группы услуг пусто: склад им не нужен. */
	storeTitle: string;
	lines: Array<{ productId: number; qty: number; rate: number; segmentId: string; isService?: boolean }>;
}

/** Создать черновики реализации: товары — по складам, услуги могут входить в товарную группу без склада на строке. */
export async function realizeCoreDraft(dealId: number, groups: RealizeCoreGroup[]): Promise<Array<{ name: string; storeTitle: string }>> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'draft', dealId, groups }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; drafts?: Array<{ name: string; storeTitle: string }> };
	if (!json.ok || !json.drafts) throw new Error(json.error ?? 'не удалось создать черновики реализации');
	return json.drafts;
}

/** Провести черновики реализации в ядре (submit → остаток ядра списывается). */
export async function realizeCoreSubmit(dealId: number, names: string[]): Promise<string[]> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'submit', dealId, names }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; submitted?: string[] };
	if (!json.ok || !json.submitted) throw new Error(json.error ?? 'не удалось провести реализацию');
	return json.submitted;
}

/** Возврат ОТ КЛИЕНТА: создать в ядре возвраты (Delivery Note is_return) по выбранным позициям. */
export async function createDealReturn(dealId: number, note: string, lines: Array<{ productId: number; qty: number; store: string }>): Promise<string[]> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'return', dealId, note, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; returns?: string[] };
	if (!json.ok || !json.returns) throw new Error(json.error ?? 'не удалось оформить возврат');
	return json.returns;
}

/** Добавить товарную строку в сделку (crm.item.productrow.add; существующие строки не трогает). */
export async function addProductToDeal(dealId: number, productId: number, quantity: number, price?: number): Promise<{ id: number; name: string; price: number; quantity: number }> {
	const res = await fetch('/api/deal/add-product', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, productId, quantity, price }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; row?: { id: number; name: string; price: number; quantity: number } };
	if (!json.ok || !json.row) throw new Error(json.error ?? 'не удалось добавить товар');
	return json.row;
}
