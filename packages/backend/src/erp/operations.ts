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

const DEAL_FIELD = 'b24_deal_id';
/** Документы, которым нужно поле сделки. */
const DEAL_DOCTYPES = ['Delivery Note', 'Stock Entry', 'Purchase Receipt'] as const;
export const SUPPLY_REQUEST_FIELD = 'b24_supply_request';
export const SUPPLY_REQUEST_KEY_FIELD = 'b24_supply_request_key';
export const SUPPLY_PURCHASE_ORDER_FIELD = 'b24_purchase_order';
export const SUPPLY_PURCHASE_STAGE_FIELD = 'b24_supply_stage';
export const SUPPLY_PURCHASE_ORDERED_AT_FIELD = 'b24_ordered_at';
export const SUPPLY_PURCHASE_EXPECTED_AT_FIELD = 'b24_expected_at';
export const SUPPLY_PURCHASE_REQUEST_QTY_FIELD = 'b24_request_qty';
const TRANSFER_DOCUMENT_FIELD = 'b24_transfer_document';
const TRANSFER_PHASE_FIELD = 'b24_transfer_phase';
const TECH_CUSTOMER = 'Б24 Розница';
const TECH_SUPPLIER = 'Б24 Снабжение';
const ITEM_GROUP = 'Каталог Б24';
const CORE_ENGINEER_VISIT_SERVICE_ID = 9814001;

export interface ErpContext {
	company: string;
	abbr: string;
}

let ctxCache: ErpContext | null = null;
let setupDone = false;

/** Компания (не Demo) + аббревиатура. Кэш на процесс. */
export async function erpContext(erp: ErpClient): Promise<ErpContext> {
	if (ctxCache) return ctxCache;
	const companies = await erp.list('Company', ['name', 'abbr']);
	const real = companies.find((c) => !String(c['name']).includes('Demo')) ?? companies[0];
	if (!real) throw new Error('ERPNext: нет ни одной компании (setup wizard не пройден?)');
	ctxCache = { company: String(real['name']), abbr: String(real['abbr']) };
	return ctxCache;
}

/** Идемпотентная настройка: custom-поля b24_deal_id + технические контрагенты. Раз на процесс. */
export async function ensureErpSetup(erp: ErpClient): Promise<void> {
	if (setupDone) return;
	for (const dt of DEAL_DOCTYPES) {
		const cfName = `${dt}-${DEAL_FIELD}`;
		if (!(await erp.get('Custom Field', cfName))) {
			await erp.create('Custom Field', {
				dt, fieldname: DEAL_FIELD, label: 'B24 Deal', fieldtype: 'Data',
				insert_after: 'posting_time', in_standard_filter: 1, in_list_view: 1,
			});
		}
	}
	if (!(await erp.get('Customer', TECH_CUSTOMER))) {
		await erp.create('Customer', { customer_name: TECH_CUSTOMER, customer_type: 'Individual' });
	}
	if (!(await erp.get('Supplier', TECH_SUPPLIER))) {
		await erp.create('Supplier', { supplier_name: TECH_SUPPLIER, supplier_type: 'Company' });
	}
	setupDone = true;
}

/** Единица измерения по умолчанию (как в миграции каталога). */
const UOM = 'шт';

/** Завести товар в ЯДРЕ — зеркало нового продукта Б24 (code = productId). Идемпотентно: уже есть → ничего.
 *  Для «Создать товар» в форме прихода: продукт сперва создан в каталоге Б24 (получил productId), тут — Item ядра. */
export async function ensureCoreItem(erp: ErpClient, args: {
	productId: number;
	name: string;
	isService?: boolean;
	model?: string;
	article?: string;
	brand?: string;
	section?: string;
}): Promise<void> {
	const code = String(args.productId);
	const existing = await erp.get<Record<string, unknown>>('Item', code);
	if (existing) {
		const patch: Record<string, unknown> = {};
		const hasStructuredMeta = args.model !== undefined || args.article !== undefined || args.brand !== undefined || args.section !== undefined;
		if (args.isService && Number(existing['is_stock_item'] ?? 1) !== 0) patch['is_stock_item'] = 0;
		if (hasStructuredMeta && args.name && String(existing['item_name'] ?? '') !== args.name) patch['item_name'] = args.name.slice(0, 140);
		if (args.model !== undefined) patch['b24_model'] = args.model;
		if (args.article !== undefined) patch['b24_article'] = args.article;
		if (args.brand !== undefined) patch['b24_brand'] = args.brand;
		if (args.section !== undefined) patch['b24_section'] = args.section;
		if (Object.keys(patch).length) await erp.update('Item', code, patch);
		return;
	}
	if (!(await erp.get('UOM', UOM))) await erp.create('UOM', { uom_name: UOM });
	if (!(await erp.get('Item Group', ITEM_GROUP))) await erp.create('Item Group', { item_group_name: ITEM_GROUP, parent_item_group: 'All Item Groups', is_group: 0 });
	const isService = Boolean(args.isService) || args.productId === CORE_ENGINEER_VISIT_SERVICE_ID;
	await erp.create('Item', {
		item_code: code,
		item_name: args.name || `#${code}`,
		item_group: ITEM_GROUP,
		stock_uom: UOM,
		is_stock_item: isService ? 0 : 1,
		description: `Б24 productId=${args.productId}`,
		b24_model: args.model ?? '',
		b24_article: args.article ?? '',
		b24_brand: args.brand ?? '',
		b24_section: args.section ?? '',
	});
}

/** Найти/создать поставщика по имени (выбор из списка Б24-контрагентов / ввод нового в форме «Приход»). Возвращает имя в ядре. */
export async function ensureSupplier(erp: ErpClient, name: string): Promise<string> {
	const clean = name.trim();
	if (!clean) return TECH_SUPPLIER;
	const existing = await erp.get('Supplier', clean);
	if (existing) return String(existing['name']);
	const doc = await erp.create('Supplier', { supplier_name: clean, supplier_type: 'Company' });
	return String(doc['name']);
}

