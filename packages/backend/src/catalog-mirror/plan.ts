import { createHash } from 'node:crypto';
import type {
	CatalogMirrorAttribute,
	CatalogMirrorPlan,
	CatalogMirrorPlanRow,
	CatalogMirrorPrice,
	CatalogMirrorProduct,
	CatalogMirrorSnapshot,
	CatalogMirrorStock,
	CatalogMirrorWarehouse,
} from './model.js';

function sha256(values: unknown[]): string {
	return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function canonicalDateTime(value: string | null, label: string): string | null {
	if (value === null) return null;
	const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value.trim());
	if (naive) return `${naive[1]} ${naive[2]}.${String(naive[3] ?? '').padEnd(6, '0')}`;
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is not a valid timestamp`);
	return parsed.toISOString().replace('T', ' ').replace('Z', '000');
}

function unique<T>(rows: T[], identity: (row: T) => string, label: string): void {
	const seen = new Set<string>();
	for (const row of rows) {
		const key = identity(row);
		if (seen.has(key)) throw new Error(`Duplicate catalog mirror ${label}: ${key}`);
		seen.add(key);
	}
}

function finite(value: number | null, label: string): void {
	if (value !== null && !Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function productHash(row: CatalogMirrorProduct): string {
	return sha256([
		row.itemCode, row.bitrixIblockId, row.bitrixSectionId, row.itemName, row.isStockItem, row.isMarketplaceBundle,
		row.article, row.model, row.brand, row.sectionName, row.productStatus,
		row.description, row.contentSummary, row.contentPresent, row.filterCategory, row.imagePath, row.imageSource,
		row.marketplaceOldId, canonicalDateTime(row.sourceModifiedAt, `product ${row.itemCode} modified`),
	]);
}

function attributeHash(row: CatalogMirrorAttribute): string {
	return sha256([
		row.itemCode, row.attributeId, row.attributeOrdinal, row.attributeKey,
		row.attributeLabel, row.attributeGroup, row.attributeType, row.rawValue,
		row.normalizedValue, row.numberValue, row.numberMin, row.numberMax,
		row.unit, row.booleanValue, row.filterable,
	]);
}

function priceHash(row: CatalogMirrorPrice): string {
	return sha256([row.itemCode, row.priceKind, row.priceList, row.sourceSystem, row.currency, row.rate, canonicalDateTime(row.sourceModifiedAt, `price ${row.itemCode}/${row.priceKind} modified`)]);
}

function warehouseHash(row: CatalogMirrorWarehouse): string {
	return sha256([row.warehouseName, row.displayTitle, row.warehouseType, row.active, canonicalDateTime(row.sourceModifiedAt, `warehouse ${row.warehouseName} modified`)]);
}

function stockHash(row: CatalogMirrorStock): string {
	return sha256([row.itemCode, row.warehouseName, row.actualQty, canonicalDateTime(row.sourceModifiedAt, `stock ${row.itemCode}/${row.warehouseName} modified`)]);
}

function withHash<T>(rows: T[], hash: (row: T) => string): Array<CatalogMirrorPlanRow<T>> {
	return rows.map((row) => ({ ...row, sourceHash: hash(row) }));
}

/**
 * Builds one deterministic, complete catalog observation. JSON is used only as
 * an in-memory hashing encoding; no JSON payload is persisted in SQL.
 */
export function buildCatalogMirrorPlan(snapshot: CatalogMirrorSnapshot): CatalogMirrorPlan {
	canonicalDateTime(snapshot.observedAt, 'catalog observedAt');
	if (Object.entries(snapshot.sources).some(([, source]) => !source.complete)) {
		throw new Error('Catalog mirror source is incomplete');
	}
	if (!snapshot.products.length) throw new Error('Catalog mirror has no products');
	if (!snapshot.warehouses.length) throw new Error('Catalog mirror has no warehouses');
	for (const [name, source] of Object.entries(snapshot.sources)) {
		if (!Number.isInteger(source.records) || source.records < 0) throw new Error(`Catalog source ${name} has invalid record count`);
	}

	unique(snapshot.products, (row) => String(row.itemCode), 'product');
	unique(snapshot.attributes, (row) => `${row.itemCode}\u0000${row.attributeId}`, 'attribute');
	unique(snapshot.prices, (row) => `${row.itemCode}\u0000${row.priceKind}`, 'price');
	unique(snapshot.warehouses, (row) => row.warehouseName, 'warehouse');
	unique(snapshot.stocks, (row) => `${row.itemCode}\u0000${row.warehouseName}`, 'stock');

	const productIds = new Set(snapshot.products.map((row) => row.itemCode));
	const warehouseNames = new Set(snapshot.warehouses.map((row) => row.warehouseName));
	for (const row of snapshot.products) {
		if (!Number.isSafeInteger(row.itemCode) || row.itemCode <= 0 || !row.itemName.trim()
			|| (row.bitrixIblockId !== 24 && row.bitrixIblockId !== 26)
			|| (row.bitrixSectionId !== null && (!Number.isSafeInteger(row.bitrixSectionId) || row.bitrixSectionId <= 0))) {
			throw new Error('Catalog mirror product identity is invalid');
		}
		canonicalDateTime(row.sourceModifiedAt, `product ${row.itemCode} modified`);
	}
	for (const row of snapshot.attributes) {
		if (!productIds.has(row.itemCode) || !row.attributeId || row.attributeOrdinal <= 0) throw new Error('Catalog mirror attribute identity is invalid');
		finite(row.numberValue, `attribute ${row.attributeId} numberValue`);
		finite(row.numberMin, `attribute ${row.attributeId} numberMin`);
		finite(row.numberMax, `attribute ${row.attributeId} numberMax`);
	}
	for (const row of snapshot.prices) {
		if (!productIds.has(row.itemCode) || !Number.isFinite(row.rate) || row.rate < 0) throw new Error('Catalog mirror price is invalid');
		canonicalDateTime(row.sourceModifiedAt, `price ${row.itemCode}/${row.priceKind} modified`);
	}
	for (const row of snapshot.warehouses) {
		if (!row.warehouseName.trim() || !row.displayTitle.trim()) throw new Error('Catalog mirror warehouse identity is invalid');
		canonicalDateTime(row.sourceModifiedAt, `warehouse ${row.warehouseName} modified`);
	}
	for (const row of snapshot.stocks) {
		if (!productIds.has(row.itemCode) || !warehouseNames.has(row.warehouseName) || !Number.isFinite(row.actualQty)) {
			throw new Error('Catalog mirror stock is invalid');
		}
		canonicalDateTime(row.sourceModifiedAt, `stock ${row.itemCode}/${row.warehouseName} modified`);
	}

	const products = withHash([...snapshot.products].sort((a, b) => a.itemCode - b.itemCode), productHash);
	const attributes = withHash([...snapshot.attributes].sort((a, b) => a.itemCode - b.itemCode || a.attributeOrdinal - b.attributeOrdinal || a.attributeId.localeCompare(b.attributeId)), attributeHash);
	const prices = withHash([...snapshot.prices].sort((a, b) => a.itemCode - b.itemCode || a.priceKind.localeCompare(b.priceKind)), priceHash);
	const warehouses = withHash([...snapshot.warehouses].sort((a, b) => a.warehouseName.localeCompare(b.warehouseName)), warehouseHash);
	const stocks = withHash([...snapshot.stocks].sort((a, b) => a.itemCode - b.itemCode || a.warehouseName.localeCompare(b.warehouseName)), stockHash);
	const sourceCounts = Object.entries(snapshot.sources).sort(([left], [right]) => left.localeCompare(right)).map(([name, source]) => [name, source.records]);
	const snapshotHash = sha256([
		sourceCounts,
		products.map((row) => row.sourceHash),
		attributes.map((row) => row.sourceHash),
		prices.map((row) => row.sourceHash),
		warehouses.map((row) => row.sourceHash),
		stocks.map((row) => row.sourceHash),
	]);
	return { observedAt: snapshot.observedAt, snapshotHash, sources: snapshot.sources, products, attributes, prices, warehouses, stocks };
}

/** Recomputes every persisted row hash and the aggregate checkpoint hash. */
export function verifyCatalogMirrorPlanIntegrity(plan: CatalogMirrorPlan): void {
	const checks: Array<[string, string, string]> = [
		...plan.products.map((row): [string, string, string] => [`product ${row.itemCode}`, row.sourceHash, productHash(row)]),
		...plan.attributes.map((row): [string, string, string] => [`attribute ${row.itemCode}/${row.attributeId}`, row.sourceHash, attributeHash(row)]),
		...plan.prices.map((row): [string, string, string] => [`price ${row.itemCode}/${row.priceKind}`, row.sourceHash, priceHash(row)]),
		...plan.warehouses.map((row): [string, string, string] => [`warehouse ${row.warehouseName}`, row.sourceHash, warehouseHash(row)]),
		...plan.stocks.map((row): [string, string, string] => [`stock ${row.itemCode}/${row.warehouseName}`, row.sourceHash, stockHash(row)]),
	];
	for (const [label, stored, actual] of checks) {
		if (stored !== actual) throw new Error(`SQL catalog mirror ${label} hash mismatch`);
	}
	const sourceCounts = Object.entries(plan.sources).sort(([left], [right]) => left.localeCompare(right)).map(([name, source]) => [name, source.records]);
	const actualSnapshotHash = sha256([
		sourceCounts,
		plan.products.map((row) => row.sourceHash),
		plan.attributes.map((row) => row.sourceHash),
		plan.prices.map((row) => row.sourceHash),
		plan.warehouses.map((row) => row.sourceHash),
		plan.stocks.map((row) => row.sourceHash),
	]);
	if (plan.snapshotHash !== actualSnapshotHash) throw new Error('SQL catalog mirror snapshot hash mismatch');
}
