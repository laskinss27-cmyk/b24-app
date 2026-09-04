import { bx24Auth } from './bitrix-auth.js';
import { newIdempotencyKey } from './idempotency-key.js';
import type { SupplyRequestLineDto, TransferDoc, TransferLineDto, TransferRequestDoc } from './stock-transfer-types.js';

/** Создать перемещение(я) из сделки: глобальный склад-получатель + группы по складам-источникам. */
export async function createTransfers(args: { dealId: number; toStore: string; groups: Array<{ fromStore: string; lines: TransferLineDto[] }>; supplyRequest?: string; supplyRequestKey?: string }): Promise<TransferDoc[]> {
	const res = await fetch('/api/transfers/create', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...args, idempotencyKey: newIdempotencyKey('transfer-create') }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfers?: TransferDoc[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось создать перемещение');
	return json.transfers ?? [];
}

/** Список перемещений: по сделке (вкладка) или все (окно закупки). isSupply — может ли текущий юзер двигать статусы. */
export async function listTransfers(dealId?: number, period?: { from?: string; to?: string }): Promise<{ transfers: TransferDoc[]; isSupply: boolean }> {
	const res = await fetch('/api/transfers/list', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...(dealId ? { dealId } : {}), ...(period?.from ? { from: period.from } : {}), ...(period?.to ? { to: period.to } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfers?: TransferDoc[]; isSupply?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить перемещения');
	return { transfers: json.transfers ?? [], isSupply: Boolean(json.isSupply) };
}

/** Заказ менеджера на перемещение: информационный документ без резерва и движений. */
export async function createTransferRequest(input: { fromStore: string; toStore: string; note?: string; lines: TransferLineDto[] }): Promise<TransferRequestDoc> {
	const idempotencyKey = newIdempotencyKey('transfer-request');
	const res = await fetch('/api/transfer-requests/create', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input, idempotencyKey, createdAt: new Date().toISOString() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; request?: TransferRequestDoc };
	if (!json.ok || !json.request) throw new Error(json.error ?? 'не удалось создать заказ на перемещение');
	return json.request;
}

export async function createSupplyTtRequest(input: { toStore: string; note?: string; lines: SupplyRequestLineDto[] }): Promise<TransferRequestDoc> {
	const idempotencyKey = newIdempotencyKey('supply-request');
	const res = await fetch('/api/transfer-requests/create-supply', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input, idempotencyKey, createdAt: new Date().toISOString() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; request?: TransferRequestDoc };
	if (!json.ok || !json.request) throw new Error(json.error ?? 'не удалось создать заявку снабжению');
	return json.request;
}

export async function listTransferRequests(): Promise<{ requests: TransferRequestDoc[]; isSupply: boolean }> {
	const res = await fetch('/api/transfer-requests/list', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; requests?: TransferRequestDoc[]; isSupply?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить заказы на перемещение');
	return { requests: json.requests ?? [], isSupply: Boolean(json.isSupply) };
}

export async function cancelTransferRequest(id: number): Promise<TransferRequestDoc> {
	const res = await fetch('/api/transfer-requests/cancel', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; request?: TransferRequestDoc };
	if (!json.ok || !json.request) throw new Error(json.error ?? 'не удалось отменить заказ');
	return json.request;
}

export async function convertTransferRequest(id: number, input: { fromStore: string; toStore: string; note?: string; lines: TransferLineDto[] }): Promise<{ request: TransferRequestDoc; transfer: TransferDoc }> {
	const res = await fetch('/api/transfer-requests/convert', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; request?: TransferRequestDoc; transfer?: TransferDoc };
	if (!json.ok || !json.request || !json.transfer) throw new Error(json.error ?? 'не удалось создать перемещение по заказу');
	return { request: json.request, transfer: json.transfer };
}

/** Изменить склад назначения до приёмки перемещения. */
export async function updateTransferDestination(id: number, toStore: string): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/update-destination', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, toStore }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось изменить склад назначения');
	return json.transfer;
}

/** Снабжение корректирует плановое количество перемещения. */
export async function updateTransferLines(id: number, lines: Array<{ productId: number; qty: number }>): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/update-lines', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось изменить количество перемещения');
	return json.transfer;
}

/** Склад отправки фиксирует собранное количество. */
export async function collectTransfer(id: number, lines: Array<{ productId: number; qty: number }>): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/collect', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; warning?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось отметить сборку');
	return { ...json.transfer, ...(json.warning ? { actionWarning: json.warning } : {}) };
}

/** Закупка: «В пути» (проводка А→транзит). */
export async function shipTransfer(id: number): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/ship', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; warning?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось отгрузить');
	return { ...json.transfer, ...(json.warning ? { actionWarning: json.warning } : {}) };
}

/** Закупка: «Получено» (проводка транзит→Б). */
export async function receiveTransfer(id: number, lines?: Array<{ productId: number; qty: number }>): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/receive', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, ...(lines ? { lines } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; warning?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось принять');
	return { ...json.transfer, ...(json.warning ? { actionWarning: json.warning } : {}) };
}

/** Снабжение проводит принятое перемещение и закрывает транзит. */
export async function postTransfer(id: number): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/post', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось провести перемещение');
	return json.transfer;
}

export async function cancelTransfer(id: number): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/cancel', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось отменить перемещение');
	return json.transfer;
}

export async function resolveTransferShortage(id: number): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/resolve-shortage', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось скорректировать недовоз');
	return json.transfer;
}

export async function deleteTransfer(id: number): Promise<void> {
	const res = await fetch('/api/transfers/delete', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить перемещение');
}


export async function createManualTransfer(input: { fromStore: string; toStore: string; note?: string; lines: TransferLineDto[] }): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/create-manual', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input, idempotencyKey: newIdempotencyKey('transfer-manual') }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось создать перемещение');
	return json.transfer;
}
