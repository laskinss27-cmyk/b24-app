import type { CatalogMirrorPlan } from './model.js';
import { verifyCatalogMirrorPlanIntegrity } from './plan.js';

const WRITER_LOCK = 'b24_app_catalog_mirror_writer';
const BATCH_SIZE = 250;

type QueryRow = Record<string, unknown>;

export interface CatalogMirrorWriterConnection {
	query<T = unknown>(sql: string, values?: unknown[]): Promise<T>;
	batch(sql: string, values: unknown[][]): Promise<unknown>;
	beginTransaction(): Promise<void>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	release(): void | Promise<void>;
}

export interface CatalogMirrorWriterPool {
	getConnection(): Promise<CatalogMirrorWriterConnection>;
}

export interface CatalogMirrorWriteResult {
	snapshotHash: string;
	alreadyApplied: boolean;
	counts: {
		products: number;
		attributes: number;
		prices: number;
		warehouses: number;
		stocks: number;
	};
}

const PRODUCT_UPSERT = `
	INSERT INTO catalog_mirror_products (
		item_code, bitrix_iblock_id, bitrix_section_id, item_name, is_stock_item, is_marketplace_bundle, article, model, brand,
		section_name, product_status, description, content_summary, content_present, filter_category,
		image_path, image_source, marketplace_old_id, source_modified_at, observed_at, source_hash
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		bitrix_iblock_id = VALUES(bitrix_iblock_id),
		bitrix_section_id = VALUES(bitrix_section_id),
		item_name = VALUES(item_name),
		is_stock_item = VALUES(is_stock_item),
		is_marketplace_bundle = VALUES(is_marketplace_bundle),
		article = VALUES(article),
		model = VALUES(model),
		brand = VALUES(brand),
		section_name = VALUES(section_name),
		product_status = VALUES(product_status),
		description = VALUES(description),
		content_summary = VALUES(content_summary),
		content_present = VALUES(content_present),
		filter_category = VALUES(filter_category),
		image_path = VALUES(image_path),
		image_source = VALUES(image_source),
		marketplace_old_id = VALUES(marketplace_old_id),
		source_modified_at = VALUES(source_modified_at),
		observed_at = VALUES(observed_at),
		source_hash = VALUES(source_hash)
`;

const ATTRIBUTE_UPSERT = `
	INSERT INTO catalog_mirror_attributes (
		item_code, attribute_id, attribute_ordinal, attribute_key, attribute_label,
		attribute_group, attribute_type, raw_value, normalized_value, number_value,
		number_min, number_max, unit, boolean_value, filterable, observed_at, source_hash
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		attribute_ordinal = VALUES(attribute_ordinal),
		attribute_key = VALUES(attribute_key),
		attribute_label = VALUES(attribute_label),
		attribute_group = VALUES(attribute_group),
		attribute_type = VALUES(attribute_type),
		raw_value = VALUES(raw_value),
		normalized_value = VALUES(normalized_value),
		number_value = VALUES(number_value),
		number_min = VALUES(number_min),
		number_max = VALUES(number_max),
		unit = VALUES(unit),
		boolean_value = VALUES(boolean_value),
		filterable = VALUES(filterable),
		observed_at = VALUES(observed_at),
		source_hash = VALUES(source_hash)
`;

const PRICE_UPSERT = `
	INSERT INTO catalog_mirror_prices (
		item_code, price_kind, price_list, source_system, currency, rate, source_modified_at, observed_at, source_hash
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		price_list = VALUES(price_list),
		source_system = VALUES(source_system),
		currency = VALUES(currency),
		rate = VALUES(rate),
		source_modified_at = VALUES(source_modified_at),
		observed_at = VALUES(observed_at),
		source_hash = VALUES(source_hash)
`;

const WAREHOUSE_UPSERT = `
	INSERT INTO catalog_mirror_warehouses (
		warehouse_name, display_title, warehouse_type, active, source_modified_at, observed_at, source_hash
	) VALUES (?, ?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		display_title = VALUES(display_title),
		warehouse_type = VALUES(warehouse_type),
		active = VALUES(active),
		source_modified_at = VALUES(source_modified_at),
		observed_at = VALUES(observed_at),
		source_hash = VALUES(source_hash)
`;

const STOCK_UPSERT = `
	INSERT INTO catalog_mirror_stocks (
		item_code, warehouse_name, actual_qty, source_modified_at, observed_at, source_hash
	) VALUES (?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		actual_qty = VALUES(actual_qty),
		source_modified_at = VALUES(source_modified_at),
		observed_at = VALUES(observed_at),
		source_hash = VALUES(source_hash)
`;

function hashBuffer(value: string, label: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
	return Buffer.from(value, 'hex');
}

