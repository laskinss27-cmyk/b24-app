import type { CatalogAttributeType } from '../catalog-content.js';
import type { CatalogMirrorPlan } from './model.js';
import { verifyCatalogMirrorPlanIntegrity } from './plan.js';

type QueryRow = Record<string, unknown>;

export interface CatalogMirrorReadPool {
	query<T>(sql: string, values?: unknown[]): Promise<T>;
}

const CHECKPOINT_QUERY = `
	SELECT LOWER(HEX(snapshot_hash)) AS snapshot_hash,
		DATE_FORMAT(observed_at, '%Y-%m-%d %H:%i:%s.%f') AS snapshot_observed_at,
		DATE_FORMAT(last_verified_at, '%Y-%m-%d %H:%i:%s.%f') AS last_verified_at,
		source_complete, erp_item_records, erp_price_records, erp_bin_records, erp_warehouse_records,
		bitrix_product_records,
		product_count, attribute_count, price_count, warehouse_count, stock_count
	FROM catalog_mirror_checkpoints
	ORDER BY last_verified_at DESC, id DESC
	LIMIT 1
`;

const PRODUCTS_QUERY = `
	SELECT item_code, bitrix_iblock_id, bitrix_section_id, item_name, is_stock_item, is_marketplace_bundle, article, model, brand,
		section_name, product_status, description, content_summary, content_present, filter_category,
		image_path, image_source, marketplace_old_id,
		DATE_FORMAT(source_modified_at, '%Y-%m-%d %H:%i:%s.%f') AS source_modified_at,
		LOWER(HEX(source_hash)) AS source_hash
	FROM catalog_mirror_products
	WHERE observed_at = ?
	ORDER BY item_code
`;

const ATTRIBUTES_QUERY = `
	SELECT item_code, attribute_id, attribute_ordinal, attribute_key, attribute_label,
		attribute_group, attribute_type, raw_value, normalized_value,
		number_value, number_min, number_max, unit, boolean_value, filterable,
		LOWER(HEX(source_hash)) AS source_hash
	FROM catalog_mirror_attributes
	WHERE observed_at = ?
	ORDER BY item_code, attribute_ordinal, attribute_id
`;

const PRICES_QUERY = `
	SELECT item_code, price_kind, price_list, source_system, currency, rate,
		DATE_FORMAT(source_modified_at, '%Y-%m-%d %H:%i:%s.%f') AS source_modified_at,
		LOWER(HEX(source_hash)) AS source_hash
	FROM catalog_mirror_prices
	WHERE observed_at = ?
	ORDER BY item_code, price_kind
`;

const WAREHOUSES_QUERY = `
	SELECT warehouse_name, display_title, warehouse_type, active,
		DATE_FORMAT(source_modified_at, '%Y-%m-%d %H:%i:%s.%f') AS source_modified_at,
		LOWER(HEX(source_hash)) AS source_hash
	FROM catalog_mirror_warehouses
	WHERE observed_at = ?
	ORDER BY warehouse_name
`;

const STOCKS_QUERY = `
	SELECT item_code, warehouse_name, actual_qty,
		DATE_FORMAT(source_modified_at, '%Y-%m-%d %H:%i:%s.%f') AS source_modified_at,
		LOWER(HEX(source_hash)) AS source_hash
	FROM catalog_mirror_stocks
	WHERE observed_at = ?
	ORDER BY item_code, warehouse_name
`;

function string(row: QueryRow, field: string): string {
	const value = row[field];
	if (typeof value !== 'string') throw new Error(`Invalid SQL catalog mirror field ${field}`);
	return value;
}

function nonEmptyString(row: QueryRow, field: string): string {
	const value = string(row, field);
	if (!value.length) throw new Error(`Invalid SQL catalog mirror field ${field}`);
	return value;
}

function nullableString(row: QueryRow, field: string): string | null {
	if (row[field] === null || row[field] === undefined) return null;
	return string(row, field);
}

function number(row: QueryRow, field: string, integer = false): number {
	const value = Number(row[field]);
	if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) throw new Error(`Invalid SQL catalog mirror field ${field}`);
	return value;
}

function nullableNumber(row: QueryRow, field: string): number | null {
	if (row[field] === null || row[field] === undefined) return null;
	return number(row, field);
}

function boolean(row: QueryRow, field: string): boolean {
	const value = number(row, field, true);
	if (value !== 0 && value !== 1) throw new Error(`Invalid SQL catalog mirror field ${field}`);
	return value === 1;
}

function nullableBoolean(row: QueryRow, field: string): boolean | null {
	if (row[field] === null || row[field] === undefined) return null;
	return boolean(row, field);
}

function iblockId(row: QueryRow): 24 | 26 {
	const value = number(row, 'bitrix_iblock_id', true);
	if (value !== 24 && value !== 26) throw new Error(`Invalid SQL catalog mirror field bitrix_iblock_id: ${value}`);
	return value;
}

