import { ErpClient } from './client.js';
import { ensurePlanField } from './deal-plan-state.js';
import { DEAL_FIELD, ensureErpSetup } from './erp-setup.js';
import { ensureCoreItem, fetchErpStocks } from './stock-catalog.js';
import { NOTE_FIELD, ensureNoteField } from './stock-movements.js';
import { SUPPLY_REQUEST_FIELD, SUPPLY_REQUEST_KEY_FIELD } from './stock-transfers.js';
import {
	SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
	SUPPLY_PURCHASE_STAGE_FIELD,
	ensurePurchaseFields,
} from './supply-purchases.js';
import { erpContext, erpWarehouse } from './warehouse-context.js';

async function requestLineAllocation(
	erp: ErpClient,
	requestName: string,
	requestKey: string,
	productId: number,
	transferAllocation?: SupplyAllocationMap,
): Promise<number> {
	const purchases = await purchaseAllocationForRequest(erp, requestName, requestKey);
	return (purchases.get(productId) ?? 0) + (transferAllocation?.get(requestKey)?.get(productId) ?? 0);
}

/** Изменить строку только в заявке снабжению.
 *  Состав сделки не читается и не меняется; уже распределённое вниз количество остаётся защитной границей. */
export async function updateSupplyRequestLine(
	erp: ErpClient,
	args: {
		requestName: string;
		requestKey: string;
		rowName?: string;
		productId: number;
		nextProductId: number;
		nextItemName: string;
		nextQty: number;
		transferAllocation?: SupplyAllocationMap;
	},
): Promise<{ requestQty: number }> {
	const request = await erp.get<Record<string, unknown>>('Material Request', args.requestName);
	if (!request || materialRequestKey(args.requestName, request['creation']) !== args.requestKey) throw new Error('заявка была изменена; обновите список');
	const rawItems = Array.isArray(request['items']) ? request.items as Array<Record<string, unknown>> : [];
	const target = rawItems.find((item) =>
		(args.rowName && String(item['name'] ?? '') === args.rowName) || Number(item['item_code']) === args.productId);
	if (!target) throw new Error('позиция больше не найдена в заявке');
	const requestQty = Number(target['qty'] ?? 0);
	const allocatedQty = Math.min(requestQty, await requestLineAllocation(erp, args.requestName, args.requestKey, args.productId, args.transferAllocation));
	if (args.nextQty + 0.000001 < allocatedQty) {
		throw new Error(`нельзя уменьшить ниже уже распределённого количества ${allocatedQty}`);
	}
	if (args.nextProductId !== args.productId && allocatedQty > 0.000001) {
		throw new Error(`товар уже распределён в количестве ${allocatedQty}; менять можно только ещё не обработанную строку`);
	}
	if (rawItems.some((item) => item !== target && Number(item['item_code']) === args.nextProductId)) {
		throw new Error('новый товар уже есть в заявке отдельной строкой');
	}
	await ensureCoreItem(erp, { productId: args.nextProductId, name: args.nextItemName || `#${args.nextProductId}` });
	const after = rawItems.map((item) => requestItemPayload(item, item === target ? {
		item_code: String(args.nextProductId),
		qty: args.nextQty,
	} : {}));
	await erp.update('Material Request', args.requestName, { items: after });
	return { requestQty: args.nextQty };
}


/** Заказ для дисплея снабжения: один Sales Order = спрос одной сделки. */
export interface SupplyOrderItem { productId: number; itemName: string; qty: number; rate: number; stocks: Record<string, number> }
export interface SupplyOrder { name: string; dealId: string; date: string; total: number; items: SupplyOrderItem[] }

/** ВСЕ заказы снабжения из ядра (Sales Order, кроме отменённых) с позициями и остатками по складам.
 *  Источник спроса для рабочего места «Снаб». Статус/название сделки добавляет роут из Б24. */
