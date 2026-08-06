import { ErpClient } from './client.js';
import { TECH_SUPPLIER, UOM } from './erp-setup.js';
import {
	MARKETPLACE_BUNDLE_SOURCE_FIELD,
	MARKETPLACE_OLD_ID_FIELD,
	ensureMarketplaceFields,
	ensureMarketplaceOldIdField,
} from './marketplace-fields.js';
import { b24StoreTitle, erpContext } from './warehouse-context.js';
import { parseCatalogContent, type CatalogProductContent } from '../catalog-content.js';
import { splitCatalogProductNameStatus } from '../catalog-product-status.js';

export const ITEM_GROUP = 'Каталог Б24';
export const REALIZATION_SEGMENT_FIELD = 'b24_deal_segment';
export const CORE_ENGINEER_VISIT_SERVICE_ID = 9814001;

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
	description?: string;
}): Promise<void> {
	const code = String(args.productId);
	const existing = await erp.get<Record<string, unknown>>('Item', code);
	if (existing) {
		const patch: Record<string, unknown> = {};
		const hasStructuredMeta = args.model !== undefined || args.article !== undefined || args.brand !== undefined || args.section !== undefined || args.description !== undefined;
		if (args.isService && Number(existing['is_stock_item'] ?? 1) !== 0) patch['is_stock_item'] = 0;
		if (hasStructuredMeta && args.name && String(existing['item_name'] ?? '') !== args.name) patch['item_name'] = args.name.slice(0, 140);
		if (args.model !== undefined) patch['b24_model'] = args.model;
		if (args.article !== undefined) patch['b24_article'] = args.article;
		if (args.brand !== undefined) patch['b24_brand'] = args.brand;
		if (args.section !== undefined) patch['b24_section'] = args.section;
		if (args.description !== undefined) patch['description'] = args.description;
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
		description: args.description?.trim() || `Б24 productId=${args.productId}`,
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
 *  компактный ответ вместо чтения всего Bin: полный каталог избыточен для точечной проверки. */
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
	const realizationSegmentField = `Delivery Note Item-${REALIZATION_SEGMENT_FIELD}`;
	if (!(await erp.get('Custom Field', realizationSegmentField))) {
		await erp.create('Custom Field', {
			dt: 'Delivery Note Item',
			fieldname: REALIZATION_SEGMENT_FIELD,
			label: 'B24 Deal Segment',
			fieldtype: 'Data',
			insert_after: 'item_code',
			in_list_view: 1,
		});
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

export interface CoreCatalogItem {
	productId: number;
	name: string;
	isService: boolean;
	isMarketplaceBundle: boolean;
	article: string;
	model: string;
	manufacturer: string;
	section: string;
	status: string;
	description: string;
	content?: CatalogProductContent;
	filterCategory: string;
	image: string;
	marketplaceOldId: string;
}

function isTechnicalCoreDescription(value: unknown): boolean {
	return /^Б24\s+productId=\d+\b(?:\s*\([^)]*\))?\.?$/iu.test(String(value ?? '').trim());
}

/** Полный товарный справочник ядра. Складские экраны не должны зависеть от наличия строки в каталоге Б24. */
export async function fetchCoreCatalogItems(erp: ErpClient): Promise<CoreCatalogItem[]> {
	await ensureMarketplaceFields(erp);
	await ensureMarketplaceOldIdField(erp);
	const rows = await erp.list('Item', [
		'name', 'item_name', 'is_stock_item',
		'b24_article', 'b24_model', 'b24_brand', 'b24_section', 'b24_product_status',
		'b24_catalog_content', 'b24_filter_category', 'description', 'image',
		MARKETPLACE_BUNDLE_SOURCE_FIELD, MARKETPLACE_OLD_ID_FIELD,
	], [['item_group', '=', ITEM_GROUP], ['disabled', '=', 0]]);
	const out: CoreCatalogItem[] = [];
	for (const row of rows) {
		const productId = Number(row['name']);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		const content = parseCatalogContent(row['b24_catalog_content']);
		const normalizedIdentity = splitCatalogProductNameStatus(
			row['item_name'],
			row['b24_product_status'],
		);
		out.push({
			productId,
			name: normalizedIdentity.name || `#${productId}`,
			isService: Number(row['is_stock_item'] ?? 1) === 0,
			isMarketplaceBundle: Boolean(String(row[MARKETPLACE_BUNDLE_SOURCE_FIELD] ?? '').trim()),
			article: String(row['b24_article'] ?? '').trim(),
			model: String(row['b24_model'] ?? '').trim(),
			manufacturer: String(row['b24_brand'] ?? '').trim(),
			section: String(row['b24_section'] ?? '').trim(),
			status: normalizedIdentity.status,
			description: isTechnicalCoreDescription(row['description'])
				? ''
				: String(row['description'] ?? '').trim(),
			...(content ? { content } : {}),
			filterCategory: String(row['b24_filter_category'] ?? '').trim(),
			image: String(row['image'] ?? '').trim(),
			marketplaceOldId: String(row[MARKETPLACE_OLD_ID_FIELD] ?? '').trim(),
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Сохранить вручную проверенный старый ID. Один старый ID нельзя назначить двум действующим товарам. */
export async function updateMarketplaceOldId(
	erp: ErpClient,
	args: { productId: number; oldId: string },
): Promise<string> {
	await ensureMarketplaceOldIdField(erp);
	const itemCode = String(args.productId);
	if (!(await erp.get('Item', itemCode))) throw new Error(`товар #${args.productId} не найден в ядре`);
	const oldId = String(args.oldId ?? '').trim();
	if (oldId.length > 120) throw new Error('старый ID не должен быть длиннее 120 символов');
	if (oldId) {
		const matches = await erp.list('Item', ['name', 'item_name'], [
			[MARKETPLACE_OLD_ID_FIELD, '=', oldId],
			['disabled', '=', 0],
		], 2);
		const duplicate = matches.find((item) => String(item['name']) !== itemCode);
		if (duplicate) {
			throw new Error(`старый ID «${oldId}» уже указан у товара #${String(duplicate['name'])} ${String(duplicate['item_name'] ?? '')}`.trim());
		}
	}
	await erp.update('Item', itemCode, { [MARKETPLACE_OLD_ID_FIELD]: oldId });
	return oldId;
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

/** Стабильный числовой ID склада ядра для старых компонентов интерфейса, ожидающих number. */
export function coreStoreId(title: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < title.length; i++) {
		hash ^= title.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return -((hash >>> 0) + 1);
}
