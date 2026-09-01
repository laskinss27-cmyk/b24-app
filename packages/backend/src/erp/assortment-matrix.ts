import { ErpClient } from './client.js';
import { erpContext, erpWarehouse, listActiveStoreTitles } from './operations.js';
import { fetchOutstandingOrderedQuantities } from './turnover-report.js';

export const ASSORTMENT_MATRIX_TARGET_DAYS = 60;
export const MATRIX_ENABLED_FIELD = 'b24_matrix_enabled';
export const MATRIX_CATEGORY_FIELD = 'b24_matrix_category';
export const MATRIX_SEGMENT_FIELD = 'b24_matrix_segment';
export const MATRIX_ORDER_QTY_FIELD = 'b24_matrix_order_qty';
export const MATRIX_COMMENT_FIELD = 'b24_matrix_comment';
export const ASSORTMENT_MATRIX_QUERY_BATCH_SIZE = 75;

export type MatrixSalesScope = 'selected' | 'all';

export interface AssortmentMatrixRow {
	productId: number;
	name: string;
	article: string;
	model: string;
	brand: string;
	category: string;
	segment: string;
	stocks: Record<string, number>;
	totalStock: number;
	reservedQty: number;
	freeQty: number;
	orderedQty: number;
	soldQty: number;
	recommendedQty: number;
	toOrderQty: number;
	comment: string;
}

export interface AssortmentMatrixReport {
	rows: AssortmentMatrixRow[];
	stores: string[];
	selectedStores: string[];
	salesScope: MatrixSalesScope;
	periodDays: number;
	targetDays: number;
	generatedAt: string;
}

let matrixFieldsDone = false;

export async function ensureAssortmentMatrixFields(erp: ErpClient): Promise<void> {
	if (matrixFieldsDone) return;
	const fields = [
		{ fieldname: MATRIX_ENABLED_FIELD, label: 'Матрица заказа', fieldtype: 'Check', default: '0' },
		{ fieldname: MATRIX_CATEGORY_FIELD, label: 'Категория матрицы', fieldtype: 'Data' },
		{ fieldname: MATRIX_SEGMENT_FIELD, label: 'Сегмент матрицы', fieldtype: 'Data' },
		{ fieldname: MATRIX_ORDER_QTY_FIELD, label: 'К заказу', fieldtype: 'Float', default: '0' },
		{ fieldname: MATRIX_COMMENT_FIELD, label: 'Комментарий матрицы', fieldtype: 'Small Text' },
	] as const;
	for (const field of fields) {
		const name = `Item-${field.fieldname}`;
		if (await erp.get('Custom Field', name)) continue;
		await erp.create('Custom Field', {
			dt: 'Item',
			...field,
			insert_after: 'description',
			in_standard_filter: field.fieldname === MATRIX_ENABLED_FIELD ? 1 : 0,
			in_list_view: 0,
		});
	}
	matrixFieldsDone = true;
}

const round = (value: number, digits = 2): number => {
	const factor = 10 ** digits;
	return Math.round((value + Number.EPSILON) * factor) / factor;
};

export function matrixRecommendation(input: {
	soldQty: number;
	periodDays: number;
	freeQty: number;
	orderedQty: number;
	targetDays?: number;
}): number {
	if (input.periodDays <= 0 || input.soldQty <= 0) return 0;
	const target = (input.soldQty / input.periodDays) * (input.targetDays ?? ASSORTMENT_MATRIX_TARGET_DAYS);
	return Math.max(0, Math.ceil(target - input.freeQty - input.orderedQty - 1e-9));
}

export interface AssortmentMatrixItemInput {
	productId: number;
	category: string;
	segment: string;
	toOrderQty: number;
	comment: string;
}

interface MatrixItemRecord extends AssortmentMatrixItemInput {
	name: string;
	article: string;
	model: string;
	brand: string;
}

export function assortmentMatrixItemCodeBatches(itemCodes: readonly string[]): string[][] {
	const batches: string[][] = [];
	for (let index = 0; index < itemCodes.length; index += ASSORTMENT_MATRIX_QUERY_BATCH_SIZE) {
		batches.push(itemCodes.slice(index, index + ASSORTMENT_MATRIX_QUERY_BATCH_SIZE));
	}
	return batches;
}

async function listMatrixRowsByItemCodes(
	erp: ErpClient,
	doctype: string,
	fields: string[],
	itemCodes: readonly string[],
	extraFilters: unknown[],
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for (const batch of assortmentMatrixItemCodeBatches(itemCodes)) {
		rows.push(...await erp.list(doctype, fields, [['item_code', 'in', batch], ...extraFilters]));
	}
	return rows;
}

