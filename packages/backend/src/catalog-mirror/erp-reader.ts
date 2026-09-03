import { parseCatalogContent } from '../catalog-content.js';
import { splitCatalogProductNameStatus } from '../catalog-product-status.js';
import { ErpClient } from '../erp/client.js';
import { MARKETPLACE_BUNDLE_SOURCE_FIELD, MARKETPLACE_OLD_ID_FIELD } from '../erp/marketplace-fields.js';
import { ITEM_GROUP } from '../erp/stock-catalog.js';
import { b24StoreTitle, erpContext } from '../erp/warehouse-context.js';
import type { CatalogMirrorPrice, CatalogMirrorSnapshot } from './model.js';

const SYSTEM_WAREHOUSE_TITLES = new Set(['Goods In Transit', 'Stores', 'Finished Goods', 'Work In Progress']);

function nullableTimestamp(value: unknown): string | null {
	const text = String(value ?? '').trim();
	return text || null;
}

function technicalDescription(value: unknown): boolean {
	return /^Б24\s+productId=\d+\b(?:\s*\([^)]*\))?\.?$/iu.test(String(value ?? '').trim());
}

/** Reads one complete catalog observation exclusively through the official ERPNext REST API. */
export async function readErpCatalogMirrorSnapshot(erp: ErpClient, now = new Date()): Promise<CatalogMirrorSnapshot> {
	const [ctx, itemRows, priceRows, binRows, warehouseRows] = await Promise.all([
		erpContext(erp),
		erp.list('Item', [
			'name', 'item_name', 'is_stock_item', 'modified',
			'b24_article', 'b24_model', 'b24_brand', 'b24_section', 'b24_product_status',
			'b24_catalog_content', 'b24_filter_category', 'description', 'image',
			MARKETPLACE_BUNDLE_SOURCE_FIELD, MARKETPLACE_OLD_ID_FIELD,
		], [['item_group', '=', ITEM_GROUP], ['disabled', '=', 0]]),
		erp.list('Item Price', ['item_code', 'price_list', 'price_list_rate', 'currency', 'modified'], [
			['price_list', 'in', ['Standard Selling', 'Standard Buying']],
		]),
		erp.list('Bin', ['item_code', 'warehouse', 'actual_qty', 'modified']),
		erp.list('Warehouse', ['name', 'warehouse_type', 'is_group', 'disabled', 'modified']),
	]);

	const products: CatalogMirrorSnapshot['products'] = [];
	const attributes: CatalogMirrorSnapshot['attributes'] = [];
	for (const row of itemRows) {
		const itemCode = Number(row['name']);
		if (!Number.isSafeInteger(itemCode) || itemCode <= 0) continue;
		const content = parseCatalogContent(row['b24_catalog_content']);
		const identity = splitCatalogProductNameStatus(row['item_name'], row['b24_product_status']);
		products.push({
			itemCode,
			bitrixIblockId: 24,
			bitrixSectionId: null,
			itemName: identity.name || `#${itemCode}`,
			isStockItem: Number(row['is_stock_item'] ?? 1) !== 0,
			isMarketplaceBundle: Boolean(String(row[MARKETPLACE_BUNDLE_SOURCE_FIELD] ?? '').trim()),
			article: String(row['b24_article'] ?? '').trim(),
			model: String(row['b24_model'] ?? '').trim(),
			brand: String(row['b24_brand'] ?? '').trim(),
			sectionName: String(row['b24_section'] ?? '').trim(),
			productStatus: identity.status,
			description: technicalDescription(row['description']) ? '' : String(row['description'] ?? '').trim(),
			contentSummary: content?.summary ?? '',
			filterCategory: String(row['b24_filter_category'] ?? '').trim(),
			imagePath: String(row['image'] ?? '').trim(),
			imageSource: String(row['image'] ?? '').trim() ? 'erpnext' : 'none',
			marketplaceOldId: String(row[MARKETPLACE_OLD_ID_FIELD] ?? '').trim(),
			sourceModifiedAt: nullableTimestamp(row['modified']),
		});
		for (const [index, attribute] of (content?.attributes ?? []).entries()) {
			attributes.push({
				itemCode,
				attributeId: attribute.id,
				attributeOrdinal: index + 1,
				attributeKey: attribute.key,
				attributeLabel: attribute.label,
				attributeGroup: attribute.group,
				attributeType: attribute.type,
				rawValue: attribute.rawValue,
				normalizedValue: attribute.normalizedValue,
				numberValue: attribute.numberValue,
				numberMin: attribute.numberMin,
				numberMax: attribute.numberMax,
				unit: attribute.unit,
				booleanValue: attribute.booleanValue,
				filterable: attribute.filterable,
			});
		}
	}
	const productIds = new Set(products.map((row) => row.itemCode));

	const warehouseByName = new Map<string, CatalogMirrorSnapshot['warehouses'][number]>();
	for (const row of warehouseRows) {
		const warehouseName = String(row['name'] ?? '').trim();
		const displayTitle = b24StoreTitle(ctx, warehouseName);
		const warehouseType = String(row['warehouse_type'] ?? '').trim();
		const active = Number(row['is_group'] ?? 0) === 0
			&& Number(row['disabled'] ?? 0) === 0
			&& warehouseType !== 'Transit'
			&& Boolean(displayTitle)
			&& !SYSTEM_WAREHOUSE_TITLES.has(displayTitle);
		if (!active) continue;
		warehouseByName.set(warehouseName, {
			warehouseName,
			displayTitle,
			warehouseType,
			active: true,
			sourceModifiedAt: nullableTimestamp(row['modified']),
		});
	}

	const priceByKey = new Map<string, CatalogMirrorPrice>();
	for (const row of priceRows) {
		const itemCode = Number(row['item_code']);
		if (!productIds.has(itemCode)) continue;
		const rawPriceList = String(row['price_list']);
		const priceKind = rawPriceList === 'Standard Selling' ? 'retail' : rawPriceList === 'Standard Buying' ? 'purchase' : null;
		if (!priceKind) continue;
		const priceList = priceKind === 'retail' ? 'Standard Selling' : 'Standard Buying';
		const candidate: CatalogMirrorPrice = {
			itemCode,
			priceKind,
			priceList,
			sourceSystem: 'erpnext',
			currency: String(row['currency'] ?? 'RUB').trim().toUpperCase() || 'RUB',
			rate: Number(row['price_list_rate'] ?? 0),
			sourceModifiedAt: nullableTimestamp(row['modified']),
		};
		const key = `${itemCode}\u0000${priceKind}`;
		const previous = priceByKey.get(key);
		if (!previous || String(candidate.sourceModifiedAt ?? '') > String(previous.sourceModifiedAt ?? '')) priceByKey.set(key, candidate);
	}

	const stocks = binRows.flatMap((row): CatalogMirrorSnapshot['stocks'] => {
		const itemCode = Number(row['item_code']);
		const warehouseName = String(row['warehouse'] ?? '').trim();
		if (!productIds.has(itemCode) || !warehouseByName.has(warehouseName)) return [];
		return [{
			itemCode,
			warehouseName,
			actualQty: Number(row['actual_qty'] ?? 0),
			sourceModifiedAt: nullableTimestamp(row['modified']),
		}];
	});

	return {
		observedAt: now.toISOString(),
		sources: {
			items: { complete: true, records: itemRows.length },
			prices: { complete: true, records: priceRows.length },
			bins: { complete: true, records: binRows.length },
			warehouses: { complete: true, records: warehouseRows.length },
			bitrix: { complete: false, records: 0 },
		},
		products,
		attributes,
		prices: [...priceByKey.values()],
		warehouses: [...warehouseByName.values()],
		stocks,
	};
}