export async function listSupplyOrders(erp: ErpClient): Promise<SupplyOrder[]> {
	await ensurePlanField(erp);
	const stocks = await fetchErpStocks(erp); // productId → { '<склад>': qty } (один запрос Bin)
	const heads = await erp.list('Sales Order',
		['name', DEAL_FIELD, 'transaction_date', 'grand_total'],
		[['docstatus', '!=', 2]], 0, 'creation desc');
	const out: SupplyOrder[] = [];
	for (const h of heads) {
		const so = await erp.get<Record<string, unknown>>('Sales Order', String(h['name']));
		const items = ((so?.['items'] as Array<Record<string, unknown>>) ?? []).map((it) => {
			const productId = Number(it['item_code']);
			return {
				productId,
				itemName: String(it['item_name'] ?? ''),
				qty: Number(it['qty'] ?? 0),
				rate: Number(it['rate'] ?? 0),
				stocks: stocks.get(productId) ?? {},
			};
		});
		out.push({
			name: String(h['name']),
			dealId: String(h[DEAL_FIELD] ?? ''),
			date: String(h['transaction_date'] ?? ''),
			total: Number(h['grand_total'] ?? 0),
			items,
		});
	}
	return out;
}

// ── ЗАЯВКА В СНАБЖЕНИЕ = Material Request (родной документ обеспечения ERPNext) ──────────────
// Менеджер из сделки отмечает товары, которых не хватает, → создаётся Material Request (потребность),
// привязка b24_deal_id. Снабженец из неё делает закупку (Purchase Order) или перемещение (Stock Entry).
let mrFieldDone = false;
const MR_TO_STORE_FIELD = 'b24_to_store';
async function ensureMrField(erp: ErpClient): Promise<void> {
	if (mrFieldDone) return;
	const cfName = `Material Request-${DEAL_FIELD}`;
	if (!(await erp.get('Custom Field', cfName))) {
		await erp.create('Custom Field', {
			dt: 'Material Request', fieldname: DEAL_FIELD, label: 'B24 Deal', fieldtype: 'Data',
			insert_after: 'title', in_standard_filter: 1, in_list_view: 1,
		});
	}
	const toStoreName = `Material Request-${MR_TO_STORE_FIELD}`;
	if (!(await erp.get('Custom Field', toStoreName))) {
		await erp.create('Custom Field', {
			dt: 'Material Request', fieldname: MR_TO_STORE_FIELD, label: 'B24 To Store', fieldtype: 'Data',
			insert_after: DEAL_FIELD, in_list_view: 1,
		});
	}
	mrFieldDone = true;
}

export interface SupplyReqLine { productId: number; itemName?: string; qty: number; note?: string }

/** Создать заявку в снабжение (Material Request, тип Purchase) по выбранным товарам сделки. */
export async function createSupplyRequest(erp: ErpClient, args: { dealId: number; scheduleDate: string; lines: SupplyReqLine[]; toStore?: string; note?: string }): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	await ensureMrField(erp);
	if (args.note) await ensureNoteField(erp, 'Material Request');
	if (!args.lines.length) throw new Error('пустая заявка');
	for (const l of args.lines) await ensureCoreItem(erp, { productId: l.productId, name: l.itemName ?? `#${l.productId}` });
	const doc = await erp.create('Material Request', {
		company: ctx.company,
		material_request_type: 'Purchase',
		schedule_date: args.scheduleDate,
		[DEAL_FIELD]: String(args.dealId),
		...(args.toStore ? { [MR_TO_STORE_FIELD]: args.toStore } : {}),
		...(args.note ? { [NOTE_FIELD]: args.note.slice(0, 500) } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			schedule_date: args.scheduleDate,
			...(args.toStore ? { warehouse: erpWarehouse(ctx, args.toStore) } : {}),
			...(l.note ? { description: l.note } : {}),
		})),
	});
	return { name: String(doc['name']) };
}

export interface SupplyReqItem { productId: number; itemName: string; qty: number; note: string; stocks: Record<string, number>; rowName: string }
export interface SupplyRequest { name: string; requestKey: string; createdAt: string; dealId: string; date: string; deadline: string; status: string; toStore: string; note: string; items: SupplyReqItem[] }
export interface SupplyRequestSummary {
	name: string;
	requestKey: string;
	createdAt: string;
	dealId: string;
	date: string;
	deadline: string;
	status: string;
	toStore: string;
	note: string;
	productIds: number[];
	items: Array<{ productId: number; itemName: string; qty: number; note: string }>;
}