async function listSelectedMatrixItems(erp: ErpClient, selected: AssortmentMatrixItemInput[]): Promise<MatrixItemRecord[]> {
	if (!selected.length) return [];
	const byId = new Map(selected.map((item) => [item.productId, item]));
	const rows: Record<string, unknown>[] = [];
	const ids = [...byId.keys()].map(String);
	for (let index = 0; index < ids.length; index += 100) {
		rows.push(...await erp.list('Item', [
			'name', 'item_name', 'is_stock_item', 'disabled', 'b24_article', 'b24_model', 'b24_brand',
		], [['name', 'in', ids.slice(index, index + 100)]]));
	}
	const items = rows.flatMap((item) => {
		const productId = Number(item['name']);
		const settings = byId.get(productId);
		if (!settings || Number(item['disabled'] ?? 0) === 1 || Number(item['is_stock_item'] ?? 0) !== 1) return [];
		return [{
			...settings,
			name: String(item['item_name'] ?? '').trim() || `#${productId}`,
			article: String(item['b24_article'] ?? '').trim(),
			model: String(item['b24_model'] ?? '').trim(),
			brand: String(item['b24_brand'] ?? '').trim(),
		}];
	});
	const found = new Set(items.map((item) => item.productId));
	const missing = selected.find((item) => !found.has(item.productId));
	if (missing) throw new Error(`товар #${missing.productId} из шаблона не найден в складском каталоге`);
	return items;
}

async function listMatrixItems(erp: ErpClient): Promise<MatrixItemRecord[]> {
	const items = await erp.list('Item', [
		'name', 'item_name', 'is_stock_item', 'disabled', 'b24_article', 'b24_model', 'b24_brand',
		MATRIX_CATEGORY_FIELD, MATRIX_SEGMENT_FIELD, MATRIX_ORDER_QTY_FIELD, MATRIX_COMMENT_FIELD,
	], [[MATRIX_ENABLED_FIELD, '=', 1], ['disabled', '=', 0], ['is_stock_item', '=', 1]]);
	return items.flatMap((item) => {
		const productId = Number(item['name']);
		if (!Number.isInteger(productId) || productId <= 0) return [];
		return [{
			productId,
			name: String(item['item_name'] ?? '').trim() || `#${productId}`,
			article: String(item['b24_article'] ?? '').trim(),
			model: String(item['b24_model'] ?? '').trim(),
			brand: String(item['b24_brand'] ?? '').trim(),
			category: String(item[MATRIX_CATEGORY_FIELD] ?? '').trim(),
			segment: String(item[MATRIX_SEGMENT_FIELD] ?? '').trim(),
			toOrderQty: Math.max(0, Number(item[MATRIX_ORDER_QTY_FIELD] ?? 0)),
			comment: String(item[MATRIX_COMMENT_FIELD] ?? '').trim(),
		}];
	});
}

export async function saveAssortmentMatrixItem(erp: ErpClient, input: {
	productId: number;
	enabled: boolean;
	category?: string;
	segment?: string;
	toOrderQty?: number;
	comment?: string;
}): Promise<void> {
	await ensureAssortmentMatrixFields(erp);
	const item = await erp.get<Record<string, unknown>>('Item', String(input.productId));
	if (!item || Number(item['disabled'] ?? 0) === 1 || Number(item['is_stock_item'] ?? 0) !== 1) {
		throw new Error('товар не найден в складском каталоге');
	}
	const category = String(input.category ?? '').trim().slice(0, 140);
	const segment = String(input.segment ?? '').trim().slice(0, 140);
	const comment = String(input.comment ?? '').trim().slice(0, 1000);
	const toOrderQty = Number(input.toOrderQty ?? 0);
	if (input.enabled && (!category || !segment)) throw new Error('выбери категорию и укажи сегмент');
	if (!Number.isFinite(toOrderQty) || toOrderQty < 0) throw new Error('количество «К заказу» должно быть неотрицательным');
	await erp.update('Item', String(input.productId), {
		[MATRIX_ENABLED_FIELD]: input.enabled ? 1 : 0,
		[MATRIX_CATEGORY_FIELD]: category,
		[MATRIX_SEGMENT_FIELD]: segment,
		[MATRIX_ORDER_QTY_FIELD]: round(toOrderQty),
		[MATRIX_COMMENT_FIELD]: comment,
	});
}

