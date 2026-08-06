import { ErpClient } from './client.js';
import { DEAL_STAGES_FIELD, findDealPlan, parseDealStages } from './deal-plan-state.js';
import { DEAL_FIELD, TECH_CUSTOMER, ensureErpSetup } from './erp-setup.js';
import { REALIZATION_SEGMENT_FIELD, ensureCoreItem } from './stock-catalog.js';
import { NOTE_FIELD, ensureNoteField } from './stock-movements.js';
import { b24StoreTitle, erpContext, erpWarehouse } from './warehouse-context.js';

export const REALIZATION_BASE_SEGMENT = 'base';

export interface RealizationLine {
	productId: number;
	qty: number;
	/** Конкретная строка состава: base или stage:<id>. */
	segmentId?: string;
	/** Для товара — склад списания. У услуги склада нет и остаток не двигается. */
	storeTitle?: string;
	isService?: boolean;
	/** Цена продажи за единицу (для суммы документа). */
	rate: number;
}

export interface ErpRealization {
	name: string;
	dealId: string;
	postingDate: string;
	submitted: boolean;
	/** true — это возврат от клиента (Delivery Note is_return), а не отгрузка. */
	isReturn: boolean;
	/** Исходная реализация для возвратного Delivery Note. */
	returnAgainst: string;
	grandTotal: number;
	items: Array<{ productId: number; itemName: string; qty: number; storeTitle: string; rate: number; rowName: string; sourceRow: string; segmentId: string }>;
}

export interface RealizationPriceSyncResult {
	draftsUpdated: number;
	realizationsAmended: number;
	returnsAmended: number;
}

export interface RealizationPriceChange {
	productId: number;
	segmentId: string;
	rate: number;
}

type DeliveryNoteSnapshot = {
	name: string;
	submitted: boolean;
	isReturn: boolean;
	returnAgainst: string;
	doc: Record<string, unknown>;
	items: Array<Record<string, unknown>>;
};

const DELIVERY_NOTE_COPY_FIELDS = [
	'company',
	'customer',
	'posting_date',
	'posting_time',
	'set_posting_time',
	'currency',
	'conversion_rate',
	'selling_price_list',
	'price_list_currency',
	'plc_conversion_rate',
	'territory',
	'project',
	'cost_center',
	'customer_address',
	'shipping_address_name',
	'dispatch_address_name',
	'company_address',
	'contact_person',
	'transporter',
	'driver',
	'lr_no',
	'vehicle_no',
	'tc_name',
	'terms',
	'letter_head',
	'print_without_amount',
] as const;

const DELIVERY_NOTE_ITEM_COPY_FIELDS = [
	'item_code',
	REALIZATION_SEGMENT_FIELD,
	'item_name',
	'description',
	'brand',
	'item_group',
	'image',
	'qty',
	'stock_uom',
	'uom',
	'conversion_factor',
	'warehouse',
	'target_warehouse',
	'rate',
	'price_list_rate',
	'discount_percentage',
	'discount_amount',
	'margin_type',
	'margin_rate_or_amount',
	'expense_account',
	'cost_center',
	'project',
	'against_sales_order',
	'so_detail',
	'serial_and_batch_bundle',
	'use_serial_batch_fields',
	'serial_no',
	'batch_no',
	'allow_zero_valuation_rate',
	'quality_inspection',
	'customer_item_code',
	'page_break',
] as const;

const LEGACY_SOURCE_ROW = '__b24_source_row';
const KEEP_ITEM_IDENTITY = '__b24_keep_item_identity';
const segmentPriceKey = (productId: number, segmentId: string): string => `${productId}\u0000${segmentId}`;
const sourceSegmentKey = (rowName: string, segmentId: string): string => `${rowName}\u0000${segmentId}`;
const itemSegmentId = (item: Record<string, unknown>): string =>
	String(item[REALIZATION_SEGMENT_FIELD] ?? '').trim() || REALIZATION_BASE_SEGMENT;
const itemSourceRow = (item: Record<string, unknown>): string =>
	String(item[LEGACY_SOURCE_ROW] ?? item['name'] ?? '');

