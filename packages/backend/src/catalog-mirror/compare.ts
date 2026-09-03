import type { CatalogStore, CoreProductBaseRow } from '../routes/api-catalog-types.js';

export interface CatalogMirrorComparison {
	match: boolean;
	liveProducts: number;
	sqlProducts: number;
	liveStores: number;
	sqlStores: number;
	missingInSql: number;
	extraInSql: number;
	differentProducts: number;
}

function comparable(row: CoreProductBaseRow): unknown[] {
	return [
		row.iblockId, row.name, row.isService, row.isMarketplaceBundle, row.marketplaceOldId,
		row.article, row.model, row.manufacturer, row.sectionId, row.sectionName, row.status,
		row.description, row.content, row.filterCategory, row.retail, row.purchase, row.photoPath,
		row.total, Object.entries(row.stockByStore).sort(([left], [right]) => Number(left) - Number(right)),
	];
}

/** Compares user-visible catalog data and intentionally ignores generation timestamps. */
export function compareCatalogMirrorBases(
	live: { data: { rows: CoreProductBaseRow[] }; stores: CatalogStore[] },
	sql: { data: { rows: CoreProductBaseRow[] }; stores: CatalogStore[] },
): CatalogMirrorComparison {
	const liveById = new Map(live.data.rows.map((row) => [row.id, row]));
	const sqlById = new Map(sql.data.rows.map((row) => [row.id, row]));
	let missingInSql = 0;
	let extraInSql = 0;
	let differentProducts = 0;
	for (const [id, liveRow] of liveById) {
		const sqlRow = sqlById.get(id);
		if (!sqlRow) missingInSql += 1;
		else if (JSON.stringify(comparable(liveRow)) !== JSON.stringify(comparable(sqlRow))) differentProducts += 1;
	}
	for (const id of sqlById.keys()) if (!liveById.has(id)) extraInSql += 1;
	const liveStores = live.stores.map((row) => [row.id, row.title, row.active]).sort();
	const sqlStores = sql.stores.map((row) => [row.id, row.title, row.active]).sort();
	const storesMatch = JSON.stringify(liveStores) === JSON.stringify(sqlStores);
	return {
		match: missingInSql === 0 && extraInSql === 0 && differentProducts === 0 && storesMatch,
		liveProducts: liveById.size,
		sqlProducts: sqlById.size,
		liveStores: live.stores.length,
		sqlStores: sql.stores.length,
		missingInSql,
		extraInSql,
		differentProducts,
	};
}
