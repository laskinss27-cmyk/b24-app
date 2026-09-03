import { ErpClient } from './client.js';
import { TECH_CUSTOMER, ensureErpSetup } from './erp-setup.js';
import { fetchErpStoreStock } from './inventory-reconciliation.js';
import {
	MARKETPLACE_BUNDLE_SOURCE_FIELD,
	MARKETPLACE_BUNDLE_UNITS_FIELD,
	MARKETPLACE_NAME_FIELD,
	MARKETPLACE_OPERATION_FIELD,
	MARKETPLACE_TITLE_FIELD,
	ensureMarketplaceFields,
} from './marketplace-fields.js';
import { ensureCoreItem, updateCoreCatalogPrices } from './stock-catalog.js';
import { b24StoreTitle, erpContext, erpWarehouse } from './warehouse-context.js';

export type MarketplaceOperationKind = 'sale' | 'bundle' | 'return' | 'writeoff' | 'receipt';

export interface MarketplaceOperationItem {
	productId: number;
	itemName: string;
	marketplaceOldId?: string;
	isMarketplaceBundle?: boolean;
	quantity: number;
	rate: number;
	amount: number;
	direction: 'out' | 'in';
	storeTitle: string;
}

export interface MarketplaceOperation {
	name: string;
	title: string;
	operation: MarketplaceOperationKind;
	marketplace: string;
	date: string;
	storeTitle: string;
	submitted: boolean;
	total: number;
	itemCount: number;
	quantity: number;
	items: MarketplaceOperationItem[];
}

export interface MarketplaceReturnOption {
	saleName: string;
	saleTitle: string;
	marketplace: string;
	saleDate: string;
	productId: number;
	itemName: string;
	soldQty: number;
	returnedQty: number;
	availableQty: number;
}

export interface MarketplaceReturnSaleItem {
	productId: number;
	itemName: string;
	marketplaceOldId?: string;
	isMarketplaceBundle?: boolean;
	soldQty: number;
	returnedQty: number;
	availableQty: number;
}

export interface MarketplaceReturnSale {
	saleName: string;
	saleTitle: string;
	marketplace: string;
	saleDate: string;
	items: MarketplaceReturnSaleItem[];
}

export function marketplaceSaleTitle(postingDate: string, marketplace: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(postingDate);
	if (!match) throw new Error('некорректная дата реализации');
	return `${match[3]}.${match[2]}.${match[1]!.slice(2)}_${marketplace.trim()}`;
}

/** Marketplace sale is an independent submitted Delivery Note without a deal link. */
export async function createMarketplaceSale(
	erp: ErpClient,
	args: {
		marketplace: string;
		storeTitle: string;
		postingDate: string;
		lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>;
	},
): Promise<{ name: string; title: string }> {
	const marketplace = args.marketplace.trim();
	const storeTitle = args.storeTitle.trim();
	if (!marketplace) throw new Error('не выбран маркетплейс');
	if (!storeTitle) throw new Error('не выбран склад списания');
	if (!args.lines.length) throw new Error('в реализации нет товаров');
	if (args.lines.some((line) =>
		!Number.isInteger(line.productId) || line.productId <= 0 || !(line.qty > 0) || line.rate < 0)) {
		throw new Error('в реализации есть некорректная строка');
	}

	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	await ensureMarketplaceFields(erp);
	const title = marketplaceSaleTitle(args.postingDate, marketplace);
	for (const line of args.lines) {
		await ensureCoreItem(erp, { productId: line.productId, name: line.itemName || `#${line.productId}` });
	}
	const doc = await erp.create('Delivery Note', {
		company: ctx.company,
		customer: TECH_CUSTOMER,
		set_posting_time: 1,
		posting_date: args.postingDate,
		[MARKETPLACE_OPERATION_FIELD]: 'sale',
		[MARKETPLACE_NAME_FIELD]: marketplace,
		[MARKETPLACE_TITLE_FIELD]: title,
		items: args.lines.map((line) => ({
			item_code: String(line.productId),
			qty: line.qty,
			warehouse: erpWarehouse(ctx, storeTitle),
			rate: line.rate,
			price_list_rate: line.rate,
		})),
	});
	const name = String(doc['name'] ?? '');
	if (!name) throw new Error('ядро не вернуло номер реализации');
	await erp.submit('Delivery Note', name);
	return { name, title };
}

