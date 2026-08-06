import { bx24Auth } from './bitrix-auth.js';
import type { TransferDoc, TransferHistoryEventDto, TransferLineDto } from './stock-transfer-types.js';

/** Заявка в снабжение для «Снаб»: один Material Request = нехватка по одной сделке. */
export interface SupplyOrderItem { productId: number; itemName: string; qty: number; note: string; stocks: Record<string, number>; rowName?: string; dealLineKey?: string; dealQty?: number; requestedQty?: number; allocatedQty?: number }
export interface SupplyTransferChild {
	id: number; name: string; displayTitle?: string; purchaseOrder?: string; status: string; fromStore: string; toStore: string;
	shipEntry?: string; receiveEntry?: string; shortageReturnEntry?: string;
	correctionOf?: number | null; correctionKind?: 'shortage_return' | 'overage_transfer' | null; correctionIds?: number[];
	lines: TransferLineDto[]; collectedLines?: TransferLineDto[]; shippedLines?: TransferLineDto[]; acceptedLines?: TransferLineDto[];
	receivedLines: TransferLineDto[]; shortageLines: TransferLineDto[]; history?: TransferHistoryEventDto[];
	actionWarning?: string;
}
export interface SupplyPurchaseReceiptChild { name: string; displayTitle?: string; status: string; docstatus?: number; purchaseOrder?: string; lines: TransferLineDto[] }
export type SupplyPurchaseStage = 'draft' | 'approval' | 'approved' | 'ordered' | 'cancelled';
export interface SupplyPurchaseChild { name: string; displayTitle?: string; supplier: string; status: string; supplyStage?: string; orderedAt?: string; expectedAt?: string; total?: number; lines: TransferLineDto[]; receipts: SupplyPurchaseReceiptChild[] }
export interface SupplyOrderRow {
	name: string;
	displayTitle?: string;
	requestKey: string;
	dealId: string;
	dealTitle: string;
	date: string;
	deadline: string;
	status: string;
	closed: boolean;
	toStore: string;
	note: string;
	items: SupplyOrderItem[];
	originalItems?: SupplyOrderItem[];
	transfers?: SupplyTransferChild[];
	purchases?: SupplyPurchaseChild[];
	standalone?: boolean;
}

export type SupplyDecisionAction = 'transfer' | 'purchase';
export interface SupplyDecisionLine {
	productId: number;
	itemName: string;
	qty: number;
	action: SupplyDecisionAction;
	fromStore?: string;
	supplier?: string;
}
export interface SupplyCreatedDocuments {
	transfers: TransferDoc[];
	purchases: string[];
	updatedPurchases: string[];
}

/** Все заявки снабжения из ядра (Material Request по сделкам) + название сделки из Б24. Ядро не подключено → []. */
export async function fetchSupplyOrders(): Promise<SupplyOrderRow[]> {
	const res = await fetch('/api/supply/orders', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; orders?: SupplyOrderRow[] };
	if (!json.ok) return [];
	return json.orders ?? [];
}

/** Сформировать заказ в снабжение по выбранным чекбоксами товарам сделки. */
export async function createDealSupplyRequest(dealId: number, lines: Array<{ productId: number; itemName: string; qty: number; note: string }>, options: { toStore: string; deadline: string; note?: string }): Promise<string> {
	const res = await fetch('/api/supply/request', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, lines, ...options }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось создать заявку в снабжение');
	return json.name ?? '';
}

export async function updateSupplyOrderNote(requestName: string, note: string): Promise<string> {
	const res = await fetch('/api/supply/request-note', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), requestName, note }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; note?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить комментарий');
	return json.note ?? '';
}

export async function updateSupplyOrderStore(requestName: string, requestKey: string, toStore: string): Promise<string> {
	const res = await fetch('/api/supply/request-store', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), requestName, requestKey, toStore }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; toStore?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось изменить конечный склад заявки');
	return json.toStore ?? toStore;
}

