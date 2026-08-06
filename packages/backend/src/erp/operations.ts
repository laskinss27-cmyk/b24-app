/**
 * Складские операции ERPNext (headless-ядро, «покрывало»).
 *
 * Принципы:
 *  - связь со сделкой Б24 = поле b24_deal_id в документе (никаких стен — см. docs/sklad-vynos.md);
 *  - Item Code в ERPNext = productId Б24 (решение миграции);
 *  - склады мапятся ПО ИМЕНИ: '<title Б24>' ↔ '<title> - <аббр компании>';
 *  - документы создаются ЧЕРНОВИКАМИ; проведение — отдельный явный шаг (submit);
 *  - company везде явно (в инсталляции есть демо-компания, и она дефолтная).
 */
import { ErpClient } from './client.js';
import {
	ensurePlanField,
	type PlanItem,
	type PlanLine,
} from './deal-plan-state.js';
import { listDealPlan, upsertDealPlan } from './deal-plan.js';
import { DEAL_FIELD, ensureErpSetup } from './erp-setup.js';
import {
	ensureCoreItem,
	fetchErpStocks,
} from './stock-catalog.js';
import { NOTE_FIELD, ensureNoteField } from './stock-movements.js';
import { SUPPLY_PURCHASE_ORDER_FIELD, SUPPLY_REQUEST_FIELD, SUPPLY_REQUEST_KEY_FIELD } from './stock-transfers.js';
import {
	SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
	SUPPLY_PURCHASE_STAGE_FIELD,
	ensurePurchaseFields,
} from './supply-purchases.js';
import { b24StoreTitle, erpContext, erpWarehouse, type ErpContext } from './warehouse-context.js';
import { assertProductReplaceAllowed, quantityFromDealChange, quantityFromSupplyChange, resolveDealQtyAtSync } from '../supply/line-sync.js';

export { b24StoreTitle, ensureErpSetup, erpContext, erpWarehouse };
export type { ErpContext };
export { DEAL_PLAN_LINE_KEY_FIELD } from './deal-plan-state.js';
export type {
	DealQuoteVariant,
	DealQuoteVariantItem,
	DealQuoteVariants,
	DealStage,
	DealStageItem,
	PlanItem,
	PlanLine,
} from './deal-plan-state.js';
export {
	appendDealStage,
	appendDealStageItems,
	assertDealQuoteVariantSelected,
	calculateDealPlanTotal,
	cancelDealQuoteVariantSelection,
	createDealQuoteVariant,
	deleteDealQuoteVariant,
	listDealPlan,
	listDealQuoteVariants,
	listDealStages,
	reduceDealPlanForReturns,
	removeDealStageItem,
	renameDealQuoteVariant,
	renameDealStage,
	selectDealQuoteVariant,
	updateDealQuoteVariantItems,
	updateDealStageItem,
	upsertDealPlan,
} from './deal-plan.js';
export {
	REALIZATION_BASE_SEGMENT,
	createClientReturns,
	createRealizationDraft,
	listDealRealizations,
	submitRealization,
	syncDealRealizationPrices,
} from './deal-realizations.js';
export type {
	ErpRealization,
	RealizationLine,
	RealizationPriceChange,
	RealizationPriceSyncResult,
} from './deal-realizations.js';
export {
	createInventoryRecoDraft,
	deleteInventoryRecoDraft,
	fetchErpItemNames,
	fetchErpStoreStock,
	fetchErpStoreStockFull,
	submitInventoryReco,
} from './inventory-reconciliation.js';
export type { ErpStoreLine, InventoryRecoLine } from './inventory-reconciliation.js';
export {
	MARKETPLACE_BUNDLE_SOURCE_FIELD,
	MARKETPLACE_BUNDLE_UNITS_FIELD,
	MARKETPLACE_NAME_FIELD,
	MARKETPLACE_OLD_ID_FIELD,
	MARKETPLACE_OPERATION_FIELD,
	MARKETPLACE_TITLE_FIELD,
	ensureMarketplaceOldIdField,
} from './marketplace-fields.js';
export {
	createMarketplaceBundle,
	createMarketplaceReturn,
	createMarketplaceReturnBatch,
	createMarketplaceSale,
	listMarketplaceOperations,
	listMarketplaceReturnOptions,
	listMarketplaceReturnSales,
	marketplaceSaleTitle,
} from './marketplace-operations.js';
export type {
	MarketplaceOperation,
	MarketplaceOperationItem,
	MarketplaceOperationKind,
	MarketplaceReturnOption,
	MarketplaceReturnSale,
	MarketplaceReturnSaleItem,
} from './marketplace-operations.js';
export {
	REALIZATION_SEGMENT_FIELD,
	coreStoreId,
	ensureCoreItem,
	ensureSupplier,
	fetchCoreCatalogItems,
	fetchCoreCatalogPrices,
	fetchErpPurchasing,
	fetchErpRetailPrices,
	fetchErpStocks,
	fetchErpStocksFor,
	listActiveStoreTitles,
	searchErpItems,
	updateCoreCatalogPrices,
	updateMarketplaceOldId,
} from './stock-catalog.js';
export type { CoreCatalogItem, CoreCatalogPrices } from './stock-catalog.js';
export { createReceiptDraft, createWriteOffDraft, submitDoc } from './stock-document-drafts.js';
export { fetchCoreDocDetail, itemStockLedger, listCoreMovements } from './stock-movements.js';
export type { CoreDocDetail, CoreDocItem, CoreMovement, ItemMovement } from './stock-movements.js';
export {
	SUPPLY_PURCHASE_EXPECTED_AT_FIELD,
	SUPPLY_PURCHASE_ORDERED_AT_FIELD,
	SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
	SUPPLY_PURCHASE_STAGE_FIELD,
	createPurchaseOrderDraft,
	createSupplyPurchaseReceipt,
	updatePurchaseOrderDraft,
	updateSupplyPurchaseStage,
} from './supply-purchases.js';
export type { PurchaseDraftLine, SupplyPurchaseStage } from './supply-purchases.js';
export {
	SUPPLY_PURCHASE_ORDER_FIELD,
	SUPPLY_REQUEST_FIELD,
	SUPPLY_REQUEST_KEY_FIELD,
	completeTransferFromTransit,
	createTransferDraft,
	planTransferCompletion,
	receiveTransferFromTransit,
	shipTransferToTransit,
} from './stock-transfers.js';
export {
	REPAIR_ITEM_GROUP,
	deliverRepairUnit,
	ensureRepairItem,
	locateRepairUnit,
	moveRepairUnit,
	receiveRepairUnit,
	renameRepairItem,
} from './repair-stock.js';
export type { RepairUnitLocation } from './repair-stock.js';