function pickDefined(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = source[key];
		if (value !== undefined && value !== null && value !== '') out[key] = value;
	}
	return out;
}
function deliveryNoteItemCopy(
	item: Record<string, unknown>,
	prices: ReadonlyMap<string, number>,
	sourceRows?: ReadonlyMap<string, string>,
	keepIdentity = false,
): Record<string, unknown> {
	const out = pickDefined(item, DELIVERY_NOTE_ITEM_COPY_FIELDS);
	const productId = Number(item['item_code']);
	const segmentId = itemSegmentId(item);
	out[REALIZATION_SEGMENT_FIELD] = segmentId;
	const nextRate = prices.get(segmentPriceKey(productId, segmentId));
	if (nextRate !== undefined) {
		out['rate'] = nextRate;
		out['price_list_rate'] = nextRate;
		out['discount_percentage'] = 0;
		out['discount_amount'] = 0;
	}
	const sourceRow = String(item['dn_detail'] ?? '');
	if (sourceRow) out['dn_detail'] = sourceRows?.get(sourceSegmentKey(sourceRow, segmentId)) ?? sourceRow;
	if (keepIdentity && item[KEEP_ITEM_IDENTITY] !== false) {
		const name = String(item['name'] ?? '');
		if (name) out['name'] = name;
	}
	return out;
}

function deliveryNoteCopy(
	snapshot: DeliveryNoteSnapshot,
	prices: ReadonlyMap<string, number>,
	args: { amendedFrom?: string; returnAgainst?: string; sourceRows?: ReadonlyMap<string, string>; keepItemIdentity?: boolean } = {},
): Record<string, unknown> {
	const out = pickDefined(snapshot.doc, DELIVERY_NOTE_COPY_FIELDS);
	out[DEAL_FIELD] = String(snapshot.doc[DEAL_FIELD] ?? '');
	if (snapshot.doc[NOTE_FIELD] !== undefined && snapshot.doc[NOTE_FIELD] !== null) out[NOTE_FIELD] = snapshot.doc[NOTE_FIELD];
	if (snapshot.isReturn) {
		out['is_return'] = 1;
		out['return_against'] = args.returnAgainst ?? snapshot.returnAgainst;
	}
	if (args.amendedFrom) out['amended_from'] = args.amendedFrom;
	out['items'] = snapshot.items.map((item) =>
		deliveryNoteItemCopy(item, prices, args.sourceRows, Boolean(args.keepItemIdentity)));
	return out;
}

async function activeDealDeliveryNotes(erp: ErpClient, dealId: number): Promise<DeliveryNoteSnapshot[]> {
	const heads = await erp.list('Delivery Note',
		['name', 'docstatus', 'is_return', 'return_against', 'posting_date', 'posting_time', 'creation'],
		[[DEAL_FIELD, '=', String(dealId)], ['docstatus', '!=', 2]]);
	const out: DeliveryNoteSnapshot[] = [];
	for (const head of heads) {
		const name = String(head['name'] ?? '');
		if (!name) continue;
		const doc = await erp.get<Record<string, unknown>>('Delivery Note', name);
		if (!doc) continue;
		out.push({
			name,
			submitted: Number(head['docstatus'] ?? doc['docstatus'] ?? 0) === 1,
			isReturn: Number(head['is_return'] ?? doc['is_return'] ?? 0) === 1,
			returnAgainst: String(head['return_against'] ?? doc['return_against'] ?? ''),
			doc,
			items: Array.isArray(doc['items']) ? doc['items'] as Array<Record<string, unknown>> : [],
		});
	}
	return out;
}

async function dealSegmentBudgets(erp: ErpClient, dealId: number): Promise<Map<number, Array<{ segmentId: string; remaining: number }>>> {
	const name = await findDealPlan(erp, dealId);
	if (!name) return new Map();
	const plan = await erp.get<Record<string, unknown>>('Sales Order', name);
	if (!plan) return new Map();
	const stages = parseDealStages(plan[DEAL_STAGES_FIELD]);
	const stageQty = new Map<number, number>();
	for (const stage of stages) {
		for (const item of stage.items) {
			stageQty.set(item.productId, (stageQty.get(item.productId) ?? 0) + item.qty);
		}
	}
	const budgets = new Map<number, Array<{ segmentId: string; remaining: number }>>();
	for (const item of (plan['items'] as Array<Record<string, unknown>> | undefined) ?? []) {
		const productId = Number(item['item_code']);
		const qty = Number(item['qty'] ?? 0);
		if (!Number.isInteger(productId) || productId <= 0 || qty <= 0) continue;
		const segments: Array<{ segmentId: string; remaining: number }> = [];
		const baseQty = Math.max(0, qty - (stageQty.get(productId) ?? 0));
		if (baseQty > 0.000001) segments.push({ segmentId: REALIZATION_BASE_SEGMENT, remaining: baseQty });
		for (const stage of stages) {
			const stageItem = stage.items.find((row) => row.productId === productId);
			if (stageItem && stageItem.qty > 0.000001) {
				segments.push({ segmentId: `stage:${stage.id}`, remaining: stageItem.qty });
			}
		}
		if (!segments.length) segments.push({ segmentId: REALIZATION_BASE_SEGMENT, remaining: qty });
		budgets.set(productId, segments);
	}
	return budgets;
}