export async function buildAssortmentMatrixReport(erp: ErpClient, input: {
	from: string;
	to: string;
	selectedStores?: string[];
	salesScope: MatrixSalesScope;
	items?: AssortmentMatrixItemInput[];
}): Promise<AssortmentMatrixReport> {
	if (input.items === undefined) await ensureAssortmentMatrixFields(erp);
	const [stores, items] = await Promise.all([
		listActiveStoreTitles(erp),
		input.items === undefined ? listMatrixItems(erp) : listSelectedMatrixItems(erp, input.items),
	]);
	const requested = [...new Set((input.selectedStores ?? []).map((store) => store.trim()).filter(Boolean))];
	const unknown = requested.filter((store) => !stores.includes(store));
	if (unknown.length) throw new Error(`склад не найден: ${unknown[0]}`);
	const selectedStores = requested.length ? requested : stores;
	const periodDays = Math.floor((Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86400000) + 1;
	if (!items.length) return {
		rows: [], stores, selectedStores, salesScope: input.salesScope, periodDays,
		targetDays: ASSORTMENT_MATRIX_TARGET_DAYS, generatedAt: new Date().toISOString(),
	};

	const ctx = await erpContext(erp);
	const itemCodes = items.map((item) => String(item.productId));
	const stockWarehouses = selectedStores.map((store) => erpWarehouse(ctx, store));
	const salesStores = input.salesScope === 'all' ? stores : selectedStores;
	const salesWarehouses = salesStores.map((store) => erpWarehouse(ctx, store));
	const [bins, ledger, ordered] = await Promise.all([
		listMatrixRowsByItemCodes(erp, 'Bin', ['item_code', 'warehouse', 'actual_qty', 'reserved_qty'], itemCodes, [
			['warehouse', 'in', stockWarehouses],
		]),
		listMatrixRowsByItemCodes(erp, 'Stock Ledger Entry', ['item_code', 'warehouse', 'actual_qty'], itemCodes, [
			['warehouse', 'in', salesWarehouses],
			['posting_date', '>=', input.from], ['posting_date', '<=', input.to],
			['voucher_type', '=', 'Delivery Note'], ['is_cancelled', '=', 0],
		]),
		fetchOutstandingOrderedQuantities(erp, items.map((item) => item.productId)),
	]);

	const storeByWarehouse = new Map(selectedStores.map((store) => [erpWarehouse(ctx, store), store]));
	const stocksByProduct = new Map<number, Record<string, number>>();
	const reservedByProduct = new Map<number, number>();
	for (const bin of bins) {
		const productId = Number(bin['item_code']);
		const store = storeByWarehouse.get(String(bin['warehouse'] ?? ''));
		if (!store || !Number.isInteger(productId)) continue;
		const stocks = stocksByProduct.get(productId) ?? {};
		stocks[store] = round((stocks[store] ?? 0) + Number(bin['actual_qty'] ?? 0));
		stocksByProduct.set(productId, stocks);
		reservedByProduct.set(productId, (reservedByProduct.get(productId) ?? 0) + Number(bin['reserved_qty'] ?? 0));
	}
	const deliveryNetByProduct = new Map<number, number>();
	for (const movement of ledger) {
		const productId = Number(movement['item_code']);
		if (!Number.isInteger(productId)) continue;
		deliveryNetByProduct.set(productId, (deliveryNetByProduct.get(productId) ?? 0) + Number(movement['actual_qty'] ?? 0));
	}

	const rows = items.map((item): AssortmentMatrixRow => {
		const stocks = Object.fromEntries(selectedStores.map((store) => [store, round(stocksByProduct.get(item.productId)?.[store] ?? 0)]));
		const totalStock = round(Object.values(stocks).reduce((sum, qty) => sum + qty, 0));
		const reservedQty = round(reservedByProduct.get(item.productId) ?? 0);
		const freeQty = round(totalStock - reservedQty);
		const orderedQty = round(ordered.get(item.productId) ?? 0);
		const soldQty = round(Math.max(0, -(deliveryNetByProduct.get(item.productId) ?? 0)));
		return {
			...item,
			stocks,
			totalStock,
			reservedQty,
			freeQty,
			orderedQty,
			soldQty,
			recommendedQty: matrixRecommendation({ soldQty, periodDays, freeQty, orderedQty }),
		};
	}).sort((left, right) =>
		left.category.localeCompare(right.category, 'ru')
		|| left.segment.localeCompare(right.segment, 'ru')
		|| left.name.localeCompare(right.name, 'ru'));

	return {
		rows, stores, selectedStores, salesScope: input.salesScope, periodDays,
		targetDays: ASSORTMENT_MATRIX_TARGET_DAYS, generatedAt: new Date().toISOString(),
	};
}