function materialRequestKey(name: string, creation: unknown): string {
	return `${name}@${String(creation ?? '')}`;
}

export async function listSupplyRequestsForDeal(erp: ErpClient, dealId: number): Promise<SupplyRequestSummary[]> {
	await ensureMrField(erp);
	await ensureNoteField(erp, 'Material Request');
	const heads = await erp.list('Material Request',
		['name', DEAL_FIELD, 'transaction_date', 'status'],
		[['docstatus', '!=', 2], [DEAL_FIELD, '=', String(dealId)]], 0, 'creation desc');
	const out: SupplyRequestSummary[] = [];
	for (const h of heads) {
		const mr = await erp.get<Record<string, unknown>>('Material Request', String(h['name']));
		const items = ((mr?.['items'] as Array<Record<string, unknown>>) ?? []).map((item) => ({
			productId: Number(item['item_code'] ?? 0),
			itemName: String(item['item_name'] ?? ''),
			qty: Number(item['qty'] ?? 0),
			note: String(item['description'] ?? ''),
		})).filter((item) => Number.isInteger(item.productId) && item.productId > 0);
		out.push({
			name: String(h['name']),
			requestKey: materialRequestKey(String(h['name']), mr?.['creation']),
			createdAt: String(mr?.['creation'] ?? ''),
			dealId: String(h[DEAL_FIELD] ?? ''),
			date: String(h['transaction_date'] ?? ''),
			deadline: String(mr?.['schedule_date'] ?? ''),
			status: String(h['status'] ?? ''),
			toStore: String(mr?.[MR_TO_STORE_FIELD] ?? ''),
			note: String(mr?.[NOTE_FIELD] ?? ''),
			productIds: items.map((item) => item.productId),
			items,
		});
	}
	return out;
}

/** Все заявки снабжения из ядра (Material Request, кроме отменённых) с позициями, комментариями и остатками. */
export async function listSupplyRequests(erp: ErpClient): Promise<SupplyRequest[]> {
	await ensureMrField(erp);
	await ensureNoteField(erp, 'Material Request');
	const stocks = await fetchErpStocks(erp);
	const heads = await erp.list('Material Request',
		['name', DEAL_FIELD, 'transaction_date', 'status'],
		[['docstatus', '!=', 2]], 0, 'creation desc');
	const out: SupplyRequest[] = [];
	for (const h of heads) {
		const mr = await erp.get<Record<string, unknown>>('Material Request', String(h['name']));
		const items = ((mr?.['items'] as Array<Record<string, unknown>>) ?? []).map((it) => {
			const productId = Number(it['item_code']);
			return {
				productId,
				itemName: String(it['item_name'] ?? ''),
				qty: Number(it['qty'] ?? 0),
				note: String(it['description'] ?? ''),
				stocks: stocks.get(productId) ?? {},
				rowName: String(it['name'] ?? ''),
			};
		});
		out.push({
			name: String(h['name']),
			requestKey: materialRequestKey(String(h['name']), mr?.['creation']),
			createdAt: String(mr?.['creation'] ?? ''),
			dealId: String(h[DEAL_FIELD] ?? ''),
			date: String(h['transaction_date'] ?? ''),
			deadline: String(mr?.['schedule_date'] ?? ''),
			status: String(h['status'] ?? ''),
			toStore: String(mr?.[MR_TO_STORE_FIELD] ?? ''),
			note: String(mr?.[NOTE_FIELD] ?? ''),
			items,
		});
	}
	return out;
}

/** Обновить общий комментарий заявки снабжению, не затрагивая позиции и документы исполнения. */
export async function updateSupplyRequestNote(erp: ErpClient, name: string, note: string): Promise<string> {
	await ensureNoteField(erp, 'Material Request');
	const request = await erp.get<Record<string, unknown>>('Material Request', name);
	if (!request || Number(request['docstatus'] ?? 0) === 2) throw new Error('заявка снабжению не найдена');
	const value = note.trim().slice(0, 500);
	await erp.update('Material Request', name, { [NOTE_FIELD]: value });
	return value;
}

