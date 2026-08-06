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
import { randomUUID } from 'node:crypto';
import { ErpClient } from './client.js';
import {
	DEAL_PLAN_LINE_KEY_FIELD,
	DEAL_STAGES_FIELD,
	DEAL_VARIANTS_FIELD,
	ensurePlanField,
	findDealPlan,
	parseDealStages,
	type DealQuoteVariant,
	type DealQuoteVariantItem,
	type DealQuoteVariants,
	type DealStage,
	type DealStageItem,
	type PlanItem,
	type PlanLine,
} from './deal-plan-state.js';
import { listDealRealizations } from './deal-realizations.js';
import { DEAL_FIELD, TECH_CUSTOMER, ensureErpSetup } from './erp-setup.js';
import {
	CORE_ENGINEER_VISIT_SERVICE_ID,
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


// ── ПЛАН СДЕЛКИ = черновик Sales Order с b24_deal_id ──────────────────────────────────────
// Что менеджер собрал в сделку (реальные товары) живёт ЗДЕСЬ, а не в Б24 (Б24 несёт свёрнутую
// услугу «Выезд инженера»). Реализация (Delivery Note) идёт против заказа; остаток к отгрузке
// ERPNext считает сам (delivered_qty/per_delivered). Источник правды о составе сделки.
/** Уже проведённая часть сделки не должна исчезнуть из накопительного плана при следующем изменении. */
async function withRealizedBaseline(erp: ErpClient, dealId: number, lines: PlanLine[]): Promise<PlanLine[]> {
	const byId = new Map(lines.map((line) => [line.productId, { ...line }]));
	const history = new Map<number, { itemName: string; qty: number; amount: number }>();
	for (const document of await listDealRealizations(erp, dealId)) {
		for (const item of document.items) {
			if (item.productId <= 0) continue;
			const current = history.get(item.productId) ?? { itemName: item.itemName || `#${item.productId}`, qty: 0, amount: 0 };
			current.qty += item.qty;
			current.amount += item.qty * item.rate;
			if (item.qty > 0 && item.itemName) current.itemName = item.itemName;
			history.set(item.productId, current);
		}
	}
	for (const [productId, item] of history) {
		if (item.qty <= 0.000001) continue;
		const existing = byId.get(productId);
		if (existing) {
			// Менеджер может удалить ещё не отгруженный остаток, но уже проведённое стереть нельзя.
			existing.qty = Math.max(existing.qty, item.qty);
			continue;
		}
		byId.set(productId, {
			productId,
			itemName: item.itemName,
			qty: item.qty,
			priceListRate: Math.round((item.amount / item.qty) * 100) / 100,
			discountPercent: 0,
			isService: false,
		});
	}
	return [...byId.values()];
}

/** Перезаписать накопительный план сделки актуальным составом.
 *  Нет черновика — создаёт; есть — заменяет строки. Новые товары заводит в ядре (ensureCoreItem). */
export async function upsertDealPlan(erp: ErpClient, dealId: number, lines: PlanLine[], deliveryDate: string): Promise<{ name: string | null; lines: PlanLine[] }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	await ensurePlanField(erp);
	const existing = await findDealPlan(erp, dealId);
	const durableLines = await withRealizedBaseline(erp, dealId, lines);
	if (!durableLines.length) {
		if (existing) await erp.request('DELETE', `/api/resource/Sales%20Order/${encodeURIComponent(existing)}`);
		return { name: null, lines: [] };
	}
	for (const l of durableLines) await ensureCoreItem(erp, { productId: l.productId, name: l.itemName ?? `#${l.productId}`, ...(l.isService !== undefined ? { isService: l.isService } : {}) });
	const existingDoc = existing ? await erp.get<Record<string, unknown>>('Sales Order', existing) : null;
	const existingItems = Array.isArray(existingDoc?.['items']) ? existingDoc.items as Array<Record<string, unknown>> : [];
	const existingByProduct = new Map<number, Array<Record<string, unknown>>>();
	for (const item of existingItems) {
		const productId = Number(item['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		existingByProduct.set(productId, [...(existingByProduct.get(productId) ?? []), item]);
	}
	// Скидку храним нативно: price_list_rate (база) + discount_percentage → rate ERPNext посчитает сам.
	const preparedLines = durableLines.map((line) => {
		const previous = existingByProduct.get(line.productId)?.shift();
		const lineKey = line.lineKey?.trim() || String(previous?.[DEAL_PLAN_LINE_KEY_FIELD] ?? '').trim() || randomUUID();
		return { ...line, lineKey, rowName: String(previous?.['name'] ?? '').trim() };
	});
	const items = preparedLines.map((l) => ({
		...(l.rowName ? { name: l.rowName } : {}),
		item_code: String(l.productId),
		qty: l.qty,
		price_list_rate: l.priceListRate,
		discount_percentage: l.discountPercent,
		delivery_date: deliveryDate,
		[DEAL_PLAN_LINE_KEY_FIELD]: l.lineKey,
	}));
	const savedLines: PlanLine[] = preparedLines.map(({ rowName: _rowName, ...line }) => line);
	if (existing) {
		const doc = await erp.update('Sales Order', existing, { items, delivery_date: deliveryDate });
		return { name: String(doc['name'] ?? existing), lines: savedLines };
	}
	const doc = await erp.create('Sales Order', {
		company: ctx.company, customer: TECH_CUSTOMER, delivery_date: deliveryDate,
		[DEAL_FIELD]: String(dealId), items,
	});
	return { name: String(doc['name']), lines: savedLines };
}

/** Состав плана сделки (строки черновика Sales Order). delivered = сколько уже отгружено (ядро считает). */
export async function listDealPlan(erp: ErpClient, dealId: number): Promise<PlanItem[]> {
	const name = await findDealPlan(erp, dealId);
	if (!name) return [];
	const so = await erp.get<Record<string, unknown>>('Sales Order', name);
	const items = (so?.['items'] as Array<Record<string, unknown>>) ?? [];
	const ids = [...new Set(items.map((it) => String(it['item_code'] ?? '')).filter(Boolean))];
	const serviceById = new Map<string, boolean>();
	for (let i = 0; i < ids.length; i += 100) {
		const rows = await erp.list('Item', ['name', 'is_stock_item'], [['name', 'in', ids.slice(i, i + 100)]]);
		for (const row of rows) serviceById.set(String(row['name']), Number(row['is_stock_item'] ?? 1) === 0);
	}
	return items.flatMap((it) => {
		const productId = Number(it['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) return [];
		return [{
			productId,
			itemName: String(it['item_name'] ?? ''),
			qty: Number(it['qty'] ?? 0),
			rate: Number(it['rate'] ?? 0),
			priceListRate: Number(it['price_list_rate'] ?? it['rate'] ?? 0),
			discountPercent: Number(it['discount_percentage'] ?? 0),
			delivered: Number(it['delivered_qty'] ?? 0),
			isService: productId === CORE_ENGINEER_VISIT_SERVICE_ID || serviceById.get(String(it['item_code'] ?? '')) === true,
			lineKey: String(it[DEAL_PLAN_LINE_KEY_FIELD] ?? '').trim() || String(it['name'] ?? '').trim(),
		}];
	});
}

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

const emptyDealQuoteVariants = (): DealQuoteVariants => ({ enabled: false, selectedId: null, variants: [] });

function parseDealQuoteVariants(raw: unknown): DealQuoteVariants {
	if (typeof raw !== 'string' || !raw.trim()) return emptyDealQuoteVariants();
	try {
		const value = JSON.parse(raw) as Partial<DealQuoteVariants>;
		if (!Array.isArray(value.variants) || value.variants.length === 0) return emptyDealQuoteVariants();
		const variants = value.variants.flatMap((variant): DealQuoteVariant[] => {
			if (!variant || typeof variant !== 'object') return [];
			const row = variant as Partial<DealQuoteVariant>;
			const id = String(row.id ?? '').trim();
			const name = String(row.name ?? '').trim();
			if (!id || !name || !Array.isArray(row.items)) return [];
			const items = row.items.flatMap((item): DealQuoteVariantItem[] => {
				if (!item || typeof item !== 'object') return [];
				const source = item as Partial<DealQuoteVariantItem>;
				const productId = Number(source.productId);
				const qty = Number(source.qty);
				const priceListRate = Number(source.priceListRate);
				const discountPercent = Number(source.discountPercent ?? 0);
				if (!Number.isInteger(productId) || productId <= 0 || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(priceListRate) || priceListRate < 0) return [];
				return [{ productId, itemName: String(source.itemName ?? `#${productId}`), qty, priceListRate, discountPercent: Number.isFinite(discountPercent) ? discountPercent : 0, isService: Boolean(source.isService) }];
			});
			return [{ id, name, createdAt: String(row.createdAt ?? ''), createdById: String(row.createdById ?? ''), createdByName: String(row.createdByName ?? ''), items }];
		});
		if (!variants.length) return emptyDealQuoteVariants();
		const selected = String(value.selectedId ?? '').trim();
		return { enabled: true, selectedId: variants.some((variant) => variant.id === selected) ? selected : null, variants };
	} catch {
		return emptyDealQuoteVariants();
	}
}

async function dealPlanDocument(erp: ErpClient, dealId: number): Promise<{ name: string; doc: Record<string, unknown> } | null> {
	await ensurePlanField(erp);
	const name = await findDealPlan(erp, dealId);
	if (!name) return null;
	const doc = await erp.get<Record<string, unknown>>('Sales Order', name);
	return doc ? { name, doc } : null;
}

async function saveDealQuoteVariants(erp: ErpClient, planName: string, state: DealQuoteVariants): Promise<void> {
	await erp.update('Sales Order', planName, { [DEAL_VARIANTS_FIELD]: JSON.stringify(state) });
}

export async function listDealQuoteVariants(erp: ErpClient, dealId: number): Promise<DealQuoteVariants> {
	const plan = await dealPlanDocument(erp, dealId);
	return plan ? parseDealQuoteVariants(plan.doc[DEAL_VARIANTS_FIELD]) : emptyDealQuoteVariants();
}

export async function createDealQuoteVariant(erp: ErpClient, dealId: number, args: {
	name: string;
	sourceVariantId?: string;
	createdById: string;
	createdByName: string;
	/** Для уже начатой сделки первый вариант — снимок текущего рабочего состава и сразу основной. */
	selectCreated?: boolean;
}): Promise<DealQuoteVariants> {
	const plan = await dealPlanDocument(erp, dealId);
	if (!plan) throw new Error('сначала добавьте в сделку хотя бы одну позицию');
	const state = parseDealQuoteVariants(plan.doc[DEAL_VARIANTS_FIELD]);
	const cleanName = args.name.trim().slice(0, 80);
	if (!cleanName) throw new Error('укажите название варианта');
	if (state.variants.some((variant) => variant.name.toLocaleLowerCase('ru-RU') === cleanName.toLocaleLowerCase('ru-RU'))) throw new Error('вариант с таким названием уже есть');
	let items: DealQuoteVariantItem[];
	if (!state.enabled) {
		items = (await listDealPlan(erp, dealId)).map((item) => ({ productId: item.productId, itemName: item.itemName, qty: item.qty, priceListRate: item.priceListRate, discountPercent: item.discountPercent, isService: item.isService }));
	} else if (!args.sourceVariantId) {
		items = [];
	} else if (args.sourceVariantId === state.selectedId) {
		// Выбранный вариант живёт в рабочем плане и мог измениться после выбора:
		// копируем актуальный состав, а не его старый снимок в JSON вариантов.
		items = (await listDealPlan(erp, dealId)).map((item) => ({ productId: item.productId, itemName: item.itemName, qty: item.qty, priceListRate: item.priceListRate, discountPercent: item.discountPercent, isService: item.isService }));
	} else {
		const source = state.variants.find((variant) => variant.id === args.sourceVariantId);
		if (!source) throw new Error('вариант для копирования не найден');
		items = source.items.map((item) => ({ ...item }));
	}
	const variant: DealQuoteVariant = { id: randomUUID(), name: cleanName, createdAt: new Date().toISOString(), createdById: args.createdById, createdByName: args.createdByName, items };
	const next: DealQuoteVariants = {
		enabled: true,
		selectedId: args.selectCreated ? variant.id : state.selectedId,
		variants: [...state.variants, variant],
	};
	await saveDealQuoteVariants(erp, plan.name, next);
	return next;
}

export async function renameDealQuoteVariant(erp: ErpClient, dealId: number, variantId: string, name: string): Promise<DealQuoteVariants> {
	const plan = await dealPlanDocument(erp, dealId);
	if (!plan) throw new Error('план сделки не найден');
	const state = parseDealQuoteVariants(plan.doc[DEAL_VARIANTS_FIELD]);
	const cleanName = name.trim().slice(0, 80);
	if (!cleanName) throw new Error('укажите название варианта');
	if (!state.variants.some((variant) => variant.id === variantId)) throw new Error('вариант не найден');
	if (state.selectedId === variantId) throw new Error('основной вариант переименовывается через рабочую сделку');
	if (state.variants.some((variant) => variant.id !== variantId && variant.name.toLocaleLowerCase('ru-RU') === cleanName.toLocaleLowerCase('ru-RU'))) throw new Error('вариант с таким названием уже есть');
	const next = { ...state, variants: state.variants.map((variant) => variant.id === variantId ? { ...variant, name: cleanName } : variant) };
	await saveDealQuoteVariants(erp, plan.name, next);
	return next;
}

export async function deleteDealQuoteVariant(erp: ErpClient, dealId: number, variantId: string): Promise<DealQuoteVariants> {
	const plan = await dealPlanDocument(erp, dealId);
	if (!plan) throw new Error('план сделки не найден');
	const state = parseDealQuoteVariants(plan.doc[DEAL_VARIANTS_FIELD]);
	if (state.selectedId === variantId) throw new Error('основной вариант удалить нельзя');
	if (state.variants.length <= 1) throw new Error('последний вариант удалить нельзя');
	const next = { ...state, variants: state.variants.filter((variant) => variant.id !== variantId) };
	if (next.variants.length === state.variants.length) throw new Error('вариант не найден');
	await saveDealQuoteVariants(erp, plan.name, next);
	return next;
}

export async function updateDealQuoteVariantItems(erp: ErpClient, dealId: number, variantId: string, items: DealQuoteVariantItem[]): Promise<DealQuoteVariants> {
	const plan = await dealPlanDocument(erp, dealId);
	if (!plan) throw new Error('план сделки не найден');
	const state = parseDealQuoteVariants(plan.doc[DEAL_VARIANTS_FIELD]);
	if (!state.variants.some((variant) => variant.id === variantId)) throw new Error('вариант не найден');
	if (state.selectedId === variantId) throw new Error('основной вариант изменяется через рабочий состав и этапы');
	for (const item of items) await ensureCoreItem(erp, { productId: item.productId, name: item.itemName, isService: Boolean(item.isService) });
	const next = { ...state, variants: state.variants.map((variant) => variant.id === variantId ? { ...variant, items: items.map((item) => ({ ...item })) } : variant) };
	await saveDealQuoteVariants(erp, plan.name, next);
	return next;
}

export async function selectDealQuoteVariant(erp: ErpClient, dealId: number, variantId: string, deliveryDate: string): Promise<DealQuoteVariants> {
	const plan = await dealPlanDocument(erp, dealId);
	if (!plan) throw new Error('план сделки не найден');
	const state = parseDealQuoteVariants(plan.doc[DEAL_VARIANTS_FIELD]);
	const selected = state.variants.find((variant) => variant.id === variantId);
	if (!selected) throw new Error('вариант не найден');
	if (state.selectedId === selected.id) return state;
	if (!selected.items.length) throw new Error('нельзя выбрать пустой вариант');
	const currentItems = state.selectedId
		? (await listDealPlan(erp, dealId)).map((item): DealQuoteVariantItem => ({
			productId: item.productId,
			itemName: item.itemName,
			qty: item.qty,
			priceListRate: item.priceListRate,
			discountPercent: item.discountPercent,
			isService: item.isService,
		}))
		: null;
	await upsertDealPlan(erp, dealId, selected.items, deliveryDate);
	const next: DealQuoteVariants = {
		...state,
		selectedId: selected.id,
		variants: currentItems
			? state.variants.map((variant) => variant.id === state.selectedId ? { ...variant, items: currentItems } : variant)
			: state.variants,
	};
	await saveDealQuoteVariants(erp, plan.name, next);
	return next;
}

export async function cancelDealQuoteVariantSelection(erp: ErpClient, dealId: number): Promise<DealQuoteVariants> {
	const plan = await dealPlanDocument(erp, dealId);
	if (!plan) throw new Error('план сделки не найден');
	const state = parseDealQuoteVariants(plan.doc[DEAL_VARIANTS_FIELD]);
	if (!state.selectedId) return state;
	const currentItems = (await listDealPlan(erp, dealId)).map((item): DealQuoteVariantItem => ({
		productId: item.productId,
		itemName: item.itemName,
		qty: item.qty,
		priceListRate: item.priceListRate,
		discountPercent: item.discountPercent,
		isService: item.isService,
	}));
	const next: DealQuoteVariants = {
		...state,
		selectedId: null,
		variants: state.variants.map((variant) => variant.id === state.selectedId
			? { ...variant, items: currentItems }
			: variant),
	};
	await saveDealQuoteVariants(erp, plan.name, next);
	return next;
}

export async function assertDealQuoteVariantSelected(erp: ErpClient, dealId: number): Promise<void> {
	const state = await listDealQuoteVariants(erp, dealId);
	if (state.enabled && !state.selectedId) throw new Error('сначала отметьте вариант КП, выбранный клиентом');
}

export async function listDealStages(erp: ErpClient, dealId: number): Promise<DealStage[]> {
	await ensurePlanField(erp);
	const name = await findDealPlan(erp, dealId);
	if (!name) return [];
	const plan = await erp.get<Record<string, unknown>>('Sales Order', name);
	return parseDealStages(plan?.[DEAL_STAGES_FIELD]);
}

/** Сумма рабочего состава с отдельными ценами основной сделки и каждого этапа. */
export async function calculateDealPlanTotal(erp: ErpClient, dealId: number, onlyServices = false): Promise<number> {
	const [plan, stages] = await Promise.all([listDealPlan(erp, dealId), listDealStages(erp, dealId)]);
	let total = 0;
	for (const line of plan) {
		if (onlyServices && !line.isService) continue;
		const stageItems = stages.flatMap((stage) => stage.items.filter((item) => item.productId === line.productId));
		const stagedQty = stageItems.reduce((sum, item) => sum + item.qty, 0);
		const baseQty = Math.max(0, line.qty - stagedQty);
		total += baseQty * line.rate;
		total += stageItems.reduce((sum, item) =>
			sum + item.qty * item.price * (1 - (item.discountPercent ?? 0) / 100), 0);
	}
	return Math.round(total * 100) / 100;
}

/** Убирает возвращённые клиентом количества именно из основной строки или указанного этапа. */
export async function reduceDealPlanForReturns(
	erp: ErpClient,
	dealId: number,
	returned: Array<{ productId: number; qty: number; segmentId: string }>,
	deliveryDate: string,
): Promise<PlanItem[]> {
	const [plan, stages] = await Promise.all([listDealPlan(erp, dealId), listDealStages(erp, dealId)]);
	const returnedByProduct = new Map<number, number>();
	for (const line of returned) {
		returnedByProduct.set(line.productId, (returnedByProduct.get(line.productId) ?? 0) + line.qty);
		if (!line.segmentId.startsWith('stage:')) continue;
		const stageId = line.segmentId.slice('stage:'.length);
		const stage = stages.find((entry) => entry.id === stageId);
		const item = stage?.items.find((entry) => entry.productId === line.productId);
		if (!stage || !item) continue;
		item.qty = Math.max(0, item.qty - line.qty);
		stage.items = stage.items.filter((entry) => entry.qty > 0.000001);
	}
	const nextPlan = plan
		.map((item) => ({ ...item, qty: Math.max(0, item.qty - (returnedByProduct.get(item.productId) ?? 0)) }))
		.filter((item) => item.qty > 0.000001);
	const saved = await upsertDealPlan(erp, dealId, nextPlan.map((item) => ({
		productId: item.productId,
		itemName: item.itemName,
		qty: item.qty,
		priceListRate: item.priceListRate,
		discountPercent: item.discountPercent,
		isService: item.isService,
	})), deliveryDate);
	if (saved.name) await erp.update('Sales Order', saved.name, { [DEAL_STAGES_FIELD]: JSON.stringify(stages) });
	return listDealPlan(erp, dealId);
}

export async function appendDealStage(erp: ErpClient, dealId: number, stage: DealStage): Promise<void> {
	await ensurePlanField(erp);
	const name = await findDealPlan(erp, dealId);
	if (!name) throw new Error('план сделки не найден');
	const plan = await erp.get<Record<string, unknown>>('Sales Order', name);
	const stages = parseDealStages(plan?.[DEAL_STAGES_FIELD]);
	stages.push(stage);
	await erp.update('Sales Order', name, { [DEAL_STAGES_FIELD]: JSON.stringify(stages) });
}

export async function appendDealStageItems(erp: ErpClient, dealId: number, stageId: string, items: DealStageItem[]): Promise<void> {
	await ensurePlanField(erp);
	const name = await findDealPlan(erp, dealId);
	if (!name) throw new Error('план сделки не найден');
	const plan = await erp.get<Record<string, unknown>>('Sales Order', name);
	const stages = parseDealStages(plan?.[DEAL_STAGES_FIELD]);
	const stage = stages.find((row) => row.id === stageId);
	if (!stage) throw new Error('этап сделки не найден');
	for (const item of items) {
		const current = stage.items.find((row) => row.productId === item.productId);
		if (current) {
			current.qty += item.qty;
			current.price = item.price;
			current.itemName = item.itemName || current.itemName;
			current.isService = current.isService || item.isService;
		} else {
			stage.items.push(item);
		}
	}
	await erp.update('Sales Order', name, { [DEAL_STAGES_FIELD]: JSON.stringify(stages) });
}

export async function renameDealStage(erp: ErpClient, dealId: number, stageId: string, rawName: string): Promise<DealStage[]> {
	await ensurePlanField(erp);
	const name = rawName.trim();
	if (!name) throw new Error('укажи название этапа');
	if (name.length > 80) throw new Error('название этапа длиннее 80 символов');
	const planName = await findDealPlan(erp, dealId);
	if (!planName) throw new Error('план сделки не найден');
	const plan = await erp.get<Record<string, unknown>>('Sales Order', planName);
	const stages = parseDealStages(plan?.[DEAL_STAGES_FIELD]);
	const stage = stages.find((row) => row.id === stageId);
	if (!stage) throw new Error('этап сделки не найден');
	stage.name = name;
	await erp.update('Sales Order', planName, { [DEAL_STAGES_FIELD]: JSON.stringify(stages) });
	return stages;
}

/** Правит одну строку этапа и ту же агрегированную позицию плана одним обновлением Sales Order. */
export async function updateDealStageItem(
	erp: ErpClient,
	dealId: number,
	stageId: string,
	productId: number,
	qty: number,
	price: number,
	discountPercent: number,
): Promise<PlanItem[]> {
	await ensurePlanField(erp);
	const name = await findDealPlan(erp, dealId);
	if (!name) throw new Error('план сделки не найден');
	const plan = await erp.get<Record<string, unknown>>('Sales Order', name);
	const stages = parseDealStages(plan?.[DEAL_STAGES_FIELD]);
	const stage = stages.find((row) => row.id === stageId);
	if (!stage) throw new Error('этап сделки не найден');
	const stageItem = stage.items.find((row) => row.productId === productId);
	if (!stageItem) throw new Error('позиция этапа не найдена');

	const items = ((plan?.['items'] as Array<Record<string, unknown>>) ?? []).map((row) => ({ ...row }));
	const planItem = items.find((row) => Number(row['item_code']) === productId);
	if (!planItem) throw new Error('позиция общего плана не найдена');
	const nextPlanQty = Number(planItem['qty'] ?? 0) - stageItem.qty + qty;
	if (!Number.isFinite(nextPlanQty) || nextPlanQty <= 0) throw new Error('количество общего плана должно быть больше нуля');

	stageItem.qty = qty;
	stageItem.price = price;
	stageItem.discountPercent = discountPercent;
	planItem['qty'] = nextPlanQty;

	const deliveryDate = String(plan?.['delivery_date'] ?? new Date().toISOString().slice(0, 10));
	await erp.update('Sales Order', name, {
		delivery_date: deliveryDate,
		items: items.map((row) => ({
			item_code: String(row['item_code'] ?? ''),
			qty: Number(row['qty'] ?? 0),
			price_list_rate: Number(row['price_list_rate'] ?? row['rate'] ?? 0),
			discount_percentage: Number(row['discount_percentage'] ?? 0),
			delivery_date: String(row['delivery_date'] ?? deliveryDate),
		})),
		[DEAL_STAGES_FIELD]: JSON.stringify(stages),
	});
	return listDealPlan(erp, dealId);
}

/** Удаляет строку именно из выбранного этапа и уменьшает агрегированную позицию плана. */
export async function removeDealStageItem(
	erp: ErpClient,
	dealId: number,
	stageId: string,
	productId: number,
): Promise<PlanItem[]> {
	await ensurePlanField(erp);
	const name = await findDealPlan(erp, dealId);
	if (!name) throw new Error('план сделки не найден');
	const plan = await erp.get<Record<string, unknown>>('Sales Order', name);
	const stages = parseDealStages(plan?.[DEAL_STAGES_FIELD]);
	const stage = stages.find((row) => row.id === stageId);
	if (!stage) throw new Error('этап сделки не найден');
	const stageItem = stage.items.find((row) => row.productId === productId);
	if (!stageItem) throw new Error('позиция этапа не найдена');

	stage.items = stage.items.filter((row) => row.productId !== productId);
	const lines = ((plan?.['items'] as Array<Record<string, unknown>>) ?? []).flatMap((row): PlanLine[] => {
		const rowProductId = Number(row['item_code']);
		const qty = Number(row['qty'] ?? 0) - (rowProductId === productId ? stageItem.qty : 0);
		if (!Number.isInteger(rowProductId) || rowProductId <= 0 || qty <= 0.000001) return [];
		return [{
			productId: rowProductId,
			itemName: String(row['item_name'] ?? ''),
			qty,
			priceListRate: Number(row['price_list_rate'] ?? row['rate'] ?? 0),
			discountPercent: Number(row['discount_percentage'] ?? 0),
		}];
	});
	const durableLines = await withRealizedBaseline(erp, dealId, lines);
	if (!durableLines.length) {
		await erp.request('DELETE', `/api/resource/Sales%20Order/${encodeURIComponent(name)}`);
		return [];
	}

	const deliveryDate = String(plan?.['delivery_date'] ?? new Date().toISOString().slice(0, 10));
	await erp.update('Sales Order', name, {
		delivery_date: deliveryDate,
		items: durableLines.map((row) => ({
			item_code: String(row.productId),
			qty: row.qty,
			price_list_rate: row.priceListRate,
			discount_percentage: row.discountPercent,
			delivery_date: deliveryDate,
		})),
		[DEAL_STAGES_FIELD]: JSON.stringify(stages),
	});
	return listDealPlan(erp, dealId);
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