/** Имя склада ERPNext из названия склада Б24. */
export function erpWarehouse(ctx: ErpContext, b24StoreTitle: string): string {
	const suffix = ` - ${ctx.abbr}`;
	let title = b24StoreTitle.trim();
	while (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trimEnd();
	return `${title} - ${ctx.abbr}`;
}

/** Название склада Б24 из имени склада ERPNext (срез суффикса компании). */
export function b24StoreTitle(ctx: ErpContext, erpWarehouseName: string): string {
	const suffix = ` - ${ctx.abbr}`;
	return erpWarehouseName.endsWith(suffix) ? erpWarehouseName.slice(0, -suffix.length) : erpWarehouseName;
}

/** Остатки всего каталога: productId → { '<title склада Б24>': qty }. Один запрос (Bin). */
export async function fetchErpStocks(erp: ErpClient): Promise<Map<number, Record<string, number>>> {
	const ctx = await erpContext(erp);
	const bins = await erp.list('Bin', ['item_code', 'warehouse', 'actual_qty']);
	const out = new Map<number, Record<string, number>>();
	for (const b of bins) {
		const productId = Number(b['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) continue; // демо-SKU и чужое
		const store = b24StoreTitle(ctx, String(b['warehouse'] ?? ''));
		const qty = Number(b['actual_qty'] ?? 0);
		const e = out.get(productId) ?? {};
		e[store] = (e[store] ?? 0) + qty;
		out.set(productId, e);
	}
	return out;
}

/** Остатки ТОЛЬКО запрошенных товаров: productId → { '<title склада Б24>': qty }. Фильтр item_code in —
 *  мизерный ответ (vs весь Bin), критично через мост: полный каталог не лезет в 60с-бюджет контейнера. */
export async function fetchErpStocksFor(erp: ErpClient, productIds: number[]): Promise<Map<number, Record<string, number>>> {
	const ctx = await erpContext(erp);
	const out = new Map<number, Record<string, number>>();
	const ids = [...new Set(productIds.filter((n) => Number.isInteger(n) && n > 0))];
	for (let i = 0; i < ids.length; i += 200) {
		const chunk = ids.slice(i, i + 200).map(String);
		const bins = await erp.list('Bin', ['item_code', 'warehouse', 'actual_qty'], [['item_code', 'in', chunk]]);
		for (const b of bins) {
			const productId = Number(b['item_code']);
			if (!Number.isInteger(productId) || productId <= 0) continue;
			const store = b24StoreTitle(ctx, String(b['warehouse'] ?? ''));
			const qty = Number(b['actual_qty'] ?? 0);
			const e = out.get(productId) ?? {};
			e[store] = (e[store] ?? 0) + qty;
			out.set(productId, e);
		}
	}
	return out;
}

/** Закупочная (valuation_rate ядра) пачкой: productId → rate. Для витрины остатков. */
export async function fetchErpPurchasing(erp: ErpClient, productIds: number[]): Promise<Map<number, number>> {
	const out = new Map<number, number>();
	const ids = [...new Set(productIds.filter((n) => Number.isInteger(n) && n > 0))];
	for (let i = 0; i < ids.length; i += 200) {
		const chunk = ids.slice(i, i + 200).map(String);
		const prices = await erp.list('Item Price', ['item_code', 'price_list_rate'], [
			['item_code', 'in', chunk],
			['price_list', '=', 'Standard Buying'],
		]);
		for (const row of prices) out.set(Number(row['item_code']), Number(row['price_list_rate'] ?? 0));
		const rows = await erp.list('Item', ['name', 'valuation_rate'], [['name', 'in', chunk]]);
		for (const r of rows) {
			const productId = Number(r['name']);
			if (!out.has(productId)) out.set(productId, Number(r['valuation_rate'] ?? 0));
		}
	}
	return out;
}

/** Розничные цены каталога ядра для сделок и подборщиков. */
export async function fetchErpRetailPrices(erp: ErpClient, productIds: number[]): Promise<Map<number, number>> {
	const out = new Map<number, number>();
	const ids = [...new Set(productIds.filter((n) => Number.isInteger(n) && n > 0))];
	for (let i = 0; i < ids.length; i += 200) {
		const chunk = ids.slice(i, i + 200).map(String);
		const prices = await erp.list('Item Price', ['item_code', 'price_list_rate'], [
			['item_code', 'in', chunk],
			['price_list', '=', 'Standard Selling'],
		]);
		for (const row of prices) out.set(Number(row['item_code']), Number(row['price_list_rate'] ?? 0));
	}
	return out;
}

export interface CoreCatalogPrices {
	retail?: number;
	purchase?: number;
}

/** Справочные цены каталога ядра. Они не меняют складскую valuation_rate. */
export async function fetchCoreCatalogPrices(erp: ErpClient): Promise<Map<number, CoreCatalogPrices>> {
	const rows = await erp.list('Item Price', ['item_code', 'price_list', 'price_list_rate'], [
		['price_list', 'in', ['Standard Selling', 'Standard Buying']],
	]);
	const out = new Map<number, CoreCatalogPrices>();
	for (const row of rows) {
		const productId = Number(row['item_code']);
		if (!(productId > 0)) continue;
		const current = out.get(productId) ?? {};
		const rate = Number(row['price_list_rate'] ?? 0);
		if (row['price_list'] === 'Standard Selling') current.retail = rate;
		if (row['price_list'] === 'Standard Buying') current.purchase = rate;
		out.set(productId, current);
	}
	return out;
}

async function ensureCorePriceList(erp: ErpClient, name: string, kind: 'selling' | 'buying'): Promise<void> {
	if (await erp.get('Price List', name)) return;
	await erp.create('Price List', {
		price_list_name: name,
		currency: 'RUB',
		enabled: 1,
		selling: kind === 'selling' ? 1 : 0,
		buying: kind === 'buying' ? 1 : 0,
	});
}

async function upsertCoreItemPrice(erp: ErpClient, itemCode: string, priceList: string, rate: number): Promise<void> {
	const existing = await erp.list('Item Price', ['name'], [
		['item_code', '=', itemCode],
		['price_list', '=', priceList],
	], 1, 'modified desc');
	const name = String(existing[0]?.['name'] ?? '');
	if (name) {
		await erp.update('Item Price', name, { price_list_rate: rate, currency: 'RUB' });
		return;
	}
	await erp.create('Item Price', {
		item_code: itemCode,
		price_list: priceList,
		price_list_rate: rate,
		currency: 'RUB',
	});
}

/** Записать розничную и закупочную цены товара в штатные прайс-листы ERPNext. */
export async function updateCoreCatalogPrices(
	erp: ErpClient,
	args: { productId: number; retail?: number; purchase?: number },
): Promise<void> {
	const itemCode = String(args.productId);
	if (!(await erp.get('Item', itemCode))) throw new Error(`товар #${args.productId} не найден в ядре`);
	if (args.retail !== undefined) {
		await ensureCorePriceList(erp, 'Standard Selling', 'selling');
		await upsertCoreItemPrice(erp, itemCode, 'Standard Selling', args.retail);
	}
	if (args.purchase !== undefined) {
		await ensureCorePriceList(erp, 'Standard Buying', 'buying');
		await upsertCoreItemPrice(erp, itemCode, 'Standard Buying', args.purchase);
	}
}

export interface RealizationLine {
	productId: number;
	qty: number;
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
	items: Array<{ productId: number; itemName: string; qty: number; storeTitle: string; rate: number; rowName: string; sourceRow: string }>;
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
): Promise<{ names: string[] }> {
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
	type ReturnLine = { productId: number; qty: number; storeTitle: string; rate: number; sourceRow: string };
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
				rate: l.rate,
				price_list_rate: l.rate,
			})),
		});
		const name = String(doc['name']);
		await erp.submit('Delivery Note', name);
		names.push(name);
	}
	return { names };
}

/** Все партии-реализации сделки — одним фильтром по b24_deal_id. */
export async function listDealRealizations(erp: ErpClient, dealId: number): Promise<ErpRealization[]> {
	const ctx = await erpContext(erp);
	const heads = await erp.list('Delivery Note',
		['name', DEAL_FIELD, 'posting_date', 'docstatus', 'grand_total', 'is_return', 'return_against'],
		[[DEAL_FIELD, '=', String(dealId)], ['docstatus', '!=', 2]]);
	const out: ErpRealization[] = [];
	for (const h of heads) {
		const full = await erp.get('Delivery Note', String(h['name']));
		const items = ((full?.['items'] as Array<Record<string, unknown>>) ?? []).map((it) => ({
			productId: Number(it['item_code']),
			itemName: String(it['item_name'] ?? ''),
			qty: Number(it['qty'] ?? 0),
			storeTitle: b24StoreTitle(ctx, String(it['warehouse'] ?? '')),
			rate: Number(it['rate'] ?? 0),
			rowName: String(it['name'] ?? ''),
			sourceRow: String(it['dn_detail'] ?? ''),
		}));
		out.push({
			name: String(h['name']),
			dealId: String(h[DEAL_FIELD] ?? ''),
			postingDate: String(h['posting_date'] ?? ''),
			submitted: Number(h['docstatus']) === 1,
			isReturn: Number(h['is_return'] ?? 0) === 1,
			returnAgainst: String(h['return_against'] ?? ''),
			grandTotal: Number(h['grand_total'] ?? 0),
			items,
		});
	}
	return out;
}

// ── ПЛАН СДЕЛКИ = черновик Sales Order с b24_deal_id ──────────────────────────────────────
// Что менеджер собрал в сделку (реальные товары) живёт ЗДЕСЬ, а не в Б24 (Б24 несёт свёрнутую
// услугу «Выезд инженера»). Реализация (Delivery Note) идёт против заказа; остаток к отгрузке
// ERPNext считает сам (delivered_qty/per_delivered). Источник правды о составе сделки.
let planFieldDone = false;
const DEAL_STAGES_FIELD = 'b24_deal_stages';
const DEAL_VARIANTS_FIELD = 'b24_quote_variants';
async function ensurePlanField(erp: ErpClient): Promise<void> {
	if (planFieldDone) return;
	const cfName = `Sales Order-${DEAL_FIELD}`;
	if (!(await erp.get('Custom Field', cfName))) {
		await erp.create('Custom Field', {
			dt: 'Sales Order', fieldname: DEAL_FIELD, label: 'B24 Deal', fieldtype: 'Data',
			insert_after: 'customer', in_standard_filter: 1, in_list_view: 1,
		});
	}
	const stagesName = `Sales Order-${DEAL_STAGES_FIELD}`;
	if (!(await erp.get('Custom Field', stagesName))) {
		await erp.create('Custom Field', {
			dt: 'Sales Order', fieldname: DEAL_STAGES_FIELD, label: 'B24 Deal Stages', fieldtype: 'Long Text',
			insert_after: DEAL_FIELD,
		});
	}
	const variantsName = `Sales Order-${DEAL_VARIANTS_FIELD}`;
	if (!(await erp.get('Custom Field', variantsName))) {
		await erp.create('Custom Field', {
			dt: 'Sales Order', fieldname: DEAL_VARIANTS_FIELD, label: 'B24 Quote Variants', fieldtype: 'Long Text',
			insert_after: DEAL_STAGES_FIELD,
		});
	}
	planFieldDone = true;
}

// priceListRate = базовая цена (до скидки), discountPercent = скидка %. rate (итог) ERPNext считает сам.
export interface PlanLine { productId: number; itemName?: string; qty: number; priceListRate: number; discountPercent: number; isService?: boolean }
export interface PlanItem { productId: number; itemName: string; qty: number; rate: number; priceListRate: number; discountPercent: number; delivered: number; isService: boolean }
export interface DealStageItem { productId: number; itemName: string; qty: number; price: number; discountPercent?: number; isService: boolean }
export interface DealStage { id: string; name?: string; at: string; byId: string; byName: string; items: DealStageItem[] }
export interface DealQuoteVariantItem extends PlanLine { itemName: string }
export interface DealQuoteVariant {
	id: string;
	name: string;
	createdAt: string;
	createdById: string;
	createdByName: string;
	items: DealQuoteVariantItem[];
}
export interface DealQuoteVariants {
	enabled: boolean;
	selectedId: string | null;
	variants: DealQuoteVariant[];
}