export const SUPPLY_DEAL_LINE_KEY_FIELD = 'b24_deal_line_key';
export const SUPPLY_DEAL_QTY_FIELD = 'b24_deal_qty';



function planDraft(line: PlanItem): PlanLine {
	return {
		productId: line.productId,
		itemName: line.itemName,
		qty: line.qty,
		priceListRate: line.priceListRate,
		discountPercent: line.discountPercent,
		isService: line.isService,
		lineKey: line.lineKey,
	};
}

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

/** Менеджер заменяет товар: та же необработанная строка меняется в плане и открытых заявках. */
export async function replaceDealPlanSupplyProduct(
	erp: ErpClient,
	args: {
		dealId: number;
		oldProductId: number;
		newProductId: number;
		newItemName: string;
		deliveryDate: string;
		transferAllocation?: SupplyAllocationMap;
	},
): Promise<PlanItem[]> {
	if (args.oldProductId === args.newProductId) return listDealPlan(erp, args.dealId);
	const previousPlan = await listDealPlan(erp, args.dealId);
	const source = previousPlan.find((line) => line.productId === args.oldProductId);
	if (!source) throw new Error('заменяемая позиция больше не найдена в сделке');
	if (previousPlan.some((line) => line.productId === args.newProductId)) throw new Error('новый товар уже есть в сделке отдельной строкой');
	const headers = await erp.list<Record<string, unknown>>(
		'Material Request',
		['name', 'status'],
		[['docstatus', '!=', 2], [DEAL_FIELD, '=', String(args.dealId)]],
		0,
		'creation desc',
	);
	const requestUpdates: Array<{ name: string; before: Record<string, unknown>[]; after: Record<string, unknown>[] }> = [];
	for (const header of headers) {
		if (/stopped|transferred|issued|received|completed/i.test(String(header['status'] ?? ''))) continue;
		const name = String(header['name'] ?? '');
		const request = await erp.get<Record<string, unknown>>('Material Request', name);
		if (!request) continue;
		const requestKey = materialRequestKey(name, request['creation']);
		const rawItems = Array.isArray(request['items']) ? request.items as Array<Record<string, unknown>> : [];
		const target = rawItems.find((item) =>
			String(item[SUPPLY_DEAL_LINE_KEY_FIELD] ?? '') === source.lineKey || Number(item['item_code']) === source.productId);
		if (!target) continue;
		const allocatedQty = await requestLineAllocation(erp, name, requestKey, source.productId, args.transferAllocation);
		assertProductReplaceAllowed(allocatedQty);
		requestUpdates.push({
			name,
			before: rawItems.map((item) => requestItemPayload(item, {})),
			after: rawItems.map((item) => requestItemPayload(item, item === target ? {
				item_code: String(args.newProductId),
				[SUPPLY_DEAL_LINE_KEY_FIELD]: source.lineKey,
				[SUPPLY_DEAL_QTY_FIELD]: source.qty,
			} : {})),
		});
	}
	await ensureCoreItem(erp, { productId: args.newProductId, name: args.newItemName || `#${args.newProductId}` });
	const nextPlan = previousPlan.map((line): PlanLine => line === source
		? { ...planDraft(line), productId: args.newProductId, itemName: args.newItemName || `#${args.newProductId}` }
		: planDraft(line));
	await upsertDealPlan(erp, args.dealId, nextPlan, args.deliveryDate);
	try {
		for (const update of requestUpdates) await erp.update('Material Request', update.name, { items: update.after });
	} catch (error) {
		await upsertDealPlan(erp, args.dealId, previousPlan.map(planDraft), args.deliveryDate).catch(() => undefined);
		for (const update of requestUpdates) await erp.update('Material Request', update.name, { items: update.before }).catch(() => undefined);
		throw error;
	}
	return listDealPlan(erp, args.dealId);
}