/**
 * Старые Delivery Note не знали этапа. Раскладываем их строки по порядку интерфейса:
 * основная сделка, затем этапы по дате создания. Если одна старая строка пересекает границу
 * этапов, при исправлении она будет честно разделена на две строки с тем же складским итогом.
 */
async function assignRealizationSegments(
	erp: ErpClient,
	dealId: number,
	documents: DeliveryNoteSnapshot[],
): Promise<void> {
	const budgets = await dealSegmentBudgets(erp, dealId);
	const orderedSales = documents
		.filter((document) => !document.isReturn)
		.sort((a, b) => {
			const aOrder = `${String(a.doc['posting_date'] ?? '')}:${String(a.doc['posting_time'] ?? '')}:${String(a.doc['creation'] ?? '')}:${a.name}`;
			const bOrder = `${String(b.doc['posting_date'] ?? '')}:${String(b.doc['posting_time'] ?? '')}:${String(b.doc['creation'] ?? '')}:${b.name}`;
			return aOrder.localeCompare(bOrder);
		});

	for (const document of orderedSales) {
		const nextItems: Array<Record<string, unknown>> = [];
		for (const item of document.items) {
			const productId = Number(item['item_code']);
			const qty = Math.abs(Number(item['qty'] ?? 0));
			const sourceRow = String(item['name'] ?? '');
			const explicitSegment = String(item[REALIZATION_SEGMENT_FIELD] ?? '').trim();
			const productBudgets = budgets.get(productId) ?? [];
			if (explicitSegment) {
				const budget = productBudgets.find((entry) => entry.segmentId === explicitSegment);
				if (budget) budget.remaining = Math.max(0, budget.remaining - qty);
				nextItems.push({ ...item, [REALIZATION_SEGMENT_FIELD]: explicitSegment, [LEGACY_SOURCE_ROW]: sourceRow });
				continue;
			}
			let left = qty;
			let part = 0;
			for (const budget of productBudgets) {
				if (left <= 0.000001) break;
				if (budget.remaining <= 0.000001) continue;
				const allocated = Math.min(left, budget.remaining);
				nextItems.push({
					...item,
					qty: allocated,
					[REALIZATION_SEGMENT_FIELD]: budget.segmentId,
					[LEGACY_SOURCE_ROW]: sourceRow,
					[KEEP_ITEM_IDENTITY]: part === 0,
				});
				budget.remaining -= allocated;
				left -= allocated;
				part += 1;
			}
			if (left > 0.000001 || part === 0) {
				const fallbackQty = left > 0.000001 ? left : qty;
				const fallbackSegment = productBudgets.at(-1)?.segmentId ?? REALIZATION_BASE_SEGMENT;
				const previous = nextItems.at(-1);
				if (previous && itemSourceRow(previous) === sourceRow && itemSegmentId(previous) === fallbackSegment) {
					previous['qty'] = Number(previous['qty'] ?? 0) + fallbackQty;
				} else {
					nextItems.push({
						...item,
						qty: fallbackQty,
						[REALIZATION_SEGMENT_FIELD]: fallbackSegment,
						[LEGACY_SOURCE_ROW]: sourceRow,
						[KEEP_ITEM_IDENTITY]: part === 0,
					});
				}
			}
		}
		document.items = nextItems;
	}

	const sourceSlices = new Map<string, Array<{ segmentId: string; qty: number }>>();
	for (const document of orderedSales) {
		for (const item of document.items) {
			const sourceRow = itemSourceRow(item);
			if (!sourceRow) continue;
			if (!sourceSlices.has(sourceRow)) sourceSlices.set(sourceRow, []);
			sourceSlices.get(sourceRow)!.push({ segmentId: itemSegmentId(item), qty: Math.abs(Number(item['qty'] ?? 0)) });
		}
	}
	const returnedBySlice = new Map<string, number>();
	const orderedReturns = documents
		.filter((document) => document.isReturn)
		.sort((a, b) => {
			const aOrder = `${String(a.doc['posting_date'] ?? '')}:${String(a.doc['posting_time'] ?? '')}:${String(a.doc['creation'] ?? '')}:${a.name}`;
			const bOrder = `${String(b.doc['posting_date'] ?? '')}:${String(b.doc['posting_time'] ?? '')}:${String(b.doc['creation'] ?? '')}:${b.name}`;
			return aOrder.localeCompare(bOrder);
		});
	for (const document of orderedReturns) {
		const nextItems: Array<Record<string, unknown>> = [];
		for (const item of document.items) {
			const qty = Math.abs(Number(item['qty'] ?? 0));
			const sourceRow = String(item['dn_detail'] ?? '');
			const ownRow = String(item['name'] ?? '');
			const explicitSegment = String(item[REALIZATION_SEGMENT_FIELD] ?? '').trim();
			if (explicitSegment) {
				nextItems.push({ ...item, [REALIZATION_SEGMENT_FIELD]: explicitSegment, [LEGACY_SOURCE_ROW]: ownRow });
				if (sourceRow) {
					const key = sourceSegmentKey(sourceRow, explicitSegment);
					returnedBySlice.set(key, (returnedBySlice.get(key) ?? 0) + qty);
				}
				continue;
			}
			let left = qty;
			let part = 0;
			for (const source of sourceSlices.get(sourceRow) ?? []) {
				if (left <= 0.000001) break;
				const key = sourceSegmentKey(sourceRow, source.segmentId);
				const available = Math.max(0, source.qty - (returnedBySlice.get(key) ?? 0));
				if (available <= 0.000001) continue;
				const allocated = Math.min(left, available);
				nextItems.push({
					...item,
					qty: -allocated,
					[REALIZATION_SEGMENT_FIELD]: source.segmentId,
					[LEGACY_SOURCE_ROW]: ownRow,
					[KEEP_ITEM_IDENTITY]: part === 0,
				});
				returnedBySlice.set(key, (returnedBySlice.get(key) ?? 0) + allocated);
				left -= allocated;
				part += 1;
			}
			if (left > 0.000001 || part === 0) {
				const fallbackQty = left > 0.000001 ? left : qty;
				const fallbackSegment = sourceSlices.get(sourceRow)?.at(-1)?.segmentId ?? REALIZATION_BASE_SEGMENT;
				const previous = nextItems.at(-1);
				if (previous && itemSourceRow(previous) === ownRow && itemSegmentId(previous) === fallbackSegment) {
					previous['qty'] = Number(previous['qty'] ?? 0) - fallbackQty;
				} else {
					nextItems.push({
						...item,
						qty: -fallbackQty,
						[REALIZATION_SEGMENT_FIELD]: fallbackSegment,
						[LEGACY_SOURCE_ROW]: ownRow,
						[KEEP_ITEM_IDENTITY]: part === 0,
					});
				}
				if (sourceRow) {
					const key = sourceSegmentKey(sourceRow, fallbackSegment);
					returnedBySlice.set(key, (returnedBySlice.get(key) ?? 0) + fallbackQty);
				}
			}
		}
		document.items = nextItems;
	}
}