type MarketplaceReturnSource = {
	saleName: string;
	saleTitle: string;
	marketplace: string;
	saleDate: string;
	productId: number;
	itemName: string;
	rowName: string;
	rate: number;
	soldQty: number;
	remainingQty: number;
};

async function marketplaceReturnSources(erp: ErpClient): Promise<MarketplaceReturnSource[]> {
	await ensureMarketplaceFields(erp);
	const heads = await erp.list('Delivery Note', [
		'name',
		'posting_date',
		'docstatus',
		'is_return',
		'return_against',
		MARKETPLACE_OPERATION_FIELD,
		MARKETPLACE_NAME_FIELD,
		MARKETPLACE_TITLE_FIELD,
	], [
		['docstatus', '=', 1],
		[MARKETPLACE_OPERATION_FIELD, '!=', ''],
	], 0, 'posting_date asc, creation asc');
	const documents: Array<Record<string, unknown>> = [];
	for (const head of heads) {
		if (Number(head['docstatus'] ?? 0) !== 1) continue;
		const name = String(head['name'] ?? '');
		const document = name ? await erp.get<Record<string, unknown>>('Delivery Note', name) : null;
		if (document && Number(document['docstatus'] ?? head['docstatus'] ?? 0) === 1) documents.push(document);
	}

	const sources: MarketplaceReturnSource[] = [];
	for (const document of documents) {
		if (String(document[MARKETPLACE_OPERATION_FIELD] ?? '') !== 'sale' || Number(document['is_return'] ?? 0) === 1) continue;
		const saleName = String(document['name'] ?? '');
		const saleDate = String(document['posting_date'] ?? '');
		const marketplace = String(document[MARKETPLACE_NAME_FIELD] ?? '');
		const saleTitle = String(document[MARKETPLACE_TITLE_FIELD] ?? '') || `${saleDate}_${marketplace}`;
		const items = Array.isArray(document['items']) ? document['items'] as Array<Record<string, unknown>> : [];
		for (const item of items) {
			const productId = Number(item['item_code']);
			const soldQty = Number(item['qty'] ?? 0);
			if (!Number.isInteger(productId) || productId <= 0 || soldQty <= 0) continue;
			sources.push({
				saleName,
				saleTitle,
				marketplace,
				saleDate,
				productId,
				itemName: String(item['item_name'] ?? '') || `#${productId}`,
				rowName: String(item['name'] ?? ''),
				rate: Math.max(Number(item['rate'] ?? item['price_list_rate'] ?? 0), 0),
				soldQty,
				remainingQty: soldQty,
			});
		}
	}

	for (const document of documents) {
		if (String(document[MARKETPLACE_OPERATION_FIELD] ?? '') !== 'return' && Number(document['is_return'] ?? 0) !== 1) continue;
		const returnAgainst = String(document['return_against'] ?? '');
		if (!returnAgainst) continue;
		const items = Array.isArray(document['items']) ? document['items'] as Array<Record<string, unknown>> : [];
		for (const item of items) {
			const productId = Number(item['item_code']);
			let returnedQty = Math.abs(Number(item['qty'] ?? 0));
			const sourceRow = String(item['dn_detail'] ?? '');
			if (!Number.isInteger(productId) || productId <= 0 || returnedQty <= 0) continue;
			const candidates = sources.filter((source) =>
				source.saleName === returnAgainst
				&& source.productId === productId
				&& (!sourceRow || source.rowName === sourceRow)
				&& source.remainingQty > 0.000001);
			for (const source of candidates) {
				const used = Math.min(source.remainingQty, returnedQty);
				source.remainingQty -= used;
				returnedQty -= used;
				if (returnedQty <= 0.000001) break;
			}
		}
	}
	return sources;
}

