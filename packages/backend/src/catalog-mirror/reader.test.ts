import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalogMirrorPlan } from './plan.js';
import { readLatestCatalogMirrorPlan, type CatalogMirrorReadPool } from './reader.js';
import { catalogMirrorFixture } from './test-fixture.js';

function sqlTimestamp(value: string | null): string | null {
	return value ? new Date(value).toISOString().replace('T', ' ').replace('Z', '000') : null;
}

function poolForPlan(incompleteProducts = false, corruptProduct = false): CatalogMirrorReadPool {
	const plan = buildCatalogMirrorPlan(catalogMirrorFixture());
	return {
		query: async <T>(sql: string, values?: unknown[]) => {
			if (sql.includes('FROM catalog_mirror_checkpoints')) return [{
				snapshot_hash: plan.snapshotHash,
				snapshot_observed_at: sqlTimestamp(plan.observedAt),
				last_verified_at: sqlTimestamp(plan.observedAt),
				source_complete: 1,
				erp_item_records: plan.sources.items.records,
				erp_price_records: plan.sources.prices.records,
				erp_bin_records: plan.sources.bins.records,
				erp_warehouse_records: plan.sources.warehouses.records,
				bitrix_product_records: plan.sources.bitrix.records,
				product_count: plan.products.length,
				attribute_count: plan.attributes.length,
				price_count: plan.prices.length,
				warehouse_count: plan.warehouses.length,
				stock_count: plan.stocks.length,
			}] as T;
			assert.deepEqual(values, [sqlTimestamp(plan.observedAt)]);
			if (sql.includes('FROM catalog_mirror_products')) return (incompleteProducts ? [] : plan.products.map((row) => ({
				item_code: row.itemCode, bitrix_iblock_id: row.bitrixIblockId, bitrix_section_id: row.bitrixSectionId,
				item_name: corruptProduct ? `${row.itemName} повреждён` : row.itemName, is_stock_item: Number(row.isStockItem),
				is_marketplace_bundle: Number(row.isMarketplaceBundle), article: row.article, model: row.model,
				brand: row.brand, section_name: row.sectionName, product_status: row.productStatus,
				description: row.description, content_summary: row.contentSummary, content_present: Number(row.contentPresent), filter_category: row.filterCategory,
				image_path: row.imagePath, image_source: row.imageSource, marketplace_old_id: row.marketplaceOldId,
				source_modified_at: sqlTimestamp(row.sourceModifiedAt), source_hash: row.sourceHash,
			}))) as T;
			if (sql.includes('FROM catalog_mirror_attributes')) return plan.attributes.map((row) => ({
				item_code: row.itemCode, attribute_id: row.attributeId, attribute_ordinal: row.attributeOrdinal,
				attribute_key: row.attributeKey, attribute_label: row.attributeLabel, attribute_group: row.attributeGroup,
				attribute_type: row.attributeType, raw_value: row.rawValue, normalized_value: row.normalizedValue,
				number_value: row.numberValue, number_min: row.numberMin, number_max: row.numberMax, unit: row.unit,
				boolean_value: row.booleanValue, filterable: Number(row.filterable), source_hash: row.sourceHash,
			})) as T;
			if (sql.includes('FROM catalog_mirror_prices')) return plan.prices.map((row) => ({
				item_code: row.itemCode, price_kind: row.priceKind, price_list: row.priceList, source_system: row.sourceSystem, currency: row.currency,
				rate: String(row.rate), source_modified_at: sqlTimestamp(row.sourceModifiedAt), source_hash: row.sourceHash,
			})) as T;
			if (sql.includes('FROM catalog_mirror_warehouses')) return plan.warehouses.map((row) => ({
				warehouse_name: row.warehouseName, display_title: row.displayTitle, warehouse_type: row.warehouseType,
				active: Number(row.active), source_modified_at: sqlTimestamp(row.sourceModifiedAt), source_hash: row.sourceHash,
			})) as T;
			if (sql.includes('FROM catalog_mirror_stocks')) return plan.stocks.map((row) => ({
				item_code: row.itemCode, warehouse_name: row.warehouseName, actual_qty: String(row.actualQty),
				source_modified_at: sqlTimestamp(row.sourceModifiedAt), source_hash: row.sourceHash,
			})) as T;
			return [] as T;
		},
	};
}

test('catalog mirror reader selects the latest checkpoint first and preserves normalized rows', async () => {
	const stored = await readLatestCatalogMirrorPlan(poolForPlan());
	assert.ok(stored);
	assert.equal(stored.snapshotHash, buildCatalogMirrorPlan(catalogMirrorFixture()).snapshotHash);
	assert.equal(stored.products[0]?.itemName, 'Монитор');
	assert.equal(stored.attributes[0]?.numberValue, 24);
	assert.deepEqual(stored.prices.map((row) => row.rate), [800, 1200]);
	assert.equal(stored.stocks[0]?.actualQty, 3);
});

test('catalog mirror reader fails closed when checkpoint counts and rows differ', async () => {
	await assert.rejects(() => readLatestCatalogMirrorPlan(poolForPlan(true)), /Incomplete SQL catalog mirror products: 0\/1/);
});

test('catalog mirror reader fails closed when a persisted row does not match its hash', async () => {
	await assert.rejects(() => readLatestCatalogMirrorPlan(poolForPlan(false, true)), /product 101 hash mismatch/);
});