export async function updateSupplyRequestLine(input: {
	dealId: number;
	requestName: string;
	requestKey: string;
	rowName?: string;
	productId: number;
	nextProductId: number;
	nextItemName: string;
	nextQty: number;
}): Promise<number> {
	const res = await fetch('/api/supply/request-line', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; dealQty?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось изменить строку заявки');
	return Number(json.dealQty ?? 0);
}

export async function createSupplyDocuments(args: { requestName: string; requestKey: string; dealId: number; toStore: string; lines: SupplyDecisionLine[] }): Promise<SupplyCreatedDocuments> {
	const res = await fetch('/api/supply/create-documents', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...args }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; partial?: boolean; transfers?: TransferDoc[]; purchases?: string[]; updatedPurchases?: string[] };
	if (!json.ok) {
		const created = [
			...(json.transfers ?? []).map((transfer) => transfer.name || `перемещение #${transfer.id}`),
			...(json.purchases ?? []),
			...(json.updatedPurchases ?? []).map((name) => `${name} дополнен`),
		];
		const suffix = created.length ? ` Уже созданы: ${created.join(', ')}. Список заявки обновлён.` : '';
		throw new Error(`${json.error ?? 'не удалось создать документы снабжения'}.${suffix}`);
	}
	return { transfers: json.transfers ?? [], purchases: json.purchases ?? [], updatedPurchases: json.updatedPurchases ?? [] };
}

export async function createSupplyPurchaseOrder(requestName: string, requestKey: string, dealId: number, supplier: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>): Promise<string> {
	const res = await fetch('/api/supply/purchase-order', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), requestName, requestKey, dealId, supplier, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось создать черновик закупки');
	return json.name ?? '';
}

export async function createStandaloneSupplyPurchase(supplier: string, expectedAt: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>): Promise<string> {
	const res = await fetch('/api/supply/purchase-order/standalone', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), supplier, expectedAt, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok || !json.name) throw new Error(json.error ?? 'не удалось создать самостоятельную закупку');
	return json.name;
}

export async function updateSupplyPurchaseOrder(purchaseOrder: string, supplier: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>): Promise<string> {
	const res = await fetch('/api/supply/purchase-order/update', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), purchaseOrder, supplier, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить черновик закупки');
	return json.name ?? '';
}

export async function deleteSupplyPurchaseOrder(purchaseOrder: string): Promise<void> {
	const res = await fetch('/api/supply/purchase-order/delete', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), purchaseOrder }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить заявку поставщику');
}

export async function fetchSupplySuppliers(): Promise<string[]> {
	const res = await fetch('/api/supply/suppliers', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; suppliers?: string[] };
	if (!json.ok) return [];
	return json.suppliers ?? [];
}

export async function createSupplySupplier(name: string): Promise<{ name: string; suppliers: string[]; created: boolean }> {
	const res = await fetch('/api/supply/supplier/create', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), name }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string; suppliers?: string[]; created?: boolean };
	if (!json.ok || !json.name) throw new Error(json.error ?? 'не удалось создать поставщика');
	return { name: json.name, suppliers: json.suppliers ?? [json.name], created: Boolean(json.created) };
}

export async function updateSupplyPurchaseStage(purchaseOrder: string, stage: SupplyPurchaseStage, expectedAt?: string): Promise<string> {
	const res = await fetch('/api/supply/purchase-stage', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), purchaseOrder, stage, ...(expectedAt ? { expectedAt } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось обновить статус закупки');
	return json.name ?? '';
}

export async function receiveSupplyPurchase(requestName: string, requestKey: string, dealId: number, purchaseOrder: string, lines: Array<{ productId: number; qty: number; rate: number }>): Promise<string> {
	const res = await fetch('/api/supply/purchase-receive', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), requestName, requestKey, dealId, purchaseOrder, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось принять закупку');
	return json.name ?? '';
}

export async function createSupplyPurchaseTransfer(requestName: string, requestKey: string, dealId: number, purchaseOrder: string, lines: Array<{ productId: number; qty: number }>): Promise<SupplyTransferChild> {
	const res = await fetch('/api/supply/purchase-transfer', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), requestName, requestKey, dealId, purchaseOrder, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: SupplyTransferChild };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось создать перемещение на точку');
	return json.transfer;
}
