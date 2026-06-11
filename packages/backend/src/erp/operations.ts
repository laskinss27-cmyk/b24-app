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

/** Списание со склада (Stock Entry: Material Issue). */
export async function createWriteOffDraft(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; fromStore: string }>; dealId?: number },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Issue',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, l.fromStore),
		})),
	});
	return { name: String(doc['name']) };
}

/** Приход на склад (Purchase Receipt от технического поставщика). */
export async function createReceiptDraft(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; toStore: string; rate: number }>; dealId?: number; supplier?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	const doc = await erp.create('Purchase Receipt', {
		company: ctx.company,
		supplier: args.supplier ?? TECH_SUPPLIER,
		set_posting_time: 1,
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
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