/** Submitted marketplace sales containing a product, reduced by earlier marketplace returns. */
export async function listMarketplaceReturnOptions(
	erp: ErpClient,
	productId: number,
): Promise<MarketplaceReturnOption[]> {
	if (!Number.isInteger(productId) || productId <= 0) throw new Error('неверный товар для возврата');
	const grouped = new Map<string, MarketplaceReturnOption>();
	for (const source of await marketplaceReturnSources(erp)) {
		if (source.productId !== productId) continue;
		const current = grouped.get(source.saleName) ?? {
			saleName: source.saleName,
			saleTitle: source.saleTitle,
			marketplace: source.marketplace,
			saleDate: source.saleDate,
			productId: source.productId,
			itemName: source.itemName,
			soldQty: 0,
			returnedQty: 0,
			availableQty: 0,
		};
		current.soldQty += source.soldQty;
		current.availableQty += source.remainingQty;
		current.returnedQty = current.soldQty - current.availableQty;
		grouped.set(source.saleName, current);
	}
	return [...grouped.values()]
		.filter((option) => option.availableQty > 0.000001)
		.sort((left, right) => `${right.saleDate}:${right.saleName}`.localeCompare(`${left.saleDate}:${left.saleName}`));
}

/** Submitted marketplace sales and their still-returnable composition. */
export async function listMarketplaceReturnSales(erp: ErpClient): Promise<MarketplaceReturnSale[]> {
	const sales = new Map<string, MarketplaceReturnSale & { itemMap: Map<number, MarketplaceReturnSaleItem> }>();
	for (const source of await marketplaceReturnSources(erp)) {
		const sale = sales.get(source.saleName) ?? {
			saleName: source.saleName,
			saleTitle: source.saleTitle,
			marketplace: source.marketplace,
			saleDate: source.saleDate,
			items: [],
			itemMap: new Map<number, MarketplaceReturnSaleItem>(),
		};
		const item = sale.itemMap.get(source.productId) ?? {
			productId: source.productId,
			itemName: source.itemName,
			soldQty: 0,
			returnedQty: 0,
			availableQty: 0,
		};
		item.soldQty += source.soldQty;
		item.availableQty += source.remainingQty;
		item.returnedQty = item.soldQty - item.availableQty;
		sale.itemMap.set(source.productId, item);
		sales.set(source.saleName, sale);
	}
	return [...sales.values()]
		.map(({ itemMap, ...sale }) => ({
			...sale,
			items: [...itemMap.values()].filter((item) => item.availableQty > 0.000001),
		}))
		.filter((sale) => sale.items.length > 0)
		.sort((left, right) => `${right.saleDate}:${right.saleName}`.localeCompare(`${left.saleDate}:${left.saleName}`));
}

