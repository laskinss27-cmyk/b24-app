import type { ErpClient } from './client.js';
import { DEAL_FIELD } from './erp-setup.js';
import { INV_FIELD } from './inventory-reconciliation.js';
import { REALIZATION_SEGMENT_FIELD } from './stock-catalog.js';
import { erpContext, erpWarehouse } from './warehouse-context.js';

export type EditableStockDocumentKind = 'issue' | 'receipt' | 'return';

export interface StockDocumentAmendLine {
	rowId?: string;
	productId: number;
	qty: number;
	store: string;
	rate?: number;
	sourceRow?: string;
}

export interface StockDocumentAmendInput {
	doctype: string;
	name: string;
	date: string;
	supplier?: string;
	reason?: string;
	note?: string;
	lines: StockDocumentAmendLine[];
}

export interface StockDocumentAmendResult {
	previousName: string;
	name: string;
	kind: EditableStockDocumentKind;
}

export interface EditableDocumentDescriptor {
	kind: EditableStockDocumentKind | null;
	blockedReason: string;
}

const COPY_HEADER_FIELDS = [
	'company', 'customer', 'posting_time', 'set_posting_time', 'currency', 'conversion_rate',
	'selling_price_list', 'price_list_currency', 'plc_conversion_rate', 'territory', 'project',
	'cost_center', 'customer_address', 'shipping_address_name', 'dispatch_address_name',
	'company_address', 'contact_person', 'transporter', 'driver', 'lr_no', 'vehicle_no',
	'tc_name', 'terms', 'letter_head', 'print_without_amount', 'remarks',
] as const;

const COPY_ITEM_FIELDS = [
	'item_code', 'item_name', 'description', 'brand', 'item_group', 'image', 'stock_uom', 'uom',
	'conversion_factor', 'price_list_rate', 'discount_percentage', 'discount_amount', 'margin_type',
	'margin_rate_or_amount', 'expense_account', 'cost_center', 'project', 'purchase_order',
	'purchase_order_item', 'material_request', 'material_request_item', 'against_sales_order',
	'so_detail', 'serial_and_batch_bundle', 'use_serial_batch_fields', 'serial_no', 'batch_no',
	'allow_zero_valuation_rate', 'quality_inspection', 'customer_item_code', 'page_break',
] as const;

const SERVICE_OPERATION_FIELD = 'b24_condition_operation';
const NOTE_FIELD = 'b24_note';
const WRITEOFF_REASON_FIELD = 'b24_reason';

function pickDefined(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const value = source[key];
		if (value !== undefined && value !== null && value !== '') result[key] = value;
	}
	return result;
}

function customFields(source: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(source).filter(([key, value]) => key.startsWith('b24_') && value !== undefined && value !== null));
}

export function editableStockDocumentDescriptor(doctype: string, doc: Record<string, unknown>): EditableDocumentDescriptor {
	if (Number(doc['docstatus'] ?? 0) !== 1) return { kind: null, blockedReason: 'Редактировать можно только проведённый документ.' };
	if (String(doc[INV_FIELD] ?? '').trim()) return { kind: null, blockedReason: 'Документ создан инвентаризацией и исправляется из неё.' };
	if (String(doc[SERVICE_OPERATION_FIELD] ?? '').trim()) return { kind: null, blockedReason: 'Служебный документ состояния товара нельзя исправить вручную.' };
	if (doctype === 'Purchase Receipt') return { kind: 'receipt', blockedReason: '' };
	if (doctype === 'Delivery Note' && Number(doc['is_return'] ?? 0) === 1) return { kind: 'return', blockedReason: '' };
	if (doctype === 'Stock Entry') {
		const type = String(doc['stock_entry_type'] ?? '');
		if (type === 'Material Issue') return { kind: 'issue', blockedReason: '' };
		if (type === 'Material Receipt') return { kind: 'receipt', blockedReason: '' };
	}
	return { kind: null, blockedReason: 'Этот тип документа не поддерживает ручное исправление.' };
}

function lineIdentity(line: Record<string, unknown>): string {
	return String(line['name'] ?? '');
}