function hash(row: QueryRow, field = 'source_hash'): string {
	const value = nonEmptyString(row, field);
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid SQL catalog mirror hash ${field}`);
	return value;
}

function oneOf<T extends string>(row: QueryRow, field: string, allowed: readonly T[]): T {
	const value = nonEmptyString(row, field);
	if (!allowed.includes(value as T)) throw new Error(`Invalid SQL catalog mirror field ${field}: ${value}`);
	return value as T;
}

function expectCount(label: string, rows: unknown[], expected: number): void {
	if (rows.length !== expected) throw new Error(`Incomplete SQL catalog mirror ${label}: ${rows.length}/${expected}`);
}

/** Latest-checkpoint-first reader. Mixed observations are impossible by construction. */
export async function readLatestCatalogMirrorPlan(pool: CatalogMirrorReadPool): Promise<CatalogMirrorPlan | null> {
	const checkpoints = await pool.query<QueryRow[]>(CHECKPOINT_QUERY);
	const checkpoint = checkpoints[0];
	if (!checkpoint) return null;
	if (!boolean(checkpoint, 'source_complete')) throw new Error('SQL catalog mirror checkpoint is incomplete');
	const snapshotObservedAt = nonEmptyString(checkpoint, 'snapshot_observed_at');
	const observedAt = nonEmptyString(checkpoint, 'last_verified_at');
	const [productRows, attributeRows, priceRows, warehouseRows, stockRows] = await Promise.all([
		pool.query<QueryRow[]>(PRODUCTS_QUERY, [snapshotObservedAt]),
		pool.query<QueryRow[]>(ATTRIBUTES_QUERY, [snapshotObservedAt]),
		pool.query<QueryRow[]>(PRICES_QUERY, [snapshotObservedAt]),
		pool.query<QueryRow[]>(WAREHOUSES_QUERY, [snapshotObservedAt]),
		pool.query<QueryRow[]>(STOCKS_QUERY, [snapshotObservedAt]),
	]);
	expectCount('products', productRows, number(checkpoint, 'product_count', true));
	expectCount('attributes', attributeRows, number(checkpoint, 'attribute_count', true));
	expectCount('prices', priceRows, number(checkpoint, 'price_count', true));
	expectCount('warehouses', warehouseRows, number(checkpoint, 'warehouse_count', true));
	expectCount('stocks', stockRows, number(checkpoint, 'stock_count', true));

	const plan: CatalogMirrorPlan = {
		observedAt,
		snapshotHash: hash(checkpoint, 'snapshot_hash'),
		sources: {
			items: { complete: true, records: number(checkpoint, 'erp_item_records', true) },
			prices: { complete: true, records: number(checkpoint, 'erp_price_records', true) },
			bins: { complete: true, records: number(checkpoint, 'erp_bin_records', true) },
			warehouses: { complete: true, records: number(checkpoint, 'erp_warehouse_records', true) },
			bitrix: { complete: true, records: number(checkpoint, 'bitrix_product_records', true) },
		},
		products: productRows.map((row) => ({
			itemCode: number(row, 'item_code', true),
			bitrixIblockId: iblockId(row),
			bitrixSectionId: nullableNumber(row, 'bitrix_section_id'),
			itemName: nonEmptyString(row, 'item_name'),
			isStockItem: boolean(row, 'is_stock_item'),
			isMarketplaceBundle: boolean(row, 'is_marketplace_bundle'),
			article: string(row, 'article'),
			model: string(row, 'model'),
			brand: string(row, 'brand'),
			sectionName: string(row, 'section_name'),
			productStatus: string(row, 'product_status'),
			description: string(row, 'description'),
			contentSummary: string(row, 'content_summary'),
			contentPresent: boolean(row, 'content_present'),
			filterCategory: string(row, 'filter_category'),
			imagePath: string(row, 'image_path'),
			imageSource: oneOf(row, 'image_source', ['none', 'erpnext', 'bitrix'] as const),
			marketplaceOldId: string(row, 'marketplace_old_id'),
			sourceModifiedAt: nullableString(row, 'source_modified_at'),
			sourceHash: hash(row),
		})),
		attributes: attributeRows.map((row) => ({
			itemCode: number(row, 'item_code', true),
			attributeId: nonEmptyString(row, 'attribute_id'),
			attributeOrdinal: number(row, 'attribute_ordinal', true),
			attributeKey: nonEmptyString(row, 'attribute_key'),
			attributeLabel: nonEmptyString(row, 'attribute_label'),
			attributeGroup: nonEmptyString(row, 'attribute_group'),
			attributeType: oneOf<CatalogAttributeType>(row, 'attribute_type', ['text', 'option', 'multi_option', 'number', 'range', 'boolean']),
			rawValue: string(row, 'raw_value'),
			normalizedValue: string(row, 'normalized_value'),
			numberValue: nullableNumber(row, 'number_value'),
			numberMin: nullableNumber(row, 'number_min'),
			numberMax: nullableNumber(row, 'number_max'),
			unit: string(row, 'unit'),
			booleanValue: nullableBoolean(row, 'boolean_value'),
			filterable: boolean(row, 'filterable'),
			sourceHash: hash(row),
		})),
		prices: priceRows.map((row) => ({
			itemCode: number(row, 'item_code', true),
			priceKind: oneOf(row, 'price_kind', ['retail', 'purchase'] as const),
			priceList: oneOf(row, 'price_list', ['Standard Selling', 'Standard Buying'] as const),
			sourceSystem: oneOf(row, 'source_system', ['erpnext', 'bitrix'] as const),
			currency: nonEmptyString(row, 'currency'),
			rate: number(row, 'rate'),
			sourceModifiedAt: nullableString(row, 'source_modified_at'),
			sourceHash: hash(row),
		})),
		warehouses: warehouseRows.map((row) => ({
			warehouseName: nonEmptyString(row, 'warehouse_name'),
			displayTitle: nonEmptyString(row, 'display_title'),
			warehouseType: string(row, 'warehouse_type'),
			active: boolean(row, 'active'),
			sourceModifiedAt: nullableString(row, 'source_modified_at'),
			sourceHash: hash(row),
		})),
		stocks: stockRows.map((row) => ({
			itemCode: number(row, 'item_code', true),
			warehouseName: nonEmptyString(row, 'warehouse_name'),
			actualQty: number(row, 'actual_qty'),
			sourceModifiedAt: nullableString(row, 'source_modified_at'),
			sourceHash: hash(row),
		})),
	};
	verifyCatalogMirrorPlanIntegrity(plan);
	return plan;
}
