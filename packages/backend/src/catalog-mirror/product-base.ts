import type { CatalogProductContent } from '../catalog-content.js';
import { coreStoreId } from '../erp/stock-catalog.js';
import type { CatalogStore, CoreProductBaseRow } from '../routes/api-catalog-types.js';
import type { CatalogMirrorPlan } from './model.js';

/** Converts the normalized SQL mirror into the existing catalog API contract. */
export function buildSqlProductBase(plan: CatalogMirrorPlan): {
	data: { rows: CoreProductBaseRow[]; generatedAt: string };
	stores: CatalogStore[];
} {
	const stores = plan.warehouses
		.filter((warehouse) => warehouse.active)
		.map((warehouse) => ({ id: coreStoreId(warehouse.displayTitle), title: warehouse.displayTitle, active: true }))
		.sort((left, right) => left.title.localeCompare(right.title, 'ru'));
	const storeIdByWarehouse = new Map(plan.warehouses.map((warehouse) => [warehouse.warehouseName, coreStoreId(warehouse.displayTitle)]));
	const attributesByItem = new Map<number, CatalogMirrorPlan['attributes']>();
	for (const attribute of plan.attributes) {
		const rows = attributesByItem.get(attribute.itemCode) ?? [];
		rows.push(attribute);
		attributesByItem.set(attribute.itemCode, rows);
	}
	const pricesByItem = new Map<number, { retail?: number; purchase?: number }>();
	for (const price of plan.prices) {
		const current = pricesByItem.get(price.itemCode) ?? {};
		current[price.priceKind] = price.rate;
		pricesByItem.set(price.itemCode, current);
	}
	const stocksByItem = new Map<number, Record<number, number>>();
	for (const stock of plan.stocks) {
		const storeId = storeIdByWarehouse.get(stock.warehouseName);
		if (storeId === undefined) continue;
		const current = stocksByItem.get(stock.itemCode) ?? {};
		current[storeId] = (current[storeId] ?? 0) + stock.actualQty;
		stocksByItem.set(stock.itemCode, current);
	}

	const rows = plan.products.map((product): CoreProductBaseRow => {
		const price = pricesByItem.get(product.itemCode);
		const stockByStore = stocksByItem.get(product.itemCode) ?? {};
		const sectionName = product.sectionName || undefined;
		const attributes = (attributesByItem.get(product.itemCode) ?? [])
			.sort((left, right) => left.attributeOrdinal - right.attributeOrdinal)
			.map(({ sourceHash: _sourceHash, itemCode: _itemCode, attributeOrdinal: _attributeOrdinal, ...attribute }) => ({
				id: attribute.attributeId,
				key: attribute.attributeKey,
				label: attribute.attributeLabel,
				group: attribute.attributeGroup,
				type: attribute.attributeType,
				rawValue: attribute.rawValue,
				normalizedValue: attribute.normalizedValue,
				numberValue: attribute.numberValue,
				numberMin: attribute.numberMin,
				numberMax: attribute.numberMax,
				unit: attribute.unit,
				booleanValue: attribute.booleanValue,
				filterable: attribute.filterable,
			}));
		const content: CatalogProductContent | undefined = product.contentSummary || attributes.length
			? { version: 1, summary: product.contentSummary, attributes }
			: undefined;
		return {
			id: product.itemCode,
			iblockId: product.bitrixIblockId,
			name: product.itemName,
			isService: !product.isStockItem,
			isMarketplaceBundle: product.isMarketplaceBundle,
			article: product.article || undefined,
			model: product.model || undefined,
			manufacturer: product.brand || undefined,
			sectionId: product.bitrixSectionId ?? undefined,
			sectionName,
			status: product.productStatus || undefined,
			description: product.description || undefined,
			...(content ? { content } : {}),
			filterCategory: product.filterCategory,
			marketplaceOldId: product.marketplaceOldId,
			retail: price?.retail ?? null,
			purchase: price?.purchase ?? null,
			photoPath: product.imagePath
				? product.imageSource === 'erpnext'
					? `/api/inventory/erp-image?p=${encodeURIComponent(product.imagePath)}`
					: product.imagePath
				: undefined,
			total: Object.values(stockByStore).reduce((sum, quantity) => sum + quantity, 0),
			stockByStore,
		};
	}).sort((left, right) => left.name.localeCompare(right.name, 'ru'));
	return { data: { rows, generatedAt: plan.observedAt }, stores };
}