/** Return several selected products against one marketplace Delivery Note. */
export async function createMarketplaceReturnBatch(
	erp: ErpClient,
	args: {
		saleName: string;
		lines: Array<{ productId: number; qty: number }>;
		storeTitle: string;
		postingDate: string;
	},
): Promise<{ name: string; title: string; marketplace: string; total: number; quantity: number; itemCount: number }> {
	const saleName = args.saleName.trim();
	const storeTitle = args.storeTitle.trim();
	if (!saleName) throw new Error('не выбрана исходная реализация');
	if (!args.lines.length) throw new Error('не выбраны товары для возврата');
	if (args.lines.some((line) =>
		!Number.isInteger(line.productId) || line.productId <= 0 || !(line.qty > 0))) {
		throw new Error('в возврате есть некорректная строка');
	}
	if (new Set(args.lines.map((line) => line.productId)).size !== args.lines.length) {
		throw new Error('товар в возврате указан несколько раз');
	}
	if (!storeTitle) throw new Error('не выбран склад возврата');
	const dateTitle = marketplaceSaleTitle(args.postingDate, 'Возврат');
	const saleSources = (await marketplaceReturnSources(erp))
		.filter((source) => source.saleName === saleName && source.remainingQty > 0.000001);
	if (!saleSources.length) throw new Error('выбранная реализация уже полностью возвращена или не найдена');

	const returnLines: Array<{ qty: number; source: MarketplaceReturnSource }> = [];
	for (const requested of args.lines) {
		const sources = saleSources.filter((source) => source.productId === requested.productId);
		const availableQty = sources.reduce((sum, source) => sum + source.remainingQty, 0);
		if (requested.qty > availableQty + 0.000001) {
			throw new Error(`для товара #${requested.productId} доступно для возврата ${availableQty}, запрошено ${requested.qty}`);
		}
		let qtyLeft = requested.qty;
		for (const source of sources) {
			const qty = Math.min(source.remainingQty, qtyLeft);
			if (qty > 0.000001) returnLines.push({ qty, source });
			qtyLeft -= qty;
			if (qtyLeft <= 0.000001) break;
		}
	}
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	await ensureMarketplaceFields(erp);
	const marketplace = saleSources[0]!.marketplace;
	const title = `${dateTitle}_${marketplace}`;
	const total = returnLines.reduce((sum, line) => sum + line.qty * line.source.rate, 0);
	const quantity = args.lines.reduce((sum, line) => sum + line.qty, 0);
	const document = await erp.create('Delivery Note', {
		company: ctx.company,
		customer: TECH_CUSTOMER,
		is_return: 1,
		return_against: saleName,
		set_posting_time: 1,
		posting_date: args.postingDate,
		[MARKETPLACE_OPERATION_FIELD]: 'return',
		[MARKETPLACE_NAME_FIELD]: marketplace,
		[MARKETPLACE_TITLE_FIELD]: title,
		items: returnLines.map(({ qty, source }) => ({
			item_code: String(source.productId),
			qty: -Math.abs(qty),
			warehouse: erpWarehouse(ctx, storeTitle),
			dn_detail: source.rowName,
			rate: source.rate,
			price_list_rate: source.rate,
		})),
	});
	const name = String(document['name'] ?? '');
	if (!name) throw new Error('ядро не вернуло номер возврата');
	try {
		await erp.submit('Delivery Note', name);
	} catch (error) {
		await erp.delete('Delivery Note', name).catch(() => undefined);
		throw error;
	}
	return { name, title, marketplace, total: -total, quantity, itemCount: args.lines.length };
}

/** Backward-compatible single-line marketplace return. */
export async function createMarketplaceReturn(
	erp: ErpClient,
	args: {
		saleName: string;
		productId: number;
		qty: number;
		storeTitle: string;
		postingDate: string;
	},
): Promise<{ name: string; title: string; marketplace: string; itemName: string; rate: number; total: number }> {
	const source = (await marketplaceReturnSources(erp)).find((item) =>
		item.saleName === args.saleName.trim()
		&& item.productId === args.productId
		&& item.remainingQty > 0.000001);
	const result = await createMarketplaceReturnBatch(erp, {
		saleName: args.saleName,
		lines: [{ productId: args.productId, qty: args.qty }],
		storeTitle: args.storeTitle,
		postingDate: args.postingDate,
	});
	return {
		name: result.name,
		title: result.title,
		marketplace: result.marketplace,
		itemName: source?.itemName ?? `#${args.productId}`,
		rate: args.qty > 0 ? Math.abs(result.total) / args.qty : 0,
		total: result.total,
	};
}