/** Черновик плана сделки (Sales Order docstatus 0 по b24_deal_id) — имя или null. */
async function findDealPlan(erp: ErpClient, dealId: number): Promise<string | null> {
	const rows = await erp.list('Sales Order', ['name'], [[DEAL_FIELD, '=', String(dealId)], ['docstatus', '=', 0]], 1, 'creation desc');
	return rows[0] ? String(rows[0]['name']) : null;
}

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
	// Скидку храним нативно: price_list_rate (база) + discount_percentage → rate ERPNext посчитает сам.
	const items = durableLines.map((l) => ({ item_code: String(l.productId), qty: l.qty, price_list_rate: l.priceListRate, discount_percentage: l.discountPercent, delivery_date: deliveryDate }));
	if (existing) {
		const doc = await erp.update('Sales Order', existing, { items, delivery_date: deliveryDate });
		return { name: String(doc['name'] ?? existing), lines: durableLines };
	}
	const doc = await erp.create('Sales Order', {
		company: ctx.company, customer: TECH_CUSTOMER, delivery_date: deliveryDate,
		[DEAL_FIELD]: String(dealId), items,
	});
	return { name: String(doc['name']), lines: durableLines };
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
	return items.map((it) => ({
		productId: Number(it['item_code']),
		itemName: String(it['item_name'] ?? ''),
		qty: Number(it['qty'] ?? 0),
		rate: Number(it['rate'] ?? 0),
		priceListRate: Number(it['price_list_rate'] ?? it['rate'] ?? 0),
		discountPercent: Number(it['discount_percentage'] ?? 0),
		delivered: Number(it['delivered_qty'] ?? 0),
		isService: Number(it['item_code']) === CORE_ENGINEER_VISIT_SERVICE_ID || serviceById.get(String(it['item_code'] ?? '')) === true,
	}));
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
}): Promise<DealQuoteVariants> {
	const plan = await dealPlanDocument(erp, dealId);
	if (!plan) throw new Error('сначала добавьте в сделку хотя бы одну позицию');
	const state = parseDealQuoteVariants(plan.doc[DEAL_VARIANTS_FIELD]);
	if (state.selectedId) throw new Error('вариант уже выбран клиентом; новые варианты недоступны');
	const cleanName = args.name.trim().slice(0, 80);
	if (!cleanName) throw new Error('укажите название варианта');
	if (state.variants.some((variant) => variant.name.toLocaleLowerCase('ru-RU') === cleanName.toLocaleLowerCase('ru-RU'))) throw new Error('вариант с таким названием уже есть');
	let items: DealQuoteVariantItem[];
	if (!state.enabled) {
		items = (await listDealPlan(erp, dealId)).map((item) => ({ productId: item.productId, itemName: item.itemName, qty: item.qty, priceListRate: item.priceListRate, discountPercent: item.discountPercent, isService: item.isService }));
	} else if (!args.sourceVariantId) {
		items = [];
	} else {
		const source = state.variants.find((variant) => variant.id === args.sourceVariantId);
		if (!source) throw new Error('вариант для копирования не найден');
		items = source.items.map((item) => ({ ...item }));
	}
	const variant: DealQuoteVariant = { id: randomUUID(), name: cleanName, createdAt: new Date().toISOString(), createdById: args.createdById, createdByName: args.createdByName, items };
	const next: DealQuoteVariants = { enabled: true, selectedId: null, variants: [...state.variants, variant] };
	await saveDealQuoteVariants(erp, plan.name, next);
	return next;
}

export async function renameDealQuoteVariant(erp: ErpClient, dealId: number, variantId: string, name: string): Promise<DealQuoteVariants> {
	const plan = await dealPlanDocument(erp, dealId);
	if (!plan) throw new Error('план сделки не найден');
	const state = parseDealQuoteVariants(plan.doc[DEAL_VARIANTS_FIELD]);
	if (state.selectedId) throw new Error('после выбора клиента названия вариантов зафиксированы');
	const cleanName = name.trim().slice(0, 80);
	if (!cleanName) throw new Error('укажите название варианта');
	if (!state.variants.some((variant) => variant.id === variantId)) throw new Error('вариант не найден');
	if (state.variants.some((variant) => variant.id !== variantId && variant.name.toLocaleLowerCase('ru-RU') === cleanName.toLocaleLowerCase('ru-RU'))) throw new Error('вариант с таким названием уже есть');
	const next = { ...state, variants: state.variants.map((variant) => variant.id === variantId ? { ...variant, name: cleanName } : variant) };
	await saveDealQuoteVariants(erp, plan.name, next);
	return next;
}

export async function deleteDealQuoteVariant(erp: ErpClient, dealId: number, variantId: string): Promise<DealQuoteVariants> {
	const plan = await dealPlanDocument(erp, dealId);
	if (!plan) throw new Error('план сделки не найден');
	const state = parseDealQuoteVariants(plan.doc[DEAL_VARIANTS_FIELD]);
	if (state.selectedId) throw new Error('после выбора клиента варианты зафиксированы');
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
	if (state.selectedId) throw new Error('выбранный вариант изменяется через рабочий состав и этапы');
	if (!state.variants.some((variant) => variant.id === variantId)) throw new Error('вариант не найден');
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
	await upsertDealPlan(erp, dealId, selected.items, deliveryDate);
	const next = { ...state, selectedId: selected.id };
	await saveDealQuoteVariants(erp, plan.name, next);
	return next;
}

export async function assertDealQuoteVariantSelected(erp: ErpClient, dealId: number): Promise<void> {
	const state = await listDealQuoteVariants(erp, dealId);
	if (state.enabled && !state.selectedId) throw new Error('сначала отметьте вариант КП, выбранный клиентом');
}

function parseDealStages(raw: unknown): DealStage[] {
	if (typeof raw !== 'string' || !raw.trim()) return [];
	try {
		const value = JSON.parse(raw) as unknown;
		if (!Array.isArray(value)) return [];
		return value.filter((stage): stage is DealStage => Boolean(stage && typeof stage === 'object' && Array.isArray((stage as DealStage).items)));
	} catch {
		return [];
	}
}

export async function listDealStages(erp: ErpClient, dealId: number): Promise<DealStage[]> {
	await ensurePlanField(erp);
	const name = await findDealPlan(erp, dealId);
	if (!name) return [];
	const plan = await erp.get<Record<string, unknown>>('Sales Order', name);
	return parseDealStages(plan?.[DEAL_STAGES_FIELD]);
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
	planItem['price_list_rate'] = price;
	planItem['discount_percentage'] = discountPercent;

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
			...(l.note ? { description: l.note } : {}),
		})),
	});
	return { name: String(doc['name']) };
}

export interface SupplyReqItem { productId: number; itemName: string; qty: number; note: string; stocks: Record<string, number> }
export interface SupplyRequest { name: string; requestKey: string; createdAt: string; dealId: string; date: string; deadline: string; status: string; toStore: string; note: string; items: SupplyReqItem[] }
export interface SupplyRequestSummary { name: string; requestKey: string; createdAt: string; dealId: string; date: string; deadline: string; status: string; toStore: string; note: string; productIds: number[] }

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
			productIds: ((mr?.['items'] as Array<Record<string, unknown>>) ?? []).map((it) => Number(it['item_code'] ?? 0)).filter((id) => Number.isInteger(id) && id > 0),
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

let purchaseFieldDone = false;
async function ensurePurchaseFields(erp: ErpClient): Promise<void> {
	if (purchaseFieldDone) return;
	await ensureErpSetup(erp);
	for (const dt of ['Purchase Order', 'Purchase Receipt']) {
		const dealField = `${dt}-${DEAL_FIELD}`;
		if (!(await erp.get('Custom Field', dealField))) {
			await erp.create('Custom Field', {
				dt, fieldname: DEAL_FIELD, label: 'B24 Deal', fieldtype: 'Data',
				insert_after: 'supplier', in_standard_filter: 1, in_list_view: 1,
			});
		}
		const requestField = `${dt}-${SUPPLY_REQUEST_FIELD}`;
		if (!(await erp.get('Custom Field', requestField))) {
			await erp.create('Custom Field', {
				dt, fieldname: SUPPLY_REQUEST_FIELD, label: 'B24 Supply Request', fieldtype: 'Data',
				insert_after: DEAL_FIELD, in_standard_filter: 1,
			});
		}
		const requestKeyField = `${dt}-${SUPPLY_REQUEST_KEY_FIELD}`;
		if (!(await erp.get('Custom Field', requestKeyField))) {
			await erp.create('Custom Field', {
				dt, fieldname: SUPPLY_REQUEST_KEY_FIELD, label: 'B24 Supply Request Key', fieldtype: 'Data',
				insert_after: SUPPLY_REQUEST_FIELD, in_standard_filter: 1,
			});
		}
		if (dt === 'Purchase Receipt') {
			const purchaseOrderField = `${dt}-${SUPPLY_PURCHASE_ORDER_FIELD}`;
			if (!(await erp.get('Custom Field', purchaseOrderField))) {
				await erp.create('Custom Field', {
					dt, fieldname: SUPPLY_PURCHASE_ORDER_FIELD, label: 'B24 Purchase Order', fieldtype: 'Data',
					insert_after: SUPPLY_REQUEST_KEY_FIELD, in_standard_filter: 1,
				});
			}
		}
	}
	if (!(await erp.get('Custom Field', `Purchase Order-${SUPPLY_PURCHASE_STAGE_FIELD}`))) {
		await erp.create('Custom Field', {
			dt: 'Purchase Order',
			fieldname: SUPPLY_PURCHASE_STAGE_FIELD,
			label: 'B24 Supply Stage',
			fieldtype: 'Select',
			options: 'draft\napproval\napproved\nordered\ncancelled',
			default: 'draft',
			insert_after: SUPPLY_REQUEST_FIELD,
			in_standard_filter: 1,
			in_list_view: 1,
		});
	}
	if (!(await erp.get('Custom Field', `Purchase Order-${SUPPLY_PURCHASE_ORDERED_AT_FIELD}`))) {
		await erp.create('Custom Field', {
			dt: 'Purchase Order',
			fieldname: SUPPLY_PURCHASE_ORDERED_AT_FIELD,
			label: 'B24 Ordered At',
			fieldtype: 'Date',
			insert_after: SUPPLY_PURCHASE_STAGE_FIELD,
			in_standard_filter: 1,
		});
	}
	if (!(await erp.get('Custom Field', `Purchase Order-${SUPPLY_PURCHASE_EXPECTED_AT_FIELD}`))) {
		await erp.create('Custom Field', {
			dt: 'Purchase Order',
			fieldname: SUPPLY_PURCHASE_EXPECTED_AT_FIELD,
			label: 'B24 Expected At',
			fieldtype: 'Date',
			insert_after: SUPPLY_PURCHASE_ORDERED_AT_FIELD,
			in_standard_filter: 1,
		});
	}
	if (!(await erp.get('Custom Field', `Purchase Order Item-${SUPPLY_PURCHASE_REQUEST_QTY_FIELD}`))) {
		await erp.create('Custom Field', {
			dt: 'Purchase Order Item',
			fieldname: SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
			label: 'B24 Request Qty',
			fieldtype: 'Float',
			insert_after: 'qty',
			read_only: 1,
		});
	}
	purchaseFieldDone = true;
}

