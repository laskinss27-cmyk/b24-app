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

const DEAL_FIELD = 'b24_deal_id';
/** Документы, которым нужно поле сделки. */
const DEAL_DOCTYPES = ['Delivery Note', 'Stock Entry', 'Purchase Receipt'] as const;
const TECH_CUSTOMER = 'Б24 Розница';
const TECH_SUPPLIER = 'Б24 Снабжение';
const ITEM_GROUP = 'Каталог Б24';

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
export async function ensureCoreItem(erp: ErpClient, args: { productId: number; name: string }): Promise<void> {
	const code = String(args.productId);
	if (await erp.get('Item', code)) return;
	if (!(await erp.get('UOM', UOM))) await erp.create('UOM', { uom_name: UOM });
	if (!(await erp.get('Item Group', ITEM_GROUP))) await erp.create('Item Group', { item_group_name: ITEM_GROUP, parent_item_group: 'All Item Groups', is_group: 0 });
	await erp.create('Item', {
		item_code: code,
		item_name: args.name || `#${code}`,
		item_group: ITEM_GROUP,
		stock_uom: UOM,
		is_stock_item: 1,
		description: `Б24 productId=${args.productId} (создан из приёмки)`,
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
	return `${b24StoreTitle} - ${ctx.abbr}`;
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
		const rows = await erp.list('Item', ['name', 'valuation_rate'], [['name', 'in', chunk]]);
		for (const r of rows) out.set(Number(r['name']), Number(r['valuation_rate'] ?? 0));
	}
	return out;
}

export interface RealizationLine {
	productId: number;
	qty: number;
	/** Склад списания — название склада Б24 (наш UI оперирует ими). */
	storeTitle: string;
	/** Цена продажи за единицу (для суммы документа). */
	rate: number;
}

export interface ErpRealization {
	name: string;
	dealId: string;
	postingDate: string;
	submitted: boolean;
	grandTotal: number;
	items: Array<{ productId: number; itemName: string; qty: number; storeTitle: string }>;
}

/** Черновик реализации (Delivery Note) с привязкой к сделке. Проведение — submitRealization. */
export async function createRealizationDraft(
	erp: ErpClient,
	args: { dealId: number; lines: RealizationLine[]; postingDate?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	if (!args.lines.length) throw new Error('пустая партия');
	const doc = await erp.create('Delivery Note', {
		company: ctx.company,
		customer: TECH_CUSTOMER,
		set_posting_time: 1,
		...(args.postingDate ? { posting_date: args.postingDate } : {}),
		[DEAL_FIELD]: String(args.dealId),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			warehouse: erpWarehouse(ctx, l.storeTitle),
			rate: l.rate,
		})),
	});
	return { name: String(doc['name']) };
}

export async function submitRealization(erp: ErpClient, name: string): Promise<void> {
	await erp.submit('Delivery Note', name);
}

/** Все партии-реализации сделки — одним фильтром по b24_deal_id. */
export async function listDealRealizations(erp: ErpClient, dealId: number): Promise<ErpRealization[]> {
	const ctx = await erpContext(erp);
	const heads = await erp.list('Delivery Note',
		['name', DEAL_FIELD, 'posting_date', 'docstatus', 'grand_total'],
		[[DEAL_FIELD, '=', String(dealId)], ['docstatus', '!=', 2]]);
	const out: ErpRealization[] = [];
	for (const h of heads) {
		const full = await erp.get('Delivery Note', String(h['name']));
		const items = ((full?.['items'] as Array<Record<string, unknown>>) ?? []).map((it) => ({
			productId: Number(it['item_code']),
			itemName: String(it['item_name'] ?? ''),
			qty: Number(it['qty'] ?? 0),
			storeTitle: b24StoreTitle(ctx, String(it['warehouse'] ?? '')),
		}));
		out.push({
			name: String(h['name']),
			dealId: String(h[DEAL_FIELD] ?? ''),
			postingDate: String(h['posting_date'] ?? ''),
			submitted: Number(h['docstatus']) === 1,
			grandTotal: Number(h['grand_total'] ?? 0),
			items,
		});
	}
	return out;
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
	args: { lines: Array<{ productId: number; qty: number; fromStore: string }>; dealId?: number },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	if (!args.lines.length) throw new Error('пустая отгрузка');
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Transfer',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, l.fromStore),
			t_warehouse: erpWarehouse(ctx, TRANSIT_STORE),
		})),
	});
	const name = String(doc['name']);
	await erp.submit('Stock Entry', name);
	return { name };
}

/**
 * «Получил» (закупка): Material Transfer С транзита на склад-получатель — создаёт и СРАЗУ проводит.
 * Товар приземляется на Б. Возвращает имя проведённого Stock Entry.
 */
export async function receiveTransferFromTransit(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; toStore: string }>; dealId?: number },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	if (!args.lines.length) throw new Error('пустая приёмка');
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Transfer',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, TRANSIT_STORE),
			t_warehouse: erpWarehouse(ctx, l.toStore),
		})),
	});
	const name = String(doc['name']);
	await erp.submit('Stock Entry', name);
	return { name };
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
			fieldtype: 'Data', insert_after: 'company', in_list_view: 1,
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
	kind: 'issue' | 'receipt' | 'delivery',
	opts: { from?: string; to?: string; productId?: number } = {},
): Promise<CoreMovement[]> {
	const dateFilters: unknown[] = [];
	if (opts.from) dateFilters.push(['posting_date', '>=', opts.from]);
	if (opts.to) dateFilters.push(['posting_date', '<=', opts.to]);
	// Фильтр по товару = по дочерней таблице документа (frappe: [child_doctype, field, op, val]).
	const child = (childDt: string): unknown[] => opts.productId ? [[childDt, 'item_code', '=', String(opts.productId)]] : [];
	const limit = (opts.from || opts.to || opts.productId) ? 1000 : 50;
	const ORDER = 'posting_date desc';
	if (kind === 'delivery') {
		const rows = await erp.list('Delivery Note', ['name', 'posting_date', 'grand_total', 'docstatus', DEAL_FIELD], [['docstatus', '!=', 2], ...dateFilters, ...child('Delivery Note Item')], limit, ORDER);
		return rows.map((r) => ({ name: String(r['name']), date: String(r['posting_date'] ?? ''), submitted: Number(r['docstatus']) === 1, summary: `${Number(r['grand_total'] ?? 0).toLocaleString('ru-RU')} ₽`, dealId: String(r[DEAL_FIELD] ?? '') }));
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
	// Для Stock Entry уточняем тип (перемещение/списание/оприходование) пачкой по voucher_no.
	const steNos = [...new Set(rows.filter((r) => String(r['voucher_type']) === 'Stock Entry').map((r) => String(r['voucher_no'])))];
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
	return rows.map((r) => {
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