function buildCopy(
	doc: Record<string, unknown>,
	doctype: string,
	kind: EditableStockDocumentKind,
	input: StockDocumentAmendInput | null,
	warehouse: (title: string) => string,
	amendedFrom: string,
): Record<string, unknown> {
	const result = { ...pickDefined(doc, COPY_HEADER_FIELDS), ...customFields(doc) };
	result['posting_date'] = input?.date || String(doc['posting_date'] ?? '');
	result['set_posting_time'] = 1;
	result['amended_from'] = amendedFrom;
	result[DEAL_FIELD] = String(doc[DEAL_FIELD] ?? '');
	if (doctype === 'Stock Entry') result['stock_entry_type'] = String(doc['stock_entry_type'] ?? '');
	if (doctype === 'Delivery Note') {
		result['is_return'] = 1;
		result['return_against'] = String(doc['return_against'] ?? '');
	}
	if (input) {
		if (doctype === 'Purchase Receipt') result['supplier'] = input.supplier || String(doc['supplier'] ?? '');
		result[WRITEOFF_REASON_FIELD] = input.reason?.slice(0, 140) ?? String(doc[WRITEOFF_REASON_FIELD] ?? '');
		result[NOTE_FIELD] = input.note?.slice(0, 200) ?? String(doc[NOTE_FIELD] ?? '');
	}
	const rawLines = Array.isArray(doc['items']) ? doc['items'] as Array<Record<string, unknown>> : [];
	const requested = input?.lines ?? rawLines.map((line) => ({
		rowId: lineIdentity(line),
		productId: Number(line['item_code']),
		qty: Math.abs(Number(line['qty'] ?? 0)),
		store: String(line['warehouse'] ?? line['t_warehouse'] ?? line['s_warehouse'] ?? ''),
		rate: Number(line['rate'] ?? line['valuation_rate'] ?? line['basic_rate'] ?? 0),
		sourceRow: String(line['dn_detail'] ?? ''),
	}));
	result['items'] = requested.map((line) => {
		const original = rawLines.find((candidate) => line.rowId && lineIdentity(candidate) === line.rowId)
			?? rawLines.find((candidate) => Number(candidate['item_code']) === line.productId)
			?? {};
		const item = pickDefined(original, COPY_ITEM_FIELDS);
		item['item_code'] = String(line.productId);
		item['qty'] = kind === 'return' ? -Math.abs(line.qty) : line.qty;
		if (kind === 'issue') item['s_warehouse'] = warehouse(line.store);
		else item[doctype === 'Stock Entry' ? 't_warehouse' : 'warehouse'] = warehouse(line.store);
		if (kind === 'receipt') {
			const rate = Math.max(Number(line.rate ?? 0), doctype === 'Stock Entry' ? 0.01 : 0);
			item['rate'] = rate;
			item['basic_rate'] = rate;
			item['valuation_rate'] = rate;
		}
		if (kind === 'return') {
			const sourceRow = line.sourceRow || String(original['dn_detail'] ?? '');
			if (!sourceRow) throw new Error(`товар #${line.productId}: потеряна связь с исходной реализацией`);
			item['dn_detail'] = sourceRow;
			item[REALIZATION_SEGMENT_FIELD] = String(original[REALIZATION_SEGMENT_FIELD] ?? '');
			item['rate'] = Number(original['rate'] ?? 0);
			item['price_list_rate'] = Number(original['price_list_rate'] ?? original['rate'] ?? 0);
		}
		return item;
	});
	return result;
}

function validateInput(kind: EditableStockDocumentKind, doc: Record<string, unknown>, input: StockDocumentAmendInput): void {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('укажите корректную дату документа');
	if (!input.lines.length) throw new Error('в документе должна остаться хотя бы одна позиция');
	for (const line of input.lines) {
		if (!Number.isInteger(line.productId) || line.productId <= 0 || !Number.isFinite(line.qty) || line.qty <= 0 || !line.store.trim()) {
			throw new Error('проверьте товар, количество и склад во всех строках');
		}
		if (kind === 'receipt' && (!Number.isFinite(line.rate) || Number(line.rate) < 0)) throw new Error('закупочная цена не может быть отрицательной');
	}
	if (kind === 'return') {
		const sourceRows = new Set(((doc['items'] as Array<Record<string, unknown>> | undefined) ?? []).map((line) => String(line['dn_detail'] ?? '')).filter(Boolean));
		if (input.lines.some((line) => !line.sourceRow || !sourceRows.has(line.sourceRow))) {
			throw new Error('в проведённый возврат нельзя добавлять новые позиции; создайте отдельный возврат из сделки');
		}
	}
	if (String(doc['b24_purchase_order'] ?? '')) {
		const rowIds = new Set(((doc['items'] as Array<Record<string, unknown>> | undefined) ?? []).map(lineIdentity).filter(Boolean));
		if (input.lines.some((line) => !line.rowId || !rowIds.has(line.rowId))) {
			throw new Error('в оприходование по заказу нельзя добавлять новые позиции; измените состав заказа поставщику');
		}
	}
}

export async function amendSubmittedStockDocument(erp: ErpClient, input: StockDocumentAmendInput): Promise<StockDocumentAmendResult> {
	const original = await erp.get<Record<string, unknown>>(input.doctype, input.name);
	if (!original) throw new Error('документ не найден');
	const descriptor = editableStockDocumentDescriptor(input.doctype, original);
	if (!descriptor.kind) throw new Error(descriptor.blockedReason);
	validateInput(descriptor.kind, original, input);
	const ctx = await erpContext(erp);
	const toWarehouse = (title: string): string => title.includes(` - ${ctx.abbr}`) ? title : erpWarehouse(ctx, title);
	const replacementFields = buildCopy(original, input.doctype, descriptor.kind, input, toWarehouse, input.name);
	const restoreFields = buildCopy(original, input.doctype, descriptor.kind, null, toWarehouse, input.name);
	let replacementName = '';
	await erp.cancel(input.doctype, input.name);
	try {
		const replacement = await erp.create(input.doctype, replacementFields);
		replacementName = String(replacement['name'] ?? '');
		if (!replacementName) throw new Error('ядро не вернуло номер исправленного документа');
		await erp.submit(input.doctype, replacementName);
		return { previousName: input.name, name: replacementName, kind: descriptor.kind };
	} catch (error) {
		if (replacementName) await erp.delete(input.doctype, replacementName).catch(() => undefined);
		let restoredName = '';
		try {
			const restored = await erp.create(input.doctype, restoreFields);
			restoredName = String(restored['name'] ?? '');
			if (!restoredName) throw new Error('ядро не вернуло номер восстановленного документа');
			await erp.submit(input.doctype, restoredName);
		} catch (restoreError) {
			throw new Error(`не удалось исправить документ: ${String(error)}. Автовосстановление требует проверки: ${String(restoreError)}`);
		}
		throw new Error(`не удалось исправить документ: ${String(error)}; исходное движение восстановлено документом ${restoredName}`);
	}
}