function hasChangedPrice(snapshot: DeliveryNoteSnapshot, prices: ReadonlyMap<string, number>): boolean {
	return snapshot.items.some((item) => {
		const next = prices.get(segmentPriceKey(Number(item['item_code']), itemSegmentId(item)));
		return next !== undefined && Math.abs(next - Number(item['rate'] ?? 0)) >= 0.005;
	});
}

async function createDeliveryNoteReplacement(
	erp: ErpClient,
	snapshot: DeliveryNoteSnapshot,
	prices: ReadonlyMap<string, number>,
	args: { amendedFrom?: string; returnAgainst?: string; sourceRows?: ReadonlyMap<string, string>; submit: boolean },
): Promise<{ name: string; rowNames: Map<string, string>; submitted: boolean }> {
	const created = await erp.create('Delivery Note', deliveryNoteCopy(snapshot, prices, args));
	const name = String(created['name'] ?? '');
	if (!name) throw new Error(`ядро не вернуло номер исправленной реализации ${snapshot.name}`);
	const createdItems = Array.isArray(created['items']) ? created['items'] as Array<Record<string, unknown>> : [];
	const rowNames = new Map<string, string>();
	snapshot.items.forEach((item, index) => {
		const oldName = itemSourceRow(item);
		const newName = String(createdItems[index]?.['name'] ?? '');
		if (oldName && newName) rowNames.set(sourceSegmentKey(oldName, itemSegmentId(item)), newName);
	});
	if (args.submit) {
		try {
			await erp.submit('Delivery Note', name);
		} catch (error) {
			await erp.delete('Delivery Note', name).catch(() => undefined);
			throw error;
		}
	}
	return { name, rowNames, submitted: args.submit };
}