const SUPPLY_REQUEST_DONE_STATUSES = new Set(['Transferred', 'Issued', 'Received', 'Stopped']);

/**
 * Изменить конечный склад ещё не исполненной заявки снабжения.
 * Дублируем значение в шапке и строках: шапку читает наше приложение,
 * а строки показывает и использует нативный интерфейс ERPNext.
 */
export async function updateSupplyRequestStore(
	erp: ErpClient,
	args: { requestName: string; requestKey: string; toStore: string },
): Promise<string> {
	await ensureMrField(erp);
	const request = await erp.get<Record<string, unknown>>('Material Request', args.requestName);
	if (!request || Number(request['docstatus'] ?? 0) === 2) throw new Error('заявка снабжения не найдена');
	if (materialRequestKey(args.requestName, request['creation']) !== args.requestKey) {
		throw new Error('заявка была изменена; обновите список');
	}
	if (SUPPLY_REQUEST_DONE_STATUSES.has(String(request['status'] ?? ''))) {
		throw new Error('у выполненной заявки нельзя менять склад');
	}
	const toStore = args.toStore.trim();
	if (!toStore) throw new Error('выберите конечный склад');
	const ctx = await erpContext(erp);
	const warehouse = erpWarehouse(ctx, toStore);
	const warehouseDoc = await erp.get<Record<string, unknown>>('Warehouse', warehouse);
	if (!warehouseDoc || Number(warehouseDoc['disabled'] ?? 0) === 1 || Number(warehouseDoc['is_group'] ?? 0) === 1) {
		throw new Error(`склад «${toStore}» не найден или недоступен`);
	}
	const rawItems = Array.isArray(request['items']) ? request.items as Array<Record<string, unknown>> : [];
	const items = rawItems.map((item) => requestItemPayload(item, { warehouse }));
	await erp.update('Material Request', args.requestName, {
		[MR_TO_STORE_FIELD]: toStore,
		items,
	});
	return toStore;
}

type SupplyAllocationMap = ReadonlyMap<string, ReadonlyMap<number, number>>;

async function purchaseAllocationForRequest(
	erp: ErpClient,
	requestName: string,
	requestKey: string,
): Promise<Map<number, number>> {
	await ensurePurchaseFields(erp);
	const result = new Map<number, number>();
	const headers = await erp.list<Record<string, unknown>>(
		'Purchase Order',
		['name'],
		[[SUPPLY_REQUEST_FIELD, '=', requestName], ['docstatus', '!=', 2]],
		0,
		'creation desc',
	);
	for (const header of headers) {
		const order = await erp.get<Record<string, unknown>>('Purchase Order', String(header['name'] ?? ''));
		if (!order || String(order[SUPPLY_REQUEST_KEY_FIELD] ?? '') !== requestKey) continue;
		if (String(order[SUPPLY_PURCHASE_STAGE_FIELD] ?? '') === 'cancelled') continue;
		for (const item of Array.isArray(order['items']) ? order.items as Array<Record<string, unknown>> : []) {
			const productId = Number(item['item_code']);
			if (!Number.isInteger(productId) || productId <= 0) continue;
			const qty = Number(item['qty'] ?? 0);
			const requestQty = Number(item[SUPPLY_PURCHASE_REQUEST_QTY_FIELD] ?? qty);
			result.set(productId, (result.get(productId) ?? 0) + Math.min(Math.max(qty, 0), Math.max(requestQty, 0)));
		}
	}
	return result;
}

function requestItemPayload(item: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	return {
		...(String(item['name'] ?? '') ? { name: String(item['name']) } : {}),
		item_code: String(patch['item_code'] ?? item['item_code'] ?? ''),
		qty: Number(patch['qty'] ?? item['qty'] ?? 0),
		schedule_date: String(item['schedule_date'] ?? ''),
		description: String(item['description'] ?? ''),
		warehouse: String(patch['warehouse'] ?? item['warehouse'] ?? ''),
	};
}