/** Снабжение меняет необработанную строку заявки; дельта количества переносится в сделку. */
export async function updateSupplyRequestLineAndDeal(
	erp: ErpClient,
	args: {
		dealId: number;
		requestName: string;
		requestKey: string;
		rowName?: string;
		productId: number;
		nextProductId: number;
		nextItemName: string;
		nextQty: number;
		deliveryDate: string;
		transferAllocation?: SupplyAllocationMap;
	},
): Promise<{ dealQty: number }> {
	const request = await erp.get<Record<string, unknown>>('Material Request', args.requestName);
	if (!request || materialRequestKey(args.requestName, request['creation']) !== args.requestKey) throw new Error('заявка была изменена; обновите список');
	const rawItems = Array.isArray(request['items']) ? request.items as Array<Record<string, unknown>> : [];
	const target = rawItems.find((item) =>
		(args.rowName && String(item['name'] ?? '') === args.rowName) || Number(item['item_code']) === args.productId);
	if (!target) throw new Error('позиция больше не найдена в заявке');
	const plan = await listDealPlan(erp, args.dealId);
	const storedKey = String(target[SUPPLY_DEAL_LINE_KEY_FIELD] ?? '').trim();
	const planLine = (storedKey ? plan.find((line) => line.lineKey === storedKey) : undefined)
		?? plan.find((line) => line.productId === args.productId);
	const requestQty = Number(target['qty'] ?? 0);
	const allocatedQty = Math.min(requestQty, await requestLineAllocation(erp, args.requestName, args.requestKey, args.productId, args.transferAllocation));
	if (!planLine) {
		const existingReplacement = !storedKey && args.nextProductId !== args.productId
			? plan.find((line) => line.productId === args.nextProductId)
			: undefined;
		if (!existingReplacement) throw new Error('связанная позиция больше не найдена в сделке');
		assertProductReplaceAllowed(allocatedQty);
		if (args.nextQty - existingReplacement.qty > 0.000001) {
			throw new Error(`в сделке новой позиции только ${existingReplacement.qty}; заявка не может быть больше`);
		}
		await ensureCoreItem(erp, { productId: args.nextProductId, name: args.nextItemName || `#${args.nextProductId}` });
		const after = rawItems.map((item) => requestItemPayload(item, item === target ? {
			item_code: String(args.nextProductId),
			qty: args.nextQty,
			[SUPPLY_DEAL_LINE_KEY_FIELD]: existingReplacement.lineKey,
			[SUPPLY_DEAL_QTY_FIELD]: existingReplacement.qty,
		} : {}));
		await erp.update('Material Request', args.requestName, { items: after });
		return { dealQty: existingReplacement.qty };
	}
	if (args.nextProductId !== args.productId) assertProductReplaceAllowed(allocatedQty);
	const dealQty = quantityFromSupplyChange({ dealQty: planLine.qty, requestQty, nextRequestQty: args.nextQty, allocatedQty });
	if (dealQty <= 0.000001) throw new Error('позицию нельзя обнулить из снабжения; удалите или замените её в сделке');
	if (plan.some((line) => line !== planLine && line.productId === args.nextProductId)) throw new Error('новый товар уже есть в сделке отдельной строкой');
	await ensureCoreItem(erp, { productId: args.nextProductId, name: args.nextItemName || `#${args.nextProductId}` });
	const nextPlan = plan.map((line): PlanLine => line === planLine
		? { ...planDraft(line), productId: args.nextProductId, itemName: args.nextItemName || `#${args.nextProductId}`, qty: dealQty }
		: planDraft(line));
	await upsertDealPlan(erp, args.dealId, nextPlan, args.deliveryDate);
	const before = rawItems.map((item) => requestItemPayload(item, {}));
	const after = rawItems.map((item) => requestItemPayload(item, item === target ? {
		item_code: String(args.nextProductId),
		qty: args.nextQty,
		[SUPPLY_DEAL_LINE_KEY_FIELD]: planLine.lineKey,
		[SUPPLY_DEAL_QTY_FIELD]: dealQty,
	} : {}));
	try {
		await erp.update('Material Request', args.requestName, { items: after });
	} catch (error) {
		await upsertDealPlan(erp, args.dealId, plan.map(planDraft), args.deliveryDate).catch(() => undefined);
		await erp.update('Material Request', args.requestName, { items: before }).catch(() => undefined);
		throw error;
	}
	return { dealQty };
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
	for (const [fieldname, label, fieldtype, insertAfter] of [
		[SUPPLY_DEAL_LINE_KEY_FIELD, 'B24 Deal Line Key', 'Data', 'item_code'],
		[SUPPLY_DEAL_QTY_FIELD, 'B24 Deal Qty', 'Float', SUPPLY_DEAL_LINE_KEY_FIELD],
	] as const) {
		const name = `Material Request Item-${fieldname}`;
		if (!(await erp.get('Custom Field', name))) {
			await erp.create('Custom Field', {
				dt: 'Material Request Item', fieldname, label, fieldtype, insert_after: insertAfter, read_only: 1,
			});
		}
	}
	mrFieldDone = true;
}