/** Convert several units of one item into a stock item representing a marketplace bundle. */
export async function createMarketplaceBundle(
	erp: ErpClient,
	args: {
		sourceProductId: number;
		sourceItemName: string;
		bundleProductId: number;
		bundleItemName: string;
		sourceRetailPrice: number;
		unitsPerBundle: number;
		bundleQty: number;
		storeTitle: string;
		postingDate: string;
	},
): Promise<{ name: string; title: string; sourceQty: number; bundleRetailPrice: number }> {
	if (!Number.isInteger(args.sourceProductId) || args.sourceProductId <= 0) throw new Error('неверный исходный товар');
	if (!Number.isInteger(args.bundleProductId) || args.bundleProductId <= 0) throw new Error('неверная позиция комплекта');
	if (!Number.isFinite(args.sourceRetailPrice) || args.sourceRetailPrice <= 0) throw new Error('у исходного товара не указана розничная цена');
	if (!Number.isInteger(args.unitsPerBundle) || args.unitsPerBundle < 2) throw new Error('в комплекте должно быть не меньше двух штук');
	if (!Number.isInteger(args.bundleQty) || args.bundleQty < 1) throw new Error('количество комплектов должно быть целым и больше нуля');
	const storeTitle = args.storeTitle.trim();
	if (!storeTitle) throw new Error('не выбран склад комплектации');
	const sourceQty = args.unitsPerBundle * args.bundleQty;
	const bundleRetailPrice = Math.round(args.sourceRetailPrice * args.unitsPerBundle * 100) / 100;
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	await ensureMarketplaceFields(erp);
	await ensureCoreItem(erp, {
		productId: args.sourceProductId,
		name: args.sourceItemName || `#${args.sourceProductId}`,
	});
	await ensureCoreItem(erp, {
		productId: args.bundleProductId,
		name: args.bundleItemName || `#${args.bundleProductId}`,
	});
	await erp.update('Item', String(args.bundleProductId), {
		[MARKETPLACE_BUNDLE_SOURCE_FIELD]: String(args.sourceProductId),
		[MARKETPLACE_BUNDLE_UNITS_FIELD]: args.unitsPerBundle,
	});
	await updateCoreCatalogPrices(erp, {
		productId: args.bundleProductId,
		retail: bundleRetailPrice,
	});

	const stock = await fetchErpStoreStock(erp, storeTitle);
	const valuation = Math.max(Number(stock.get(args.sourceProductId)?.valuation ?? 0), 0.01);
	const title = marketplaceSaleTitle(args.postingDate, args.bundleItemName);
	const warehouse = erpWarehouse(ctx, storeTitle);
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Repack',
		purpose: 'Repack',
		set_posting_time: 1,
		posting_date: args.postingDate,
		[MARKETPLACE_OPERATION_FIELD]: 'bundle',
		[MARKETPLACE_TITLE_FIELD]: title,
		items: [
			{
				item_code: String(args.sourceProductId),
				qty: sourceQty,
				s_warehouse: warehouse,
				basic_rate: valuation,
			},
			{
				item_code: String(args.bundleProductId),
				qty: args.bundleQty,
				t_warehouse: warehouse,
				is_finished_item: 1,
				basic_rate: valuation * args.unitsPerBundle,
				valuation_rate: valuation * args.unitsPerBundle,
			},
		],
	});
	const name = String(doc['name'] ?? '');
	if (!name) throw new Error('ядро не вернуло номер формирования комплекта');
	try {
		await erp.submit('Stock Entry', name);
	} catch (error) {
		await erp.delete('Stock Entry', name).catch(() => undefined);
		throw error;
	}
	return { name, title, sourceQty, bundleRetailPrice };
}