/**
 * Синхронизирует итоговую цену позиции сделки с активными Delivery Note.
 * Черновики обновляются на месте. Проведённые документы исправляются штатным для ERPNext
 * cancel/amend: возвраты временно отменяются, реализация заменяется новой версией, затем
 * возвраты восстанавливаются уже со ссылкой на новую строку реализации.
 */
export async function syncDealRealizationPrices(
	erp: ErpClient,
	dealId: number,
	rawChanges: readonly RealizationPriceChange[],
): Promise<RealizationPriceSyncResult> {
	const prices = new Map(rawChanges
		.filter(({ productId, segmentId, rate }) =>
			Number.isInteger(productId) && productId > 0 && Boolean(segmentId.trim()) && Number.isFinite(rate) && rate >= 0)
		.map(({ productId, segmentId, rate }) => [segmentPriceKey(productId, segmentId.trim()), rate] as const));
	const result: RealizationPriceSyncResult = { draftsUpdated: 0, realizationsAmended: 0, returnsAmended: 0 };
	if (!prices.size) return result;

	await ensureErpSetup(erp);
	const documents = await activeDealDeliveryNotes(erp, dealId);
	await assignRealizationSegments(erp, dealId, documents);
	const changed = documents.filter((document) => hasChangedPrice(document, prices));
	if (!changed.length) return result;

	const affectedOriginalNames = new Set<string>();
	for (const document of changed) {
		if (!document.isReturn) {
			if (document.submitted) affectedOriginalNames.add(document.name);
		} else if (document.returnAgainst) {
			affectedOriginalNames.add(document.returnAgainst);
		}
	}
	const originals = documents.filter((document) =>
		!document.isReturn && document.submitted && affectedOriginalNames.has(document.name));
	if (affectedOriginalNames.size !== originals.length) {
		throw new Error('не удалось найти исходную проведённую реализацию для исправления цены');
	}
	const dependentReturns = documents.filter((document) =>
		document.isReturn && affectedOriginalNames.has(document.returnAgainst));
	const graphNames = new Set([...originals, ...dependentReturns].map((document) => document.name));
	const directDrafts = changed.filter((document) => !document.submitted && !graphNames.has(document.name));
	const updatedDirectDrafts: DeliveryNoteSnapshot[] = [];

	try {
		for (const draft of directDrafts) {
			await erp.update('Delivery Note', draft.name, {
				items: deliveryNoteCopy(draft, prices, { keepItemIdentity: true })['items'],
			});
			updatedDirectDrafts.push(draft);
			result.draftsUpdated += 1;
		}
	} catch (error) {
		const recoveryErrors: string[] = [];
		for (const draft of updatedDirectDrafts.reverse()) {
			try {
				await erp.update('Delivery Note', draft.name, {
					items: deliveryNoteCopy(draft, new Map(), { keepItemIdentity: true })['items'],
				});
			} catch (recoveryError) { recoveryErrors.push(String(recoveryError)); }
		}
		const originalMessage = error instanceof Error ? error.message : String(error);
		if (recoveryErrors.length) {
			throw new Error(`не удалось изменить цену черновика реализации: ${originalMessage}. Автовосстановление требует проверки: ${recoveryErrors.join('; ')}`);
		}
		throw new Error(`не удалось изменить цену черновика реализации: ${originalMessage}; исходные цены восстановлены`);
	}
	if (!originals.length) return result;

	const canceledOldReturns: DeliveryNoteSnapshot[] = [];
	const deletedDraftReturns: DeliveryNoteSnapshot[] = [];
	const canceledOldOriginals: DeliveryNoteSnapshot[] = [];
	const replacements = new Map<string, { name: string; rowNames: Map<string, string>; submitted: boolean }>();
	const returnReplacements = new Map<string, { name: string; submitted: boolean }>();

	try {
		for (const returned of dependentReturns) {
			if (returned.submitted) {
				await erp.cancel('Delivery Note', returned.name);
				canceledOldReturns.push(returned);
			} else {
				await erp.delete('Delivery Note', returned.name);
				deletedDraftReturns.push(returned);
			}
		}
		for (const original of originals) {
			await erp.cancel('Delivery Note', original.name);
			canceledOldOriginals.push(original);
		}
		for (const original of originals) {
			const replacement = await createDeliveryNoteReplacement(erp, original, prices, {
				amendedFrom: original.name,
				submit: true,
			});
			replacements.set(original.name, replacement);
			result.realizationsAmended += 1;
		}
		for (const returned of dependentReturns) {
			const original = replacements.get(returned.returnAgainst);
			if (!original) throw new Error(`не найдена новая версия реализации ${returned.returnAgainst}`);
			const replacement = await createDeliveryNoteReplacement(erp, returned, prices, {
				...(returned.submitted ? { amendedFrom: returned.name } : {}),
				returnAgainst: original.name,
				sourceRows: original.rowNames,
				submit: returned.submitted,
			});
			returnReplacements.set(returned.name, { name: replacement.name, submitted: replacement.submitted });
			if (returned.submitted) result.returnsAmended += 1;
			else result.draftsUpdated += 1;
		}
		return result;
	} catch (error) {
		const recoveryErrors: string[] = [];
		for (const replacement of [...returnReplacements.values()].reverse()) {
			try {
				if (replacement.submitted) await erp.cancel('Delivery Note', replacement.name);
				else await erp.delete('Delivery Note', replacement.name);
			} catch (recoveryError) { recoveryErrors.push(String(recoveryError)); }
		}
		for (const replacement of [...replacements.values()].reverse()) {
			try {
				if (replacement.submitted) await erp.cancel('Delivery Note', replacement.name);
				else await erp.delete('Delivery Note', replacement.name);
			} catch (recoveryError) { recoveryErrors.push(String(recoveryError)); }
		}

		const restoredOriginals = new Map<string, { name: string; rowNames: Map<string, string> }>();
		for (const original of canceledOldOriginals) {
			try {
				const replacement = replacements.get(original.name);
				const restored = await createDeliveryNoteReplacement(erp, original, new Map(), {
					amendedFrom: replacement?.name ?? original.name,
					submit: true,
				});
				restoredOriginals.set(original.name, { name: restored.name, rowNames: restored.rowNames });
			} catch (recoveryError) { recoveryErrors.push(String(recoveryError)); }
		}
		for (const returned of [...canceledOldReturns, ...deletedDraftReturns]) {
			try {
				const original = restoredOriginals.get(returned.returnAgainst);
				const replacement = returnReplacements.get(returned.name);
				await createDeliveryNoteReplacement(erp, returned, new Map(), {
					...(returned.submitted ? { amendedFrom: replacement?.name ?? returned.name } : {}),
					returnAgainst: original?.name ?? returned.returnAgainst,
					...(original ? { sourceRows: original.rowNames } : {}),
					submit: returned.submitted,
				});
			} catch (recoveryError) { recoveryErrors.push(String(recoveryError)); }
		}
		for (const draft of updatedDirectDrafts.reverse()) {
			try {
				await erp.update('Delivery Note', draft.name, {
					items: deliveryNoteCopy(draft, new Map(), { keepItemIdentity: true })['items'],
				});
			} catch (recoveryError) { recoveryErrors.push(String(recoveryError)); }
		}
		const originalMessage = error instanceof Error ? error.message : String(error);
		if (recoveryErrors.length) {
			throw new Error(`не удалось изменить цену реализации: ${originalMessage}. Автовосстановление требует проверки: ${recoveryErrors.join('; ')}`);
		}
		throw new Error(`не удалось изменить цену реализации: ${originalMessage}; исходные цены и складские движения восстановлены`);
	}
}

