import { ErpClient } from './client.js';
import { DEAL_FIELD } from './erp-setup.js';
import { INV_FIELD } from './inventory-reconciliation.js';
import { b24StoreTitle, erpContext } from './warehouse-context.js';
import { editableStockDocumentDescriptor, type EditableStockDocumentKind } from './stock-document-amendments.js';
import { dealProductIdFromCoreItemCode } from '../deal-service-product-ids.js';

/** Причина списания — custom-поле на Stock Entry (показываем в журнале). */
export const WRITEOFF_REASON_FIELD = 'b24_reason';
let writeoffFieldDone = false;
export async function ensureWriteoffField(erp: ErpClient): Promise<void> {
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
export const NOTE_FIELD = 'b24_note';
const noteFieldDone = new Set<string>();
export async function ensureNoteField(erp: ErpClient, doctype: string): Promise<void> {
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

// ── Складской учёт: журнал движений (read-only вкладки) ───────────────────────

export interface CoreMovement { name: string; doctype: 'Stock Entry' | 'Purchase Receipt' | 'Delivery Note'; date: string; submitted: boolean; summary: string; dealId: string }

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
			return { name: String(r['name']), doctype: 'Delivery Note' as const, date: String(r['posting_date'] ?? ''), submitted: Number(r['docstatus']) === 1, summary: kind === 'return' && note ? `${base} · ${note}` : base, dealId: String(r[DEAL_FIELD] ?? '') };
		});
	}
	const withNote = (base: string, note: string): string => note ? (base ? `${base} · ${note}` : note) : base;
	if (kind === 'receipt') {
		await ensureNoteField(erp, 'Purchase Receipt'); // поле может ещё не существовать — select упал бы
		await ensureNoteField(erp, 'Stock Entry');
		const [purchaseReceipts, materialReceipts] = await Promise.all([
			erp.list('Purchase Receipt', ['name', 'posting_date', 'grand_total', 'supplier', 'docstatus', DEAL_FIELD, NOTE_FIELD], [['docstatus', '!=', 2], ...dateFilters, ...child('Purchase Receipt Item')], limit, ORDER),
			erp.list('Stock Entry', ['name', 'posting_date', 'docstatus', DEAL_FIELD, NOTE_FIELD], [['stock_entry_type', '=', 'Material Receipt'], ['docstatus', '!=', 2], ...dateFilters, ...child('Stock Entry Detail')], limit, ORDER),
		]);
		return [
			...purchaseReceipts.map((row) => ({
				name: String(row['name']), doctype: 'Purchase Receipt' as const, date: String(row['posting_date'] ?? ''), submitted: Number(row['docstatus']) === 1,
				summary: withNote(String(row['supplier'] ?? ''), String(row[NOTE_FIELD] ?? '')), dealId: String(row[DEAL_FIELD] ?? ''),
			})),
			...materialReceipts.map((row) => ({
				name: String(row['name']), doctype: 'Stock Entry' as const, date: String(row['posting_date'] ?? ''), submitted: Number(row['docstatus']) === 1,
				summary: String(row[NOTE_FIELD] ?? '') || 'оприходование', dealId: String(row[DEAL_FIELD] ?? ''),
			})),
		].sort((left, right) => right.date.localeCompare(left.date) || right.name.localeCompare(left.name)).slice(0, limit);
	}
	await ensureWriteoffField(erp); // поле причины может ещё не существовать — select упал бы
	await ensureNoteField(erp, 'Stock Entry');
	const rows = await erp.list('Stock Entry', ['name', 'posting_date', 'docstatus', DEAL_FIELD, WRITEOFF_REASON_FIELD, NOTE_FIELD], [['stock_entry_type', '=', 'Material Issue'], ['docstatus', '!=', 2], ...dateFilters, ...child('Stock Entry Detail')], limit, ORDER);
	return rows.map((r) => ({ name: String(r['name']), doctype: 'Stock Entry' as const, date: String(r['posting_date'] ?? ''), submitted: Number(r['docstatus']) === 1, summary: withNote(String(r[WRITEOFF_REASON_FIELD] ?? '') || 'списание', String(r[NOTE_FIELD] ?? '')), dealId: String(r[DEAL_FIELD] ?? '') }));
}

// ── Детали документа + история движений по товару (для окна «Складской учёт») ──