let supplyTransferFieldDone = false;
async function ensureSupplyTransferFields(erp: ErpClient): Promise<void> {
	if (supplyTransferFieldDone) return;
	await ensureErpSetup(erp);
	for (const [fieldname, label, insertAfter] of [
		[SUPPLY_REQUEST_FIELD, 'B24 Supply Request', DEAL_FIELD],
		[SUPPLY_REQUEST_KEY_FIELD, 'B24 Supply Request Key', SUPPLY_REQUEST_FIELD],
		[SUPPLY_PURCHASE_ORDER_FIELD, 'B24 Purchase Order', SUPPLY_REQUEST_KEY_FIELD],
		[TRANSFER_DOCUMENT_FIELD, 'B24 Transfer Document', SUPPLY_PURCHASE_ORDER_FIELD],
		[TRANSFER_PHASE_FIELD, 'B24 Transfer Phase', TRANSFER_DOCUMENT_FIELD],
	] as const) {
		const name = `Stock Entry-${fieldname}`;
		if (!(await erp.get('Custom Field', name))) {
			await erp.create('Custom Field', {
				dt: 'Stock Entry', fieldname, label, fieldtype: 'Data', insert_after: insertAfter, in_standard_filter: 1,
			});
		}
	}
	supplyTransferFieldDone = true;
}

async function existingTransferOperation(erp: ErpClient, transferId: number | undefined, phase: string): Promise<{ name: string; docstatus: number } | null> {
	if (!transferId) return null;
	const rows = await erp.list<Record<string, unknown>>(
		'Stock Entry',
		['name', 'docstatus'],
		[[TRANSFER_DOCUMENT_FIELD, '=', String(transferId)], [TRANSFER_PHASE_FIELD, '=', phase], ['docstatus', '!=', 2]],
		1,
		'creation desc',
	);
	const row = rows[0];
	return row ? { name: String(row['name']), docstatus: Number(row['docstatus'] ?? 0) } : null;
}

async function finishExistingTransferOperation(erp: ErpClient, existing: { name: string; docstatus: number } | null): Promise<{ name: string } | null> {
	if (!existing) return null;
	if (existing.docstatus === 0) await erp.submit('Stock Entry', existing.name);
	return { name: existing.name };
}

export interface PurchaseDraftLine { productId: number; itemName?: string; qty: number; rate?: number; requestQty?: number }

/** Черновик закупки по заявке снабжения. Не проводим: снабжение дальше выбирает поставщика/цены штатно. */
export async function createPurchaseOrderDraft(
	erp: ErpClient,
	args: { dealId?: number; supplyRequest?: string; supplyRequestKey?: string; scheduleDate: string; lines: PurchaseDraftLine[]; supplier?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensurePurchaseFields(erp);
	if (!args.lines.length) throw new Error('пустая закупка');
	for (const l of args.lines) await ensureCoreItem(erp, { productId: l.productId, name: l.itemName ?? `#${l.productId}` });
	const supplier = args.supplier ? await ensureSupplier(erp, args.supplier) : TECH_SUPPLIER;
	const rates = await fetchErpPurchasing(erp, args.lines.map((l) => l.productId));
	const doc = await erp.create('Purchase Order', {
		company: ctx.company,
		supplier,
		schedule_date: args.scheduleDate,
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		...(args.supplyRequest ? { [SUPPLY_REQUEST_FIELD]: args.supplyRequest } : {}),
		...(args.supplyRequestKey ? { [SUPPLY_REQUEST_KEY_FIELD]: args.supplyRequestKey } : {}),
		[SUPPLY_PURCHASE_STAGE_FIELD]: 'draft',
		[SUPPLY_PURCHASE_EXPECTED_AT_FIELD]: args.scheduleDate,
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			[SUPPLY_PURCHASE_REQUEST_QTY_FIELD]: Math.max(l.requestQty ?? l.qty, 0),
			schedule_date: args.scheduleDate,
			rate: Math.max(l.rate ?? rates.get(l.productId) ?? 0, 0.01),
		})),
	});
	return { name: String(doc['name']) };
}

export async function updatePurchaseOrderDraft(
	erp: ErpClient,
	args: { purchaseOrder: string; supplier?: string; lines: PurchaseDraftLine[] },
): Promise<{ name: string }> {
	await ensurePurchaseFields(erp);
	const current = await erp.get<Record<string, unknown>>('Purchase Order', args.purchaseOrder);
	if (!current) throw new Error('закупка не найдена');
	if (Number(current['docstatus'] ?? 0) !== 0) throw new Error('можно редактировать только черновик закупки');
	if (!args.lines.length) throw new Error('пустая закупка');
	const scheduleDate = String(current['schedule_date'] ?? new Date().toISOString().slice(0, 10));
	const requestQtyByProduct = new Map<number, number[]>();
	for (const raw of Array.isArray(current['items']) ? current['items'] as Array<Record<string, unknown>> : []) {
		const productId = Number(raw['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		const stored = raw[SUPPLY_PURCHASE_REQUEST_QTY_FIELD];
		const requestQty = Number(stored) > 0 ? Number(stored) : Number(raw['qty'] ?? 0);
		requestQtyByProduct.set(productId, [...(requestQtyByProduct.get(productId) ?? []), Math.max(requestQty, 0)]);
	}
	for (const l of args.lines) await ensureCoreItem(erp, { productId: l.productId, name: l.itemName ?? `#${l.productId}` });
	const rates = await fetchErpPurchasing(erp, args.lines.map((l) => l.productId));
	const patch: Record<string, unknown> = {
		items: args.lines.map((l) => {
			const existing = requestQtyByProduct.get(l.productId)?.shift();
			return {
				item_code: String(l.productId),
				qty: l.qty,
				[SUPPLY_PURCHASE_REQUEST_QTY_FIELD]: Math.max(l.requestQty ?? existing ?? 0, 0),
				schedule_date: scheduleDate,
				rate: Math.max(l.rate ?? rates.get(l.productId) ?? 0, 0.01),
			};
		}),
	};
	if (args.supplier) patch['supplier'] = await ensureSupplier(erp, args.supplier);
	const doc = await erp.update('Purchase Order', args.purchaseOrder, patch);
	return { name: String(doc['name'] ?? args.purchaseOrder) };
}

export type SupplyPurchaseStage = 'draft' | 'approval' | 'approved' | 'ordered' | 'cancelled';

export async function updateSupplyPurchaseStage(
	erp: ErpClient,
	args: { purchaseOrder: string; stage: SupplyPurchaseStage; expectedAt?: string },
): Promise<{ name: string }> {
	await ensurePurchaseFields(erp);
	const patch: Record<string, unknown> = { [SUPPLY_PURCHASE_STAGE_FIELD]: args.stage };
	if (args.stage === 'ordered') patch[SUPPLY_PURCHASE_ORDERED_AT_FIELD] = new Date().toISOString().slice(0, 10);
	if (args.expectedAt) patch[SUPPLY_PURCHASE_EXPECTED_AT_FIELD] = args.expectedAt;
	const doc = await erp.update('Purchase Order', args.purchaseOrder, patch);
	return { name: String(doc['name'] ?? args.purchaseOrder) };
}

export async function createSupplyPurchaseReceipt(
	erp: ErpClient,
	args: { dealId?: number; supplyRequest: string; supplyRequestKey?: string; purchaseOrder: string; toStore: string; lines: Array<{ productId: number; qty: number; rate: number }> },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensurePurchaseFields(erp);
	const order = await erp.get<Record<string, unknown>>('Purchase Order', args.purchaseOrder);
	if (!order) throw new Error('заказ поставщику не найден');
	if (args.dealId && String(order[DEAL_FIELD] ?? '') !== String(args.dealId)) throw new Error('заказ поставщику не относится к этой сделке');
	if (!args.dealId && String(order[DEAL_FIELD] ?? '')) throw new Error('заказ поставщику относится к сделке');
	if (String(order[SUPPLY_REQUEST_FIELD] ?? '') !== args.supplyRequest) throw new Error('заказ поставщику не относится к этой заявке');
	const orderRequestKey = String(order[SUPPLY_REQUEST_KEY_FIELD] ?? '');
	if (orderRequestKey && orderRequestKey !== String(args.supplyRequestKey ?? '')) throw new Error('заказ поставщику относится к другой версии заявки');
	if (String(order[SUPPLY_PURCHASE_STAGE_FIELD] ?? '') !== 'ordered') throw new Error('оприходовать можно только заказ со статусом «Заказано»');
	const orderedByProduct = new Map<number, number>();
	const rateByProduct = new Map<number, number>();
	for (const line of (Array.isArray(order['items']) ? order['items'] as Array<Record<string, unknown>> : [])) {
		const productId = Number(line['item_code']);
		if (Number.isInteger(productId) && productId > 0) {
			orderedByProduct.set(productId, (orderedByProduct.get(productId) ?? 0) + Number(line['qty'] ?? 0));
			rateByProduct.set(productId, Number(line['rate'] ?? 0));
		}
	}
	const receivedByProduct = new Map<number, number>();
	const receiptHeaders = await erp.list<Record<string, unknown>>('Purchase Receipt', ['name'], [[SUPPLY_PURCHASE_ORDER_FIELD, '=', args.purchaseOrder], ['docstatus', '!=', 2]]);
	for (const header of receiptHeaders) {
		const receipt = await erp.get<Record<string, unknown>>('Purchase Receipt', String(header['name'] ?? ''));
		for (const line of (Array.isArray(receipt?.['items']) ? receipt['items'] as Array<Record<string, unknown>> : [])) {
			const productId = Number(line['item_code']);
			if (Number.isInteger(productId) && productId > 0) receivedByProduct.set(productId, (receivedByProduct.get(productId) ?? 0) + Number(line['qty'] ?? 0));
		}
	}
	const incomingByProduct = new Map<number, number>();
	for (const line of args.lines) incomingByProduct.set(line.productId, (incomingByProduct.get(line.productId) ?? 0) + line.qty);
	for (const [productId, incoming] of incomingByProduct.entries()) {
		const remaining = Math.max((orderedByProduct.get(productId) ?? 0) - (receivedByProduct.get(productId) ?? 0), 0);
		if (incoming > remaining + 0.000001) throw new Error(`нельзя оприходовать товар #${productId}: осталось ${remaining}, указано ${incoming}`);
	}
	for (const l of args.lines) await ensureCoreItem(erp, { productId: l.productId, name: `#${l.productId}` });
	const doc = await erp.create('Purchase Receipt', {
		company: ctx.company,
		supplier: String(order['supplier'] ?? '') || TECH_SUPPLIER,
		set_posting_time: 1,
		remarks: `Supply purchase order ${args.purchaseOrder}`,
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		[SUPPLY_REQUEST_FIELD]: args.supplyRequest,
		...(args.supplyRequestKey ? { [SUPPLY_REQUEST_KEY_FIELD]: args.supplyRequestKey } : {}),
		[SUPPLY_PURCHASE_ORDER_FIELD]: args.purchaseOrder,
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			warehouse: erpWarehouse(ctx, args.toStore),
			rate: Math.max(rateByProduct.get(l.productId) ?? l.rate, 0.01),
		})),
	});
	const name = String(doc['name']);
	try {
		await erp.submit('Purchase Receipt', name);
	} catch (err) {
		await erp.delete('Purchase Receipt', name).catch(() => undefined);
		throw err;
	}
	return { name };
}