function sqlDateTime(value: string | null, label: string): string | null {
	if (value === null) return null;
	const naive = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value.trim());
	if (naive) return `${naive[1]}.${String(naive[2] ?? '').padEnd(6, '0')}`;
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is not a valid timestamp`);
	return parsed.toISOString().replace('T', ' ').replace('Z', '000');
}

async function runBatches(connection: CatalogMirrorWriterConnection, sql: string, values: unknown[][]): Promise<void> {
	for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
		await connection.batch(sql, values.slice(offset, offset + BATCH_SIZE));
	}
}

/** Applies a complete snapshot atomically. The checkpoint is inserted last. */
export async function applyCatalogMirrorPlan(pool: CatalogMirrorWriterPool, plan: CatalogMirrorPlan): Promise<CatalogMirrorWriteResult> {
	verifyCatalogMirrorPlanIntegrity(plan);
	const observedAt = sqlDateTime(plan.observedAt, 'catalog observedAt')!;
	const snapshotHash = hashBuffer(plan.snapshotHash, 'catalog snapshotHash');
	const counts = {
		products: plan.products.length,
		attributes: plan.attributes.length,
		prices: plan.prices.length,
		warehouses: plan.warehouses.length,
		stocks: plan.stocks.length,
	};
	if (!counts.products || !counts.warehouses || Object.values(plan.sources).some((source) => !source.complete)) {
		throw new Error('Catalog mirror plan is incomplete');
	}
	const connection = await pool.getConnection();
	let locked = false;
	let transaction = false;
	try {
		const lockRows = await connection.query<QueryRow[]>('SELECT GET_LOCK(?, 10) AS acquired', [WRITER_LOCK]);
		if (Number(lockRows[0]?.['acquired']) !== 1) throw new Error('Could not acquire catalog mirror writer lock');
		locked = true;
		await connection.beginTransaction();
		transaction = true;
		const latest = await connection.query<QueryRow[]>(
			`SELECT id, LOWER(HEX(snapshot_hash)) AS snapshot_hash
			 FROM catalog_mirror_checkpoints
			 ORDER BY last_verified_at DESC, id DESC
			 LIMIT 1 FOR UPDATE`,
		);
		if (latest[0]?.['snapshot_hash'] === plan.snapshotHash) {
			await connection.query(
				'UPDATE catalog_mirror_checkpoints SET last_verified_at = ? WHERE id = ?',
				[observedAt, latest[0]?.['id']],
			);
			await connection.commit();
			transaction = false;
			return { snapshotHash: plan.snapshotHash, alreadyApplied: true, counts };
		}
		const reusable = await connection.query<QueryRow[]>(
			'SELECT id FROM catalog_mirror_checkpoints WHERE snapshot_hash = ? FOR UPDATE',
			[snapshotHash],
		);

		await runBatches(connection, PRODUCT_UPSERT, plan.products.map((row) => [
			row.itemCode, row.bitrixIblockId, row.bitrixSectionId, row.itemName, row.isStockItem ? 1 : 0, row.isMarketplaceBundle ? 1 : 0,
			row.article, row.model, row.brand, row.sectionName, row.productStatus,
			row.description, row.contentSummary, row.contentPresent ? 1 : 0, row.filterCategory, row.imagePath, row.imageSource, row.marketplaceOldId,
			sqlDateTime(row.sourceModifiedAt, `product ${row.itemCode} modified`), observedAt,
			hashBuffer(row.sourceHash, `product ${row.itemCode} sourceHash`),
		]));
		await runBatches(connection, WAREHOUSE_UPSERT, plan.warehouses.map((row) => [
			row.warehouseName, row.displayTitle, row.warehouseType, row.active ? 1 : 0,
			sqlDateTime(row.sourceModifiedAt, `warehouse ${row.warehouseName} modified`), observedAt,
			hashBuffer(row.sourceHash, `warehouse ${row.warehouseName} sourceHash`),
		]));
		await runBatches(connection, ATTRIBUTE_UPSERT, plan.attributes.map((row) => [
			row.itemCode, row.attributeId, row.attributeOrdinal, row.attributeKey, row.attributeLabel,
			row.attributeGroup, row.attributeType, row.rawValue, row.normalizedValue, row.numberValue,
			row.numberMin, row.numberMax, row.unit, row.booleanValue === null ? null : row.booleanValue ? 1 : 0,
			row.filterable ? 1 : 0, observedAt, hashBuffer(row.sourceHash, `attribute ${row.itemCode}/${row.attributeId} sourceHash`),
		]));
		await runBatches(connection, PRICE_UPSERT, plan.prices.map((row) => [
			row.itemCode, row.priceKind, row.priceList, row.sourceSystem, row.currency, row.rate,
			sqlDateTime(row.sourceModifiedAt, `price ${row.itemCode}/${row.priceKind} modified`), observedAt,
			hashBuffer(row.sourceHash, `price ${row.itemCode}/${row.priceKind} sourceHash`),
		]));
		await runBatches(connection, STOCK_UPSERT, plan.stocks.map((row) => [
			row.itemCode, row.warehouseName, row.actualQty,
			sqlDateTime(row.sourceModifiedAt, `stock ${row.itemCode}/${row.warehouseName} modified`), observedAt,
			hashBuffer(row.sourceHash, `stock ${row.itemCode}/${row.warehouseName} sourceHash`),
		]));

		if (reusable[0]) {
			await connection.query(`
				UPDATE catalog_mirror_checkpoints
				SET observed_at = ?, last_verified_at = ?, applied_at = CURRENT_TIMESTAMP(6)
				WHERE id = ?
			`, [observedAt, observedAt, reusable[0]['id']]);
		} else {
			await connection.query(`
				INSERT INTO catalog_mirror_checkpoints (
				snapshot_hash, observed_at, last_verified_at, source_complete,
				erp_item_records, erp_price_records, erp_bin_records, erp_warehouse_records,
				bitrix_product_records,
				product_count, attribute_count, price_count, warehouse_count, stock_count
			) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`, [
				snapshotHash, observedAt, observedAt,
				plan.sources.items.records, plan.sources.prices.records, plan.sources.bins.records, plan.sources.warehouses.records,
				plan.sources.bitrix.records,
				counts.products, counts.attributes, counts.prices, counts.warehouses, counts.stocks,
			]);
		}
		await connection.commit();
		transaction = false;
		return { snapshotHash: plan.snapshotHash, alreadyApplied: false, counts };
	} catch (error) {
		if (transaction) await connection.rollback();
		throw error;
	} finally {
		if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [WRITER_LOCK]).catch(() => undefined);
		await connection.release();
	}
}