export interface SupplyReqLine { productId: number; itemName?: string; qty: number; note?: string; dealLineKey?: string; dealQty?: number }

/** Создать заявку в снабжение (Material Request, тип Purchase) по выбранным товарам сделки. */
export async function createSupplyRequest(erp: ErpClient, args: { dealId: number; scheduleDate: string; lines: SupplyReqLine[]; toStore?: string; note?: string }): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	await ensureMrField(erp);
	if (args.note) await ensureNoteField(erp, 'Material Request');
	if (!args.lines.length) throw new Error('пустая заявка');
	for (const l of args.lines) await ensureCoreItem(erp, { productId: l.productId, name: l.itemName ?? `#${l.productId}` });
	const plan = await listDealPlan(erp, args.dealId);
	const planByProduct = new Map(plan.map((line) => [line.productId, line]));
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
			[SUPPLY_DEAL_LINE_KEY_FIELD]: l.dealLineKey?.trim() || planByProduct.get(l.productId)?.lineKey || '',
			[SUPPLY_DEAL_QTY_FIELD]: Number.isFinite(l.dealQty) ? l.dealQty : (planByProduct.get(l.productId)?.qty ?? l.qty),
			...(l.note ? { description: l.note } : {}),
		})),
	});
	return { name: String(doc['name']) };
}

export interface SupplyReqItem { productId: number; itemName: string; qty: number; note: string; stocks: Record<string, number>; rowName: string; dealLineKey: string; dealQty: number }
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
				dealLineKey: String(it[SUPPLY_DEAL_LINE_KEY_FIELD] ?? ''),
				dealQty: Number(it[SUPPLY_DEAL_QTY_FIELD] ?? it['qty'] ?? 0),
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
		[SUPPLY_DEAL_LINE_KEY_FIELD]: String(patch[SUPPLY_DEAL_LINE_KEY_FIELD] ?? item[SUPPLY_DEAL_LINE_KEY_FIELD] ?? ''),
		[SUPPLY_DEAL_QTY_FIELD]: Number(patch[SUPPLY_DEAL_QTY_FIELD] ?? item[SUPPLY_DEAL_QTY_FIELD] ?? item['qty'] ?? 0),
	};
}

/**
 * Переносит изменение количества рабочего состава сделки в ещё открытую потребность снабжения.
 * Уже созданные закупки и перемещения не переписываются: они образуют нижнюю границу.
 */