/** Перемещение между складами (Stock Entry: Material Transfer). Возвращает имя черновика. */
export async function createTransferDraft(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; fromStore: string; toStore: string }>; dealId?: number },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Transfer',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, l.fromStore),
			t_warehouse: erpWarehouse(ctx, l.toStore),
		})),
	});
	return { name: String(doc['name']) };
}

/** Транзитный склад «товар в пути» (warehouse_type=Transit в ядре) — для честного двухфазного перемещения. */
const TRANSIT_STORE = 'Goods In Transit';

/**
 * «Отгрузил» (закупка): Material Transfer со склада-источника НА транзит — создаёт и СРАЗУ проводит.
 * Товар уходит с А и повисает «в пути» (из учёта не пропадает). Возвращает имя проведённого Stock Entry.
 */
export async function shipTransferToTransit(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; fromStore: string }>; transferId?: number; dealId?: number; supplyRequest?: string; supplyRequestKey?: string; purchaseOrder?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureSupplyTransferFields(erp);
	if (!args.lines.length) throw new Error('пустая отгрузка');
	const recovered = await finishExistingTransferOperation(erp, await existingTransferOperation(erp, args.transferId, 'ship'));
	if (recovered) return recovered;
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Transfer',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		...(args.supplyRequest ? { [SUPPLY_REQUEST_FIELD]: args.supplyRequest } : {}),
		...(args.supplyRequestKey ? { [SUPPLY_REQUEST_KEY_FIELD]: args.supplyRequestKey } : {}),
		...(args.purchaseOrder ? { [SUPPLY_PURCHASE_ORDER_FIELD]: args.purchaseOrder } : {}),
		...(args.transferId ? { [TRANSFER_DOCUMENT_FIELD]: String(args.transferId), [TRANSFER_PHASE_FIELD]: 'ship' } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, l.fromStore),
			t_warehouse: erpWarehouse(ctx, TRANSIT_STORE),
		})),
	});
	const name = String(doc['name']);
	try {
		await erp.submit('Stock Entry', name);
	} catch (err) {
		await erp.delete('Stock Entry', name).catch(() => undefined);
		throw err;
	}
	return { name };
}

/**
 * «Получил» (закупка): Material Transfer С транзита на склад-получатель — создаёт и СРАЗУ проводит.
 * Товар приземляется на Б. Возвращает имя проведённого Stock Entry.
 */
export async function receiveTransferFromTransit(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; toStore: string }>; transferId?: number; dealId?: number; supplyRequest?: string; supplyRequestKey?: string; purchaseOrder?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureSupplyTransferFields(erp);
	if (!args.lines.length) throw new Error('пустая приёмка');
	const recovered = await finishExistingTransferOperation(erp, await existingTransferOperation(erp, args.transferId, 'legacy_receive'));
	if (recovered) return recovered;
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Transfer',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		...(args.supplyRequest ? { [SUPPLY_REQUEST_FIELD]: args.supplyRequest } : {}),
		...(args.supplyRequestKey ? { [SUPPLY_REQUEST_KEY_FIELD]: args.supplyRequestKey } : {}),
		...(args.purchaseOrder ? { [SUPPLY_PURCHASE_ORDER_FIELD]: args.purchaseOrder } : {}),
		...(args.transferId ? { [TRANSFER_DOCUMENT_FIELD]: String(args.transferId), [TRANSFER_PHASE_FIELD]: 'legacy_receive' } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, TRANSIT_STORE),
			t_warehouse: erpWarehouse(ctx, l.toStore),
		})),
	});
	const name = String(doc['name']);
	try {
		await erp.submit('Stock Entry', name);
	} catch (err) {
		await erp.delete('Stock Entry', name).catch(() => undefined);
		throw err;
	}
	return { name };
}

/** План финальной приемки и отдельных корректировочных движений. */
export function planTransferCompletion(
	shippedLines: Array<{ productId: number; qty: number }>,
	finalLines: Array<{ productId: number; qty: number }>,
): Array<{ productId: number; qty: number; route: 'deliver' | 'return' | 'extra' }> {
	const shipped = new Map<number, number>();
	const final = new Map<number, number>();
	for (const line of shippedLines) shipped.set(line.productId, (shipped.get(line.productId) ?? 0) + Math.max(Number(line.qty) || 0, 0));
	for (const line of finalLines) final.set(line.productId, (final.get(line.productId) ?? 0) + Math.max(Number(line.qty) || 0, 0));
	const result: Array<{ productId: number; qty: number; route: 'deliver' | 'return' | 'extra' }> = [];
	for (const productId of new Set([...shipped.keys(), ...final.keys()])) {
		const sent = shipped.get(productId) ?? 0;
		const done = final.get(productId) ?? 0;
		const delivered = Math.min(sent, done);
		const returned = Math.max(sent - done, 0);
		const extra = Math.max(done - sent, 0);
		if (delivered > 0) result.push({ productId, qty: delivered, route: 'deliver' });
		if (returned > 0) result.push({ productId, qty: returned, route: 'return' });
		if (extra > 0) result.push({ productId, qty: extra, route: 'extra' });
	}
	return result;
}