/** Черновик реализации (Delivery Note) с привязкой к сделке. Проведение — submitRealization. */
export async function createRealizationDraft(
	erp: ErpClient,
	args: { dealId: number; lines: RealizationLine[]; postingDate?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	if (!args.lines.length) throw new Error('пустая партия');
	for (const line of args.lines) {
		if (!line.isService && !line.storeTitle?.trim()) throw new Error(`для товара #${line.productId} не выбран склад реализации`);
		await ensureCoreItem(erp, { productId: line.productId, name: `#${line.productId}`, isService: Boolean(line.isService) });
	}
	const doc = await erp.create('Delivery Note', {
		company: ctx.company,
		customer: TECH_CUSTOMER,
		set_posting_time: 1,
		...(args.postingDate ? { posting_date: args.postingDate } : {}),
		[DEAL_FIELD]: String(args.dealId),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			[REALIZATION_SEGMENT_FIELD]: l.segmentId?.trim() || REALIZATION_BASE_SEGMENT,
			...(!l.isService && l.storeTitle ? { warehouse: erpWarehouse(ctx, l.storeTitle) } : {}),
			rate: l.rate,
			})),
	});
	// У нескладской позиции ERPNext может подставить default warehouse из карточки Item,
	// даже когда warehouse не передан. Для услуги очищаем его уже в созданной дочерней
	// строке: документ остаётся единым с товарами, но складских движений по услуге нет.
	const createdItems = Array.isArray(doc['items']) ? doc['items'] as Array<Record<string, unknown>> : [];
	for (const [index, line] of args.lines.entries()) {
		if (!line.isService) continue;
		const createdLine = createdItems[index];
		const rowName = String(createdLine?.['name'] ?? '');
		if (rowName && String(createdLine?.['warehouse'] ?? '')) {
			await erp.update('Delivery Note Item', rowName, { warehouse: '' });
		}
	}
	return { name: String(doc['name']) };
}

