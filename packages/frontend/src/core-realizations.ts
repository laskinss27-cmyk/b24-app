import type { DealRepairProfit } from '@b24-app/shared';
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
export async function fetchDealRealizationsData(dealId: number): Promise<{ realizations: CoreRealization[]; actualProfit: import('@b24-app/shared').DealActualProfit | null }> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'list', dealId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; realizations?: CoreRealization[]; actualProfit?: import('@b24-app/shared').DealActualProfit | null };
	if (!json.ok) throw new Error(json.error ?? 'не удалось загрузить реализации сделки из ядра');
	return { realizations: json.realizations ?? [], actualProfit: json.actualProfit ?? null };
}

export async function fetchDealRealizationsCore(dealId: number): Promise<CoreRealization[]> {
	return (await fetchDealRealizationsData(dealId)).realizations;
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

/** Удалить только непроведённые черновики реализации указанной сделки. */
export async function deleteCoreRealizationDrafts(dealId: number, names: string[]): Promise<string[]> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'delete-draft', dealId, names }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; deleted?: string[] };
	if (!json.ok || !json.deleted) throw new Error(json.error ?? 'не удалось удалить черновики реализации');
	return json.deleted;
}

/** Отменить проведение одной реализации; сервер повторно проверяет документ и права администратора. */
export async function cancelCoreRealization(dealId: number, name: string): Promise<string> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'cancel', dealId, names: [name] }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; canceled?: string };
	if (!json.ok || json.canceled !== name) throw new Error(json.error ?? 'не удалось отменить реализацию');
	return json.canceled;
}

/** Отправить Владимиру заявку на возврат. Складских документов этот вызов не создаёт. */
export async function createDealReturnRequest(dealId: number, note: string, lines: Array<{ productId: number; qty: number; store: string }>): Promise<number> {
	const res = await fetch('/api/deal/return-requests/create', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, note, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; requestId?: number };
	if (!json.ok || !json.requestId) throw new Error(json.error ?? 'не удалось отправить заявку на возврат');
	return json.requestId;
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

/** Separate optional calculation: an unavailable repair entity must not hide stock documents. */
export async function fetchDealRepairProfit(dealId: number): Promise<DealRepairProfit | null> {
	const res = await fetch('/api/deal/repair-profit', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = await res.json() as { ok: boolean; repairProfit?: DealRepairProfit | null };
	if (!json.ok) throw new Error('Не удалось загрузить расчёт ремонта');
	return json.repairProfit ?? null;
}