export async function completeTransferFromTransit(
	erp: ErpClient,
	args: {
		shippedLines: Array<{ productId: number; qty: number }>;
		finalLines: Array<{ productId: number; qty: number }>;
		fromStore: string;
		toStore: string;
		dealId?: number;
		supplyRequest?: string;
		supplyRequestKey?: string;
		purchaseOrder?: string;
		transferId?: number;
	},
): Promise<{
	receiveEntry: string | null;
	corrections: Array<{
		kind: 'shortage_return' | 'overage_transfer';
		name: string;
		lines: Array<{ productId: number; qty: number }>;
	}>;
}> {
	const ctx = await erpContext(erp);
	await ensureSupplyTransferFields(erp);
	const legs = planTransferCompletion(args.shippedLines, args.finalLines);
	if (!legs.length) throw new Error('в перемещении нет количества для проведения');

	const runPhase = async (
		phase: 'receive' | 'correction_return' | 'correction_extra',
		items: Array<{ item_code: string; qty: number; s_warehouse: string; t_warehouse: string }>,
	): Promise<string | null> => {
		if (!items.length) return null;
		const recovered = await finishExistingTransferOperation(erp, await existingTransferOperation(erp, args.transferId, phase));
		if (recovered) return recovered.name;
		const doc = await erp.create('Stock Entry', {
			company: ctx.company,
			stock_entry_type: 'Material Transfer',
			...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
			...(args.supplyRequest ? { [SUPPLY_REQUEST_FIELD]: args.supplyRequest } : {}),
			...(args.supplyRequestKey ? { [SUPPLY_REQUEST_KEY_FIELD]: args.supplyRequestKey } : {}),
			...(args.purchaseOrder ? { [SUPPLY_PURCHASE_ORDER_FIELD]: args.purchaseOrder } : {}),
			...(args.transferId ? { [TRANSFER_DOCUMENT_FIELD]: String(args.transferId), [TRANSFER_PHASE_FIELD]: phase } : {}),
			items,
		});
		const name = String(doc['name']);
		try {
			await erp.submit('Stock Entry', name);
		} catch (err) {
			await erp.delete('Stock Entry', name).catch(() => undefined);
			throw err;
		}
		return name;
	};

	const itemsFor = (route: 'deliver' | 'return' | 'extra') => legs
		.filter((leg) => leg.route === route)
		.map((leg) => ({
			item_code: String(leg.productId),
			qty: leg.qty,
			s_warehouse: erpWarehouse(ctx, route === 'extra' ? args.fromStore : TRANSIT_STORE),
			t_warehouse: erpWarehouse(ctx, route === 'return' ? args.fromStore : args.toStore),
		}));
	const receiveEntry = await runPhase('receive', itemsFor('deliver'));
	const corrections: Array<{ kind: 'shortage_return' | 'overage_transfer'; name: string; lines: Array<{ productId: number; qty: number }> }> = [];
	const returnEntry = await runPhase('correction_return', itemsFor('return'));
	if (returnEntry) corrections.push({
		kind: 'shortage_return',
		name: returnEntry,
		lines: legs.filter((leg) => leg.route === 'return').map(({ productId, qty }) => ({ productId, qty })),
	});
	const extraEntry = await runPhase('correction_extra', itemsFor('extra'));
	if (extraEntry) corrections.push({
		kind: 'overage_transfer',
		name: extraEntry,
		lines: legs.filter((leg) => leg.route === 'extra').map(({ productId, qty }) => ({ productId, qty })),
	});
	return { receiveEntry, corrections };
}

/** Причина списания — custom-поле на Stock Entry (показываем в журнале). */
const WRITEOFF_REASON_FIELD = 'b24_reason';
let writeoffFieldDone = false;
async function ensureWriteoffField(erp: ErpClient): Promise<void> {
	if (writeoffFieldDone) return;
	const cfName = `Stock Entry-${WRITEOFF_REASON_FIELD}`;
	if (!(await erp.get('Custom Field', cfName))) {
		await erp.create('Custom Field', {
			dt: 'Stock Entry', fieldname: WRITEOFF_REASON_FIELD, label: 'B24 Reason',
			fieldtype: 'Data', insert_after: 'stock_entry_type', in_standard_filter: 1, in_list_view: 1,
		});
	}
	writeoffFieldDone = true;
}

/** Примечание (необязательное) — общее custom-поле b24_note на складских документах. */
const NOTE_FIELD = 'b24_note';
const noteFieldDone = new Set<string>();
async function ensureNoteField(erp: ErpClient, doctype: string): Promise<void> {
	if (noteFieldDone.has(doctype)) return;
	const cfName = `${doctype}-${NOTE_FIELD}`;
	if (!(await erp.get('Custom Field', cfName))) {
		await erp.create('Custom Field', {
			dt: doctype, fieldname: NOTE_FIELD, label: 'B24 Note',
			fieldtype: doctype === 'Material Request' ? 'Small Text' : 'Data', insert_after: 'company', in_list_view: 1,
		});
	}
	noteFieldDone.add(doctype);
}

/** Списание со склада (Stock Entry: Material Issue). reason — причина, note — примечание (наши custom-поля). */
export async function createWriteOffDraft(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; fromStore: string }>; dealId?: number; reason?: string; note?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	if (!args.lines.length) throw new Error('пустое списание');
	if (args.reason) await ensureWriteoffField(erp);
	if (args.note) await ensureNoteField(erp, 'Stock Entry');
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Issue',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		...(args.reason ? { [WRITEOFF_REASON_FIELD]: args.reason.slice(0, 140) } : {}),
		...(args.note ? { [NOTE_FIELD]: args.note.slice(0, 140) } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, l.fromStore),
		})),
	});
	return { name: String(doc['name']) };
}

/** Приход на склад (Purchase Receipt от технического поставщика). note — примечание (необязательное). */
export async function createReceiptDraft(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; toStore: string; rate: number }>; dealId?: number; supplier?: string; note?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	if (args.note) await ensureNoteField(erp, 'Purchase Receipt');
	const doc = await erp.create('Purchase Receipt', {
		company: ctx.company,
		supplier: args.supplier ?? TECH_SUPPLIER,
		set_posting_time: 1,
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		...(args.note ? { [NOTE_FIELD]: args.note.slice(0, 140) } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			warehouse: erpWarehouse(ctx, l.toStore),
			rate: l.rate,
		})),
	});
	return { name: String(doc['name']) };
}

export async function submitDoc(erp: ErpClient, doctype: 'Delivery Note' | 'Stock Entry' | 'Purchase Receipt', name: string): Promise<void> {
	await erp.submit(doctype, name);
}

// ── Ремонтное оборудование: позиция на складе ядра под принятый в ремонт аппарат ──
// Живёт ТОЛЬКО в ядре (productId Б24 нет) → код строковый `REPAIR-<номер>`. Строковый код
// автоматически невидим в продажных остатках (везде фильтр productId>0 отсекает нечисловые),
// а группа «Ремонтное оборудование» — для явного поиска и фильтра по контексту.
export const REPAIR_ITEM_GROUP = 'Ремонтное оборудование';
let repairGroupDone = false;
async function ensureRepairItemGroup(erp: ErpClient): Promise<void> {
	if (repairGroupDone) return;
	if (!(await erp.get('Item Group', REPAIR_ITEM_GROUP))) {
		await erp.create('Item Group', { item_group_name: REPAIR_ITEM_GROUP, parent_item_group: 'All Item Groups', is_group: 0 });
	}
	repairGroupDone = true;
}

/** Завести позицию ремонтного аппарата в ядре (строковый код, группа «Ремонтное оборудование»). Идемпотентно. */
export async function ensureRepairItem(erp: ErpClient, args: { itemCode: string; itemName: string }): Promise<void> {
	if (await erp.get('Item', args.itemCode)) return;
	if (!(await erp.get('UOM', UOM))) await erp.create('UOM', { uom_name: UOM });
	await ensureRepairItemGroup(erp);
	await erp.create('Item', {
		item_code: args.itemCode,
		item_name: args.itemName || args.itemCode,
		item_group: REPAIR_ITEM_GROUP,
		stock_uom: UOM,
		is_stock_item: 1,
		description: `Принято в ремонт (${args.itemCode})`,
	});
}

/** Переименовать позицию ремонта (менеджер поправил название/клиента) — без движения остатка.
 *  Один Item на аппарат: правим имя, а не плодим позиции, иначе на складе остаются «призраки». */
export async function renameRepairItem(erp: ErpClient, args: { itemCode: string; itemName: string }): Promise<void> {
	const it = await erp.get('Item', args.itemCode);
	if (!it || !args.itemName) return;
	if (String(it['item_name'] ?? '') === args.itemName) return;
	await erp.update('Item', args.itemCode, { item_name: args.itemName });
}

/** Принять 1 шт ремонтного аппарата на склад приёмки (Purchase Receipt, rate 0, сразу проведён).
 *  Заводит позицию, если её ещё нет. Возвращает имя проведённого документа. */
export async function receiveRepairUnit(erp: ErpClient, args: { itemCode: string; itemName: string; storeTitle: string }): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	await ensureRepairItem(erp, { itemCode: args.itemCode, itemName: args.itemName });
	const doc = await erp.create('Purchase Receipt', {
		company: ctx.company,
		supplier: TECH_SUPPLIER,
		set_posting_time: 1,
		items: [{ item_code: args.itemCode, qty: 1, warehouse: erpWarehouse(ctx, args.storeTitle), rate: 0 }],
	});
	const name = String(doc['name']);
	await erp.submit('Purchase Receipt', name);
	return { name };
}

/** Перемещение 1 шт ремонтного аппарата между складами (Stock Entry: Material Transfer, сразу проведён).
 *  fromStore/toStore — названия складов Б24 (включая транзит `Goods In Transit`). Движение по смене статуса ремонта. */
export async function moveRepairUnit(erp: ErpClient, args: { itemCode: string; fromStore: string; toStore: string }): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Transfer',
		items: [{
			item_code: args.itemCode,
			qty: 1,
			s_warehouse: erpWarehouse(ctx, args.fromStore),
			t_warehouse: erpWarehouse(ctx, args.toStore),
		}],
	});
	const name = String(doc['name']);
	await erp.submit('Stock Entry', name);
	return { name };
}

