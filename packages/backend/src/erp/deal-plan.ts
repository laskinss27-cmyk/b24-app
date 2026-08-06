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
import { CORE_ENGINEER_VISIT_SERVICE_ID, ensureCoreItem } from './stock-catalog.js';
import { erpContext } from './warehouse-context.js';

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