export async function submitRealization(erp: ErpClient, name: string): Promise<void> {
	await erp.submit('Delivery Note', name);
}


/**
 * Возврат ОТ КЛИЕНТА: Delivery Note с is_return — товар обратно на склад, сторно реализации.
 * Привязка `return_against` к оригинальной реализации сделки (по productId) → себестоимость берётся
 * по FIFO автоматически. qty отрицательное. Причина → b24_note. Один документ на каждую исходную
 * реализацию (return_against один на DN). Сразу проводится. Возвращает имена созданных возвратов.
 */
export async function createClientReturns(
	erp: ErpClient,
	args: { dealId: number; note?: string; lines: Array<{ productId: number; qty: number; storeTitle: string }> },
): Promise<{ names: string[]; returned: Array<{ productId: number; qty: number; segmentId: string }> }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	if (!args.lines.length) throw new Error('нет позиций возврата');
	await ensureNoteField(erp, 'Delivery Note');
	// Возврат привязываем не только к Delivery Note, но и к конкретной строке исходной
	// реализации. Иначе ERPNext подставляет текущую цену товара вместо цены продажи.
	const reals = (await listDealRealizations(erp, args.dealId)).filter((r) => r.submitted);
	type Source = {
		original: string;
		productId: number;
		remaining: number;
		rate: number;
		rowName: string;
		segmentId: string;
	};
	const sources: Source[] = reals
		.filter((document) => !document.isReturn)
		.sort((a, b) => `${a.postingDate}:${a.name}`.localeCompare(`${b.postingDate}:${b.name}`))
		.flatMap((document) => document.items
			.filter((item) => item.qty > 0)
			.map((item) => ({
				original: document.name,
				productId: item.productId,
				remaining: item.qty,
				rate: item.rate,
				rowName: item.rowName,
				segmentId: item.segmentId || REALIZATION_BASE_SEGMENT,
			})));
	// Уже оформленные возвраты уменьшают доступный остаток каждой исходной строки.
	for (const returned of reals.filter((document) => document.isReturn)) {
		for (const item of returned.items.filter((entry) => entry.qty < 0)) {
			let qty = Math.abs(item.qty);
			const candidates = sources.filter((source) =>
				source.productId === item.productId
				&& (!returned.returnAgainst || source.original === returned.returnAgainst)
				&& (!item.sourceRow || source.rowName === item.sourceRow));
			for (const source of candidates) {
				const used = Math.min(source.remaining, qty);
				source.remaining -= used;
				qty -= used;
				if (qty <= 0.000001) break;
			}
		}
	}
	type ReturnLine = { productId: number; qty: number; storeTitle: string; rate: number; sourceRow: string; segmentId: string };
	const byOrig = new Map<string, ReturnLine[]>();
	for (const line of args.lines) {
		let qty = line.qty;
		for (const source of sources.filter((candidate) => candidate.productId === line.productId && candidate.remaining > 0.000001)) {
			const part = Math.min(source.remaining, qty);
			if (!byOrig.has(source.original)) byOrig.set(source.original, []);
			byOrig.get(source.original)!.push({
				productId: line.productId,
				qty: part,
				storeTitle: line.storeTitle,
				rate: source.rate,
				sourceRow: source.rowName,
				segmentId: source.segmentId,
			});
			source.remaining -= part;
			qty -= part;
			if (qty <= 0.000001) break;
		}
		if (qty > 0.000001) throw new Error(`товар #${line.productId}: возврат превышает фактически реализованное количество`);
	}
	const names: string[] = [];
	for (const [orig, lines] of byOrig.entries()) {
		const doc = await erp.create('Delivery Note', {
			company: ctx.company,
			customer: TECH_CUSTOMER,
			is_return: 1,
			return_against: orig,
			set_posting_time: 1,
			[DEAL_FIELD]: String(args.dealId),
			...(args.note ? { [NOTE_FIELD]: args.note.slice(0, 200) } : {}),
			items: lines.map((l) => ({
				item_code: String(l.productId),
				qty: -Math.abs(l.qty),
				warehouse: erpWarehouse(ctx, l.storeTitle),
				dn_detail: l.sourceRow,
				[REALIZATION_SEGMENT_FIELD]: l.segmentId,
				rate: l.rate,
				price_list_rate: l.rate,
			})),
		});
		const name = String(doc['name']);
		await erp.submit('Delivery Note', name);
		names.push(name);
	}
	const returned = [...byOrig.values()]
		.flat()
		.map((line) => ({ productId: line.productId, qty: line.qty, segmentId: line.segmentId }));
	return { names, returned };
}

