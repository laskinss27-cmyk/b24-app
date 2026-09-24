import { bx24Auth } from './bitrix-auth.js';

export interface CoreMovement { name: string; doctype: 'Stock Entry' | 'Purchase Receipt' | 'Delivery Note'; date: string; submitted: boolean; summary: string; dealId: string; ownerName: string }
export async function fetchMovements(kind: 'issue' | 'receipt' | 'delivery' | 'return', period?: { from?: string; to?: string; productId?: number }): Promise<CoreMovement[]> {
	const res = await fetch('/api/stock/movements', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), kind, ...(period?.from ? { from: period.from } : {}), ...(period?.to ? { to: period.to } : {}), ...(period?.productId ? { productId: period.productId } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; movements?: CoreMovement[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить движения');
	return json.movements ?? [];
}

/** Содержимое складского документа ядра (для раскрытия строки журнала). */
export interface StockDocumentHistoryEvent {
	id: string; occurredAt: string; outcome: 'success' | 'failure'; summary: string;
	actor?: { id: string; name: string }; documents?: string[];
}
export interface CoreDocItem { rowId: string; sourceRow: string; productId: number; itemName: string; qty: number; store: string; rate: number }
export interface CoreDocDetail {
	name: string; doctype: string; date: string; submitted: boolean; dealId: string;
	supplier: string; reason: string; note: string; items: CoreDocItem[]; ownerName: string;
	kind: 'issue' | 'receipt' | 'return' | null; amendedFrom: string; editBlockedReason: string;
	allowAddLines: boolean; canEdit: boolean; history: StockDocumentHistoryEvent[];
}
export async function fetchDocDetail(doctype: string, name: string): Promise<CoreDocDetail> {
	const res = await fetch('/api/stock/doc', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), doctype, name }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; detail?: CoreDocDetail };
	if (!json.ok || !json.detail) throw new Error(json.error ?? 'не удалось открыть документ');
	return { ...json.detail, history: json.detail.history ?? [] };
}

/** История движений по товару (Stock Ledger Entry ядра) — для вкладки «Отчёт по движению товара». */
export interface ItemMovement { date: string; doctype: string; voucherNo: string; kind: string; qty: number; store: string }
export interface ItemPendingDeal {
	dealId: string; title: string; ownerName: string; planName: string;
	plannedQty: number; shippedQty: number; pendingQty: number; deliveryDate: string;
}
export interface ItemHistoryReport { movements: ItemMovement[]; pendingDeals: ItemPendingDeal[] }
export async function fetchItemHistory(productId: number): Promise<ItemHistoryReport> {
	const res = await fetch('/api/stock/item-history', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), productId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; movements?: ItemMovement[]; pendingDeals?: ItemPendingDeal[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить историю товара');
	return { movements: json.movements ?? [], pendingDeals: json.pendingDeals ?? [] };
}