/** All marketplace operations are tagged and therefore never mixed with ordinary deal documents. */
export async function listMarketplaceOperations(
	erp: ErpClient,
	opts: { from?: string; to?: string; limit?: number } = {},
): Promise<MarketplaceOperation[]> {
	const ctx = await erpContext(erp);
	await ensureMarketplaceFields(erp);
	const filters: unknown[] = [
		['docstatus', '!=', 2],
		[MARKETPLACE_OPERATION_FIELD, '!=', ''],
	];
	if (opts.from) filters.push(['posting_date', '>=', opts.from]);
	if (opts.to) filters.push(['posting_date', '<=', opts.to]);
	const rows: MarketplaceOperation[] = [];
	for (const doctype of ['Delivery Note', 'Stock Entry'] as const) {
		const fields = [
			'name',
			'posting_date',
			'docstatus',
			MARKETPLACE_OPERATION_FIELD,
			MARKETPLACE_NAME_FIELD,
			MARKETPLACE_TITLE_FIELD,
			...(doctype === 'Delivery Note' ? ['grand_total'] : []),
		];
		const heads = await erp.list(doctype, fields, filters, opts.limit ?? 200, 'posting_date desc, creation desc');
		for (const head of heads) {
			const name = String(head['name'] ?? '');
			if (!name) continue;
			const doc = await erp.get<Record<string, unknown>>(doctype, name);
			if (!doc) continue;
			const items = Array.isArray(doc['items']) ? doc['items'] as Array<Record<string, unknown>> : [];
			const operation = String(doc[MARKETPLACE_OPERATION_FIELD] ?? head[MARKETPLACE_OPERATION_FIELD] ?? '') as MarketplaceOperationKind;
			if (!['sale', 'bundle', 'return', 'writeoff', 'receipt'].includes(operation)) continue;
			const marketplace = String(doc[MARKETPLACE_NAME_FIELD] ?? head[MARKETPLACE_NAME_FIELD] ?? '');
			const date = String(doc['posting_date'] ?? head['posting_date'] ?? '');
			const operationItems = operation === 'bundle'
				? items.filter((item) => String(item['t_warehouse'] ?? ''))
				: items;
			const firstWarehouse = String(operationItems[0]?.['warehouse']
				?? operationItems[0]?.['t_warehouse']
				?? operationItems[0]?.['s_warehouse']
				?? '');
			const documentItems: MarketplaceOperationItem[] = items.map((item) => {
				const sourceWarehouse = String(item['s_warehouse'] ?? '');
				const targetWarehouse = String(item['t_warehouse'] ?? '');
				const warehouse = String(item['warehouse'] ?? '') || targetWarehouse || sourceWarehouse;
				const direction: MarketplaceOperationItem['direction'] = targetWarehouse
					? 'in'
					: sourceWarehouse
						? 'out'
						: operation === 'return' || operation === 'receipt'
							? 'in'
							: 'out';
				const quantity = Math.abs(Number(item['qty'] ?? 0));
				const rate = Math.abs(Number(item['rate'] ?? item['basic_rate'] ?? item['valuation_rate'] ?? 0));
				const explicitAmount = Number(item['amount'] ?? item['basic_amount']);
				return {
					productId: Number(item['item_code'] ?? 0),
					itemName: String(item['item_name'] ?? item['description'] ?? '').trim()
						|| `#${String(item['item_code'] ?? '')}`,
					quantity,
					rate,
					amount: Math.abs(Number.isFinite(explicitAmount) ? explicitAmount : quantity * rate),
					direction,
					storeTitle: warehouse ? b24StoreTitle(ctx, warehouse) : '',
				};
			});
			rows.push({
				name,
				title: String(doc[MARKETPLACE_TITLE_FIELD] ?? head[MARKETPLACE_TITLE_FIELD] ?? '') || `${date}_${marketplace}`,
				operation,
				marketplace,
				date,
				storeTitle: firstWarehouse ? b24StoreTitle(ctx, firstWarehouse) : '',
				submitted: Number(doc['docstatus'] ?? head['docstatus'] ?? 0) === 1,
				total: Number(doc['grand_total'] ?? head['grand_total'] ?? 0),
				itemCount: operationItems.length,
				quantity: operationItems.reduce((sum, item) => sum + Math.abs(Number(item['qty'] ?? 0)), 0),
				items: documentItems,
			});
		}
	}
	return rows
		.sort((left, right) => `${right.date}:${right.name}`.localeCompare(`${left.date}:${left.name}`))
		.slice(0, opts.limit ?? 200);
}