export interface CoreDocItem { rowId: string; sourceRow: string; productId: number; itemName: string; qty: number; store: string; rate: number }
export interface CoreDocDetail {
	name: string; doctype: string; date: string; submitted: boolean; dealId: string;
	supplier: string; reason: string; note: string; items: CoreDocItem[];
	kind: EditableStockDocumentKind | null; amendedFrom: string; editBlockedReason: string;
	allowAddLines: boolean;
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
			rowId: String(it['name'] ?? ''), sourceRow: String(it['dn_detail'] ?? ''),
			productId: Number(it['item_code']),
			itemName: String(it['item_name'] ?? ''),
			qty: Math.abs(Number(it['qty'] ?? 0)),
			store: wh ? b24StoreTitle(ctx, wh) : '',
			rate: Number(doctype === 'Stock Entry'
				? it['basic_rate'] ?? it['valuation_rate'] ?? it['rate'] ?? 0
				: it['rate'] ?? it['valuation_rate'] ?? 0),
		};
	});
	const editable = editableStockDocumentDescriptor(doctype, doc);
	return {
		name: String(doc['name']), doctype, date: String(doc['posting_date'] ?? ''),
		submitted: Number(doc['docstatus']) === 1, dealId: String(doc[DEAL_FIELD] ?? ''),
		supplier: String(doc['supplier'] ?? ''), reason: String(doc[WRITEOFF_REASON_FIELD] ?? ''),
		note: String(doc[NOTE_FIELD] ?? ''), items,
		kind: editable.kind, amendedFrom: String(doc['amended_from'] ?? ''), editBlockedReason: editable.blockedReason,
		allowAddLines: Boolean(editable.kind && editable.kind !== 'return' && !String(doc['b24_purchase_order'] ?? '')),
	};
}

export interface ItemMovement { date: string; doctype: string; voucherNo: string; kind: string; qty: number; store: string }

export interface ItemPendingDeal {
	dealId: string;
	planName: string;
	plannedQty: number;
	shippedQty: number;
	pendingQty: number;
	deliveryDate: string;
}

const movementQty = (value: unknown): number => {
	const qty = Number(value ?? 0);
	return Number.isFinite(qty) ? qty : 0;
};
const roundedMovementQty = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

/**
 * Актуальные планы сделок, в которых товар ещё не отгружен полностью.
 * Черновики реализаций не уменьшают остаток: товар считается отгруженным только
 * после проведения Delivery Note. Проведённые возвраты уменьшают чистую отгрузку.
 */
export async function itemPendingDeals(erp: ErpClient, productId: number): Promise<ItemPendingDeal[]> {
	const planHeads = await erp.list('Sales Order', ['name', DEAL_FIELD, 'delivery_date', 'creation'], [
		['docstatus', '=', 0],
		['Sales Order Item', 'item_code', '=', String(productId)],
	], 0, 'creation desc');
	const plans = new Map<string, { planName: string; plannedQty: number; deliveryDate: string }>();
	for (const head of planHeads) {
		const dealId = String(head[DEAL_FIELD] ?? '').trim();
		const planName = String(head['name'] ?? '').trim();
		if (!/^\d+$/.test(dealId) || !planName || plans.has(dealId)) continue;
		const doc = await erp.get<Record<string, unknown>>('Sales Order', planName);
		if (!doc) continue;
		const plannedQty = ((doc['items'] as Array<Record<string, unknown>> | undefined) ?? [])
			.filter((item) => dealProductIdFromCoreItemCode(item['item_code']) === productId)
			.reduce((sum, item) => sum + Math.max(0, movementQty(item['qty'])), 0);
		if (plannedQty <= 0.000001) continue;
		plans.set(dealId, {
			planName,
			plannedQty,
			deliveryDate: String(doc['delivery_date'] ?? head['delivery_date'] ?? ''),
		});
	}
	if (!plans.size) return [];

	const dealIds = [...plans.keys()];
	const deliveryHeads = await erp.list('Delivery Note', ['name', DEAL_FIELD], [
		[DEAL_FIELD, 'in', dealIds],
		['docstatus', '=', 1],
		['Delivery Note Item', 'item_code', '=', String(productId)],
	], 0, 'posting_date asc, creation asc');
	const shippedByDeal = new Map<string, number>();
	for (const head of deliveryHeads) {
		const dealId = String(head[DEAL_FIELD] ?? '').trim();
		const name = String(head['name'] ?? '').trim();
		if (!plans.has(dealId) || !name) continue;
		const doc = await erp.get<Record<string, unknown>>('Delivery Note', name);
		if (!doc || Number(doc['docstatus'] ?? 1) !== 1) continue;
		const qty = ((doc['items'] as Array<Record<string, unknown>> | undefined) ?? [])
			.filter((item) => dealProductIdFromCoreItemCode(item['item_code']) === productId)
			.reduce((sum, item) => sum + movementQty(item['qty']), 0);
		shippedByDeal.set(dealId, (shippedByDeal.get(dealId) ?? 0) + qty);
	}

	return [...plans.entries()].flatMap(([dealId, plan]) => {
		const plannedQty = roundedMovementQty(plan.plannedQty);
		const shippedQty = roundedMovementQty(Math.max(0, shippedByDeal.get(dealId) ?? 0));
		const pendingQty = roundedMovementQty(Math.max(0, plannedQty - shippedQty));
		return pendingQty > 0.000001 ? [{ dealId, ...plan, plannedQty, shippedQty, pendingQty }] : [];
	}).sort((left, right) => left.deliveryDate.localeCompare(right.deliveryDate) || Number(left.dealId) - Number(right.dealId));
}

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