/** Списать ремонтный аппарат со склада при выдаче клиенту (Delivery Note, цена 0 — не продаём, выдаём владельцу).
 *  Привязка к сделке через b24_deal_id → документ виден в реализациях сделки. Сразу проведён. */
export async function deliverRepairUnit(erp: ErpClient, args: { itemCode: string; storeTitle: string; dealId?: number }): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	const doc = await erp.create('Delivery Note', {
		company: ctx.company,
		customer: TECH_CUSTOMER,
		set_posting_time: 1,
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		items: [{ item_code: args.itemCode, qty: 1, warehouse: erpWarehouse(ctx, args.storeTitle), rate: 0 }],
	});
	const name = String(doc['name']);
	await erp.submit('Delivery Note', name);
	return { name };
}

// ── Инвентаризация: Stock Reconciliation «на основании» точки подсчёта ────────

const INV_FIELD = 'b24_inv_ref';
let invFieldDone = false;

/** Идемпотентно: custom-поле привязки reco к точке инвентаризации (inv<id>:store<id>). */
async function ensureInvField(erp: ErpClient): Promise<void> {
	if (invFieldDone) return;
	const cfName = `Stock Reconciliation-${INV_FIELD}`;
	if (!(await erp.get('Custom Field', cfName))) {
		await erp.create('Custom Field', {
			dt: 'Stock Reconciliation', fieldname: INV_FIELD, label: 'B24 Inventory',
			fieldtype: 'Data', insert_after: 'purpose', in_standard_filter: 1, in_list_view: 1,
		});
	}
	invFieldDone = true;
}