/** Все партии-реализации сделки — одним фильтром по b24_deal_id. */
export async function listDealRealizations(erp: ErpClient, dealId: number): Promise<ErpRealization[]> {
	const ctx = await erpContext(erp);
	const documents = (await activeDealDeliveryNotes(erp, dealId)).filter((document) =>
		document.items.some((item) => {
			const productId = Number(item['item_code']);
			return Number.isInteger(productId) && productId > 0;
		}));
	await assignRealizationSegments(erp, dealId, documents);
	const out: ErpRealization[] = [];
	for (const document of documents) {
		// Ремонтное оборудование живёт в ERPNext под строковыми кодами REPAIR-* и не является
		// коммерческой строкой сделки. Не пропускаем его в движок реализаций, где productId
		// по архитектуре всегда является положительным числом из каталога.
		const items = document.items.flatMap((it) => {
			const productId = Number(it['item_code']);
			if (!Number.isInteger(productId) || productId <= 0) return [];
			return [{
				productId,
				itemName: String(it['item_name'] ?? ''),
				qty: Number(it['qty'] ?? 0),
				storeTitle: b24StoreTitle(ctx, String(it['warehouse'] ?? '')),
				rate: Number(it['rate'] ?? 0),
				rowName: String(it['name'] ?? ''),
				sourceRow: String(it['dn_detail'] ?? ''),
				segmentId: String(it[REALIZATION_SEGMENT_FIELD] ?? ''),
			}];
		});
		if (!items.length) continue;
		out.push({
			name: document.name,
			dealId: String(document.doc[DEAL_FIELD] ?? ''),
			postingDate: String(document.doc['posting_date'] ?? ''),
			submitted: document.submitted,
			isReturn: document.isReturn,
			returnAgainst: document.returnAgainst,
			grandTotal: Number(document.doc['grand_total'] ?? 0),
			items,
		});
	}
	return out;
}