export async function syncSupplyRequestQuantitiesFromDeal(
	erp: ErpClient,
	args: {
		dealId: number;
		previousPlan: readonly PlanItem[];
		nextPlan: readonly PlanLine[];
		transferAllocation?: SupplyAllocationMap;
	},
): Promise<number> {
	await ensureMrField(erp);
	const previousByKey = new Map(args.previousPlan.map((line) => [line.lineKey, line]));
	const previousByProduct = new Map(args.previousPlan.map((line) => [line.productId, line]));
	const nextByKey = new Map(args.nextPlan.flatMap((line) => line.lineKey ? [[line.lineKey, line] as const] : []));
	const nextByProduct = new Map(args.nextPlan.map((line) => [line.productId, line]));
	const headers = await erp.list<Record<string, unknown>>(
		'Material Request',
		['name', 'status'],
		[['docstatus', '!=', 2], [DEAL_FIELD, '=', String(args.dealId)]],
		0,
		'creation desc',
	);
	const pending: Array<{ name: string; before: Record<string, unknown>[]; after: Record<string, unknown>[] }> = [];
	for (const header of headers) {
		if (/stopped|transferred|issued|received|completed/i.test(String(header['status'] ?? ''))) continue;
		const name = String(header['name'] ?? '');
		const request = await erp.get<Record<string, unknown>>('Material Request', name);
		if (!request) continue;
		const requestKey = materialRequestKey(name, request['creation']);
		const purchaseAllocation = await purchaseAllocationForRequest(erp, name, requestKey);
		const transferAllocation = args.transferAllocation?.get(requestKey) ?? new Map<number, number>();
		const rawItems = Array.isArray(request['items']) ? request.items as Array<Record<string, unknown>> : [];
		let dirty = false;
		const items: Record<string, unknown>[] = [];
		for (const item of rawItems) {
			const productId = Number(item['item_code']);
			const storedKey = String(item[SUPPLY_DEAL_LINE_KEY_FIELD] ?? '').trim();
			const previous = (storedKey ? previousByKey.get(storedKey) : undefined) ?? previousByProduct.get(productId);
			const lineKey = storedKey || previous?.lineKey || '';
			const next = (lineKey ? nextByKey.get(lineKey) : undefined) ?? nextByProduct.get(productId);
			if (!previous) {
				items.push(requestItemPayload(item, {}));
				continue;
			}
			const requestQty = Number(item['qty'] ?? 0);
			if (!next) {
				const allocatedQty = Math.min(requestQty, (purchaseAllocation.get(productId) ?? 0) + (transferAllocation.get(productId) ?? 0));
				assertProductReplaceAllowed(allocatedQty);
				dirty = true;
				continue;
			}
			const storedDealQty = Number(item[SUPPLY_DEAL_QTY_FIELD]);
			const hasStoredDealQty = Number.isFinite(storedDealQty) && storedDealQty > 0.000001;
			const dealQtyAtSync = resolveDealQtyAtSync(item[SUPPLY_DEAL_QTY_FIELD], previous.qty);
			const allocatedQty = Math.min(requestQty, (purchaseAllocation.get(productId) ?? 0) + (transferAllocation.get(productId) ?? 0));
			const nextQty = quantityFromDealChange({ requestQty, dealQtyAtSync, nextDealQty: next.qty, allocatedQty });
			if (nextQty <= 0.000001) {
				dirty = true;
				continue;
			}
			if (Math.abs(nextQty - requestQty) > 0.000001 || Math.abs(next.qty - dealQtyAtSync) > 0.000001 || !storedKey || !hasStoredDealQty) dirty = true;
			items.push(requestItemPayload(item, {
				qty: nextQty,
				[SUPPLY_DEAL_LINE_KEY_FIELD]: lineKey,
				[SUPPLY_DEAL_QTY_FIELD]: next.qty,
			}));
		}
		if (!dirty) continue;
		if (!items.length) throw new Error(`заявка ${name} останется пустой; сначала замените её последнюю позицию`);
		pending.push({ name, before: rawItems.map((item) => requestItemPayload(item, {})), after: items });
	}
	const applied: typeof pending = [];
	try {
		for (const update of pending) {
			await erp.update('Material Request', update.name, { items: update.after });
			applied.push(update);
		}
	} catch (error) {
		for (const update of applied.reverse()) await erp.update('Material Request', update.name, { items: update.before }).catch(() => undefined);
		throw error;
	}
	return pending.length;
}