/** Книжные остатки ядра по ОДНОМУ складу: productId → qty (плюс valuation для reco). */
export async function fetchErpStoreStock(erp: ErpClient, storeTitle: string): Promise<Map<number, { qty: number; valuation: number }>> {
	const ctx = await erpContext(erp);
	const bins = await erp.list('Bin', ['item_code', 'actual_qty', 'valuation_rate'], [['warehouse', '=', erpWarehouse(ctx, storeTitle)]]);
	const out = new Map<number, { qty: number; valuation: number }>();
	for (const b of bins) {
		const productId = Number(b['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		out.set(productId, { qty: Number(b['actual_qty'] ?? 0), valuation: Number(b['valuation_rate'] ?? 0) });
	}
	return out;
}

export interface ErpStoreLine {
	productId: number;
	name: string;
	book: number;
	article: string;
	model: string;
	brand: string;
	section: string;
	/** Путь файла в ядре ('/files/...') — фронт показывает через прокси /api/inventory/erp-image. */
	image: string;
}

/** Полная строка склада из ЯДРА для подсчёта: остаток (Bin>0) + карточка (Item: имя/модель/артикул/бренд/фото).
 *  Заменяет Б24-источник в инвентаризации (всё из ядра, без кусков от Б24). */
export async function fetchErpStoreStockFull(erp: ErpClient, storeTitle: string): Promise<ErpStoreLine[]> {
	const ctx = await erpContext(erp);
	const bins = await erp.list('Bin', ['item_code', 'actual_qty'], [['warehouse', '=', erpWarehouse(ctx, storeTitle)], ['actual_qty', '>', 0]]);
	const ids = [...new Set(bins.map((b) => String(b['item_code'])).filter((c) => /^\d+$/.test(c)))];
	if (!ids.length) return [];
	const itemById = new Map<string, Record<string, unknown>>();
	for (let i = 0; i < ids.length; i += 200) {
		const chunk = ids.slice(i, i + 200);
		const rows = await erp.list('Item', ['name', 'item_name', 'b24_model', 'b24_article', 'b24_brand', 'b24_section', 'image'], [['name', 'in', chunk]]);
		for (const r of rows) itemById.set(String(r['name']), r);
	}
	const out: ErpStoreLine[] = [];
	for (const b of bins) {
		const productId = Number(b['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		const it = itemById.get(String(productId));
		out.push({
			productId,
			name: String(it?.['item_name'] ?? `#${productId}`),
			book: Number(b['actual_qty'] ?? 0),
			article: String(it?.['b24_article'] ?? ''),
			model: String(it?.['b24_model'] ?? ''),
			brand: String(it?.['b24_brand'] ?? ''),
			section: String(it?.['b24_section'] ?? ''),
			image: String(it?.['image'] ?? ''),
		});
	}
	return out;
}

/** Имена товаров ядра пачкой (для болванки): productId → item_name. */
export async function fetchErpItemNames(erp: ErpClient, productIds: number[]): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	for (let i = 0; i < productIds.length; i += 200) {
		const chunk = productIds.slice(i, i + 200).map(String);
		const rows = await erp.list('Item', ['name', 'item_name'], [['name', 'in', chunk]]);
		for (const r of rows) out.set(Number(r['name']), String(r['item_name'] ?? ''));
	}
	return out;
}

export interface InventoryRecoLine {
	productId: number;
	/** Фактический остаток (абсолют, не дельта) — Stock Reco выставляет qty В ЛОБ. */
	qty: number;
	/** Valuation обязателен для строк, где остатка в ядре ещё нет; для прочих шлём текущий из Bin. */
	valuation: number;
}

/**
 * Черновик Stock Reconciliation по точке инвентаризации (1С-модель: «Записать»).
 * Проведение — submitInventoryReco («Провести»), двигает остатки ядра.
 */
export async function createInventoryRecoDraft(
	erp: ErpClient,
	args: { invRef: string; storeTitle: string; lines: InventoryRecoLine[]; postingDate?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureInvField(erp);
	if (!args.lines.length) throw new Error('нет строк с расхождениями — документ не нужен');
	// Разностный счёт обычного reco — Stock Adjustment компании (НЕ Temporary Opening: это не открытие).
	const adj = (await erp.list('Account', ['name'], [['account_type', '=', 'Stock Adjustment'], ['company', '=', ctx.company]]))[0];
	if (!adj) throw new Error(`нет счёта Stock Adjustment у компании «${ctx.company}»`);
	const doc = await erp.create('Stock Reconciliation', {
		company: ctx.company,
		purpose: 'Stock Reconciliation',
		set_posting_time: 1,
		...(args.postingDate ? { posting_date: args.postingDate } : {}),
		expense_account: String(adj['name']),
		[INV_FIELD]: args.invRef,
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			warehouse: erpWarehouse(ctx, args.storeTitle),
			qty: l.qty,
			valuation_rate: Math.max(l.valuation, 0.01),
		})),
	});
	return { name: String(doc['name']) };
}

export async function submitInventoryReco(erp: ErpClient, name: string): Promise<void> {
	await erp.submit('Stock Reconciliation', name);
}

/** Удалить НЕпроведённый черновик reco (отмена «Записать»; болванка-пересоздание). */
export async function deleteInventoryRecoDraft(erp: ErpClient, name: string): Promise<void> {
	const doc = await erp.get('Stock Reconciliation', name);
	if (!doc) return;
	if (Number(doc['docstatus'] ?? 0) !== 0) throw new Error(`${name} уже проведён — удалять нельзя`);
	await erp.request('DELETE', `/api/resource/Stock%20Reconciliation/${encodeURIComponent(name)}`);
}

// ── Складской учёт: журнал движений (read-only вкладки) ───────────────────────

export interface CoreMovement { name: string; date: string; submitted: boolean; summary: string; dealId: string }

/**
 * Документы движения по типу: 'issue' (списание) / 'receipt' (оприходование) / 'delivery' (реализация).
 * Период (from/to по posting_date, YYYY-MM-DD) фильтруется в ядре; без периода — последние 50.
 * Сортировка posting_date desc (свежие сверху).
 */
export async function listCoreMovements(
	erp: ErpClient,
	kind: 'issue' | 'receipt' | 'delivery' | 'return',
	opts: { from?: string; to?: string; productId?: number } = {},
): Promise<CoreMovement[]> {
	const dateFilters: unknown[] = [];
	if (opts.from) dateFilters.push(['posting_date', '>=', opts.from]);
	if (opts.to) dateFilters.push(['posting_date', '<=', opts.to]);
	// Фильтр по товару = по дочерней таблице документа (frappe: [child_doctype, field, op, val]).
	const child = (childDt: string): unknown[] => opts.productId ? [[childDt, 'item_code', '=', String(opts.productId)]] : [];
	const limit = (opts.from || opts.to || opts.productId) ? 1000 : 50;
	const ORDER = 'posting_date desc';
	if (kind === 'delivery' || kind === 'return') {
		// Реализации и возвраты — один doctype (Delivery Note), разводим по is_return: 0=продажа, 1=возврат.
		await ensureNoteField(erp, 'Delivery Note'); // причина возврата лежит в b24_note
		const isRet = kind === 'return' ? 1 : 0;
		const rows = await erp.list('Delivery Note', ['name', 'posting_date', 'grand_total', 'docstatus', DEAL_FIELD, NOTE_FIELD], [['docstatus', '!=', 2], ['is_return', '=', isRet], ...dateFilters, ...child('Delivery Note Item')], limit, ORDER);
		return rows.map((r) => {
			const base = `${Number(r['grand_total'] ?? 0).toLocaleString('ru-RU')} ₽`;
			const note = String(r[NOTE_FIELD] ?? '');
			return { name: String(r['name']), date: String(r['posting_date'] ?? ''), submitted: Number(r['docstatus']) === 1, summary: kind === 'return' && note ? `${base} · ${note}` : base, dealId: String(r[DEAL_FIELD] ?? '') };
		});
	}
	const withNote = (base: string, note: string): string => note ? (base ? `${base} · ${note}` : note) : base;
	if (kind === 'receipt') {
		await ensureNoteField(erp, 'Purchase Receipt'); // поле может ещё не существовать — select упал бы
		const rows = await erp.list('Purchase Receipt', ['name', 'posting_date', 'grand_total', 'supplier', 'docstatus', DEAL_FIELD, NOTE_FIELD], [['docstatus', '!=', 2], ...dateFilters, ...child('Purchase Receipt Item')], limit, ORDER);
		return rows.map((r) => ({ name: String(r['name']), date: String(r['posting_date'] ?? ''), submitted: Number(r['docstatus']) === 1, summary: withNote(String(r['supplier'] ?? ''), String(r[NOTE_FIELD] ?? '')), dealId: String(r[DEAL_FIELD] ?? '') }));
	}
	await ensureWriteoffField(erp); // поле причины может ещё не существовать — select упал бы
	await ensureNoteField(erp, 'Stock Entry');
	const rows = await erp.list('Stock Entry', ['name', 'posting_date', 'docstatus', DEAL_FIELD, WRITEOFF_REASON_FIELD, NOTE_FIELD], [['stock_entry_type', '=', 'Material Issue'], ['docstatus', '!=', 2], ...dateFilters, ...child('Stock Entry Detail')], limit, ORDER);
	return rows.map((r) => ({ name: String(r['name']), date: String(r['posting_date'] ?? ''), submitted: Number(r['docstatus']) === 1, summary: withNote(String(r[WRITEOFF_REASON_FIELD] ?? '') || 'списание', String(r[NOTE_FIELD] ?? '')), dealId: String(r[DEAL_FIELD] ?? '') }));
}

// ── Детали документа + история движений по товару (для окна «Складской учёт») ──

export interface CoreDocItem { productId: number; itemName: string; qty: number; store: string; rate: number }
export interface CoreDocDetail {
	name: string; doctype: string; date: string; submitted: boolean; dealId: string;
	supplier: string; reason: string; note: string; items: CoreDocItem[];
}

/** Допустимые типы документов для детального просмотра (защита от произвольного doctype). */
const VIEWABLE_DOCTYPES = new Set(['Stock Entry', 'Purchase Receipt', 'Delivery Note', 'Stock Reconciliation']);

/** Содержимое одного складского документа ядра (строки + шапка) — для раскрытия в журнале. */
export async function fetchCoreDocDetail(erp: ErpClient, doctype: string, name: string): Promise<CoreDocDetail> {
	if (!VIEWABLE_DOCTYPES.has(doctype)) throw new Error(`недопустимый тип документа: ${doctype}`);
	const ctx = await erpContext(erp);
	const doc = await erp.get(doctype, name);
	if (!doc) throw new Error('документ не найден');
	const raw = (doc['items'] as Array<Record<string, unknown>>) ?? [];
	const items: CoreDocItem[] = raw.map((it) => {
		const wh = String(it['warehouse'] ?? it['t_warehouse'] ?? it['s_warehouse'] ?? '');
		return {
			productId: Number(it['item_code']),
			itemName: String(it['item_name'] ?? ''),
			qty: Number(it['qty'] ?? 0),
			store: wh ? b24StoreTitle(ctx, wh) : '',
			rate: Number(it['rate'] ?? it['valuation_rate'] ?? 0),
		};
	});
	return {
		name: String(doc['name']), doctype, date: String(doc['posting_date'] ?? ''),
		submitted: Number(doc['docstatus']) === 1, dealId: String(doc[DEAL_FIELD] ?? ''),
		supplier: String(doc['supplier'] ?? ''), reason: String(doc[WRITEOFF_REASON_FIELD] ?? ''),
		note: String(doc[NOTE_FIELD] ?? ''), items,
	};
}

export interface ItemMovement { date: string; doctype: string; voucherNo: string; kind: string; qty: number; store: string }

/** История движений ОДНОГО товара по всем типам — родной Stock Ledger Entry ядра.
 *  kind: человекочитаемый тип (оприходование/списание/перемещение/реализация/инвентаризация). */
export async function itemStockLedger(erp: ErpClient, productId: number, limit = 300): Promise<ItemMovement[]> {
	const ctx = await erpContext(erp);
	const rows = await erp.list('Stock Ledger Entry',
		['posting_date', 'actual_qty', 'warehouse', 'voucher_type', 'voucher_no'],
		[['item_code', '=', String(productId)], ['is_cancelled', '=', 0]], limit, 'posting_date desc, creation desc');
	// Аварийные ручные коррекции нужны только для тихого выравнивания остатков.
	// Технический документ остаётся в ERPNext, но в пользовательский журнал не попадает.
	const recoNos = [...new Set(rows
		.filter((r) => String(r['voucher_type']) === 'Stock Reconciliation')
		.map((r) => String(r['voucher_no']))
		.filter(Boolean))];
	const hiddenCorrections = new Set<string>();
	for (let i = 0; i < recoNos.length; i += 100) {
		const chunk = recoNos.slice(i, i + 100);
		const recos = await erp.list('Stock Reconciliation', ['name', INV_FIELD], [['name', 'in', chunk]]);
		for (const reco of recos) {
			if (String(reco[INV_FIELD] ?? '').startsWith('correction')) hiddenCorrections.add(String(reco['name']));
		}
	}
	const visibleRows = rows.filter((r) => !(
		String(r['voucher_type']) === 'Stock Reconciliation'
		&& hiddenCorrections.has(String(r['voucher_no']))
	));
	// Для Stock Entry уточняем тип (перемещение/списание/оприходование) пачкой по voucher_no.
	const steNos = [...new Set(visibleRows.filter((r) => String(r['voucher_type']) === 'Stock Entry').map((r) => String(r['voucher_no'])))];
	const steType = new Map<string, string>();
	for (let i = 0; i < steNos.length; i += 100) {
		const chunk = steNos.slice(i, i + 100);
		const ste = await erp.list('Stock Entry', ['name', 'stock_entry_type'], [['name', 'in', chunk]]);
		for (const s of ste) steType.set(String(s['name']), String(s['stock_entry_type'] ?? ''));
	}
	const label = (vt: string, no: string): string => {
		if (vt === 'Purchase Receipt') return 'оприходование';
		if (vt === 'Delivery Note') return 'реализация';
		if (vt === 'Stock Reconciliation') return 'инвентаризация/коррекция';
		if (vt === 'Stock Entry') {
			const t = steType.get(no) ?? '';
			return t === 'Material Transfer' ? 'перемещение' : t === 'Material Receipt' ? 'оприходование' : 'списание';
		}
		return vt;
	};
	return visibleRows.map((r) => {
		const vt = String(r['voucher_type'] ?? '');
		const no = String(r['voucher_no'] ?? '');
		return { date: String(r['posting_date'] ?? ''), doctype: vt, voucherNo: no, kind: label(vt, no), qty: Number(r['actual_qty'] ?? 0), store: b24StoreTitle(ctx, String(r['warehouse'] ?? '')) };
	});
}

// ── Поиск товаров / склады (пикер позиций и формы окна «Складской учёт») ──────

/** Поиск товаров в ядре: по id (item_code), имени или артикулу. Для пикера позиций. */
export async function searchErpItems(erp: ErpClient, q: string, limit = 25): Promise<Array<{ productId: number; name: string; article: string; brand: string }>> {
	const term = q.trim();
	if (!term) return [];
	const seen = new Map<number, { productId: number; name: string; article: string; brand: string }>();
	const fields = ['name', 'item_name', 'b24_article', 'b24_brand'];
	const grp: unknown[] = [['item_group', '=', ITEM_GROUP]];
	const add = (rows: Array<Record<string, unknown>>): void => {
		for (const r of rows) {
			const pid = Number(r['name']);
			if (Number.isInteger(pid) && pid > 0 && !seen.has(pid)) {
				seen.set(pid, { productId: pid, name: String(r['item_name'] ?? ''), article: String(r['b24_article'] ?? ''), brand: String(r['b24_brand'] ?? '') });
			}
		}
	};
	if (/^\d+$/.test(term)) add(await erp.list('Item', fields, [...grp, ['name', '=', term]], 1));
	add(await erp.list('Item', fields, [...grp, ['item_name', 'like', `%${term}%`]], limit));
	if (seen.size < limit) add(await erp.list('Item', fields, [...grp, ['b24_article', 'like', `%${term}%`]], limit));
	return [...seen.values()].slice(0, limit);
}

/** Список активных складов (названия Б24) — для выбора склада в формах окна. */
export async function listActiveStoreTitles(erp: ErpClient): Promise<string[]> {
	const ctx = await erpContext(erp);
	const whs = await erp.list('Warehouse', ['name', 'warehouse_type'], [['is_group', '=', 0], ['disabled', '=', 0]]);
	const sys = new Set(['Goods In Transit', 'Stores', 'Finished Goods', 'Work In Progress']);
	return whs
		.filter((w) => String(w['warehouse_type'] ?? '') !== 'Transit')
		.map((w) => b24StoreTitle(ctx, String(w['name'] ?? '')))
		.filter((t) => t && !sys.has(t))
		.sort((a, b) => a.localeCompare(b, 'ru'));
}

