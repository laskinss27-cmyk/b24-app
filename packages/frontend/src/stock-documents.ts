import { bx24Auth } from './bitrix-auth.js';

export interface StockItem { productId: number; name: string; article: string; brand: string; stocks?: Record<string, number>; reserved?: Record<string, number>; total?: number }

/** Справочники для форм и ролевое право на складские документы. */
export async function fetchStockFormData(): Promise<{ stores: string[]; suppliers: string[]; canCreate: boolean; canCancel: boolean; isSupply: boolean }> {
	const res = await fetch('/api/stock/form-data', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; stores?: string[]; suppliers?: string[]; canCreate?: boolean; canCancel?: boolean; isSupply?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить справочники');
	return { stores: json.stores ?? [], suppliers: json.suppliers ?? [], canCreate: Boolean(json.canCreate), canCancel: Boolean(json.canCancel), isSupply: Boolean(json.isSupply) };
}

/** Создать НОВЫЙ товар (нет в каталоге): заводим в каталоге Б24 + ядре, возвращаем как StockItem для прихода. */
export async function createStockProduct(name: string): Promise<StockItem> {
	const res = await fetch('/api/stock/create-product', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), name }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; productId?: number; name?: string };
	if (!json.ok || !json.productId) throw new Error(json.error ?? 'не удалось создать товар');
	return { productId: json.productId, name: json.name ?? name, article: '', brand: '' };
}

/** Поиск товаров каталога ядра (id / имя / артикул) — пикер позиций в формах. */
export async function searchStockItems(q: string): Promise<StockItem[]> {
	if (q.trim().length < 1) return [];
	const res = await fetch('/api/stock/search-items', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), q }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; items?: StockItem[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось найти товары');
	return json.items ?? [];
}

export interface ReceiptDraftInput { toStore: string; supplier?: string; note?: string; lines: Array<{ productId: number; qty: number; purchase: number; retail: number }> }
export interface IssueDraftInput { fromStore: string; reason?: string; note?: string; lines: Array<{ productId: number; qty: number }> }

/** Создать черновик прихода (Purchase Receipt). Возвращает имя документа ядра. */
export async function createReceiptDoc(input: ReceiptDraftInput): Promise<string> {
	const res = await fetch('/api/stock/create', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), kind: 'receipt', ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok || !json.name) throw new Error(json.error ?? 'не удалось создать приход');
	return json.name;
}

/** Создать черновик списания (Material Issue). Возвращает имя документа ядра. */
export async function createIssueDoc(input: IssueDraftInput): Promise<string> {
	const res = await fetch('/api/stock/create', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), kind: 'issue', ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok || !json.name) throw new Error(json.error ?? 'не удалось создать списание');
	return json.name;
}

/** Провести черновик прихода/списания (двигает остатки ядра). */
export async function submitStockDoc(kind: 'receipt' | 'issue', name: string, doctype?: 'Stock Entry' | 'Purchase Receipt'): Promise<void> {
	const res = await fetch('/api/stock/submit', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), kind, name, ...(doctype ? { doctype } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось провести документ');
}

export async function cancelStockDoc(kind: 'issue' | 'receipt' | 'delivery' | 'return', name: string, doctype: 'Stock Entry' | 'Purchase Receipt' | 'Delivery Note'): Promise<string | null> {
	const res = await fetch('/api/stock/cancel-submission', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), kind, doctype, name }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; warning?: string | null };
	if (!json.ok) throw new Error(json.error ?? 'не удалось отменить проведение');
	return json.warning ?? null;
}
