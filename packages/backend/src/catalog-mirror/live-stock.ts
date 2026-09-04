import type { ErpClient } from '../erp/client.js';
import { coreStoreId, fetchErpStocks, listActiveStoreTitles } from '../erp/operations.js';
import type { CatalogStore, CoreProductBaseRow } from '../routes/api-catalog-types.js';
import { normalizedStoreTitle } from '../routes/api-catalog-value-helpers.js';

export interface CatalogProductBase {
	data: { rows: CoreProductBaseRow[]; generatedAt: string };
	stores: CatalogStore[];
}

export interface LiveCatalogStock {
	stocks: Map<number, Record<string, number>>;
	storeTitles: string[];
	generatedAt: string;
}

/** Reads only volatile warehouse data. Product cards and prices are intentionally absent. */
export async function readLiveCatalogStock(erp: ErpClient): Promise<LiveCatalogStock> {
	const [stocks, storeTitles] = await Promise.all([
		fetchErpStocks(erp),
		listActiveStoreTitles(erp),
	]);
	return { stocks, storeTitles, generatedAt: new Date().toISOString() };
}

/** Replaces snapshot quantities with a single fresh ERP stock projection without mutating the cached SQL base. */
export function applyLiveCatalogStock(base: CatalogProductBase, live: LiveCatalogStock): CatalogProductBase {
	const stores = live.storeTitles
		.map((title) => ({ id: coreStoreId(title), title, active: true }))
		.sort((left, right) => left.title.localeCompare(right.title, 'ru'));
	const storeIdByTitle = new Map(stores.map((store) => [normalizedStoreTitle(store.title), store.id]));
	const rows = base.data.rows.map((row) => {
		const stockByStore: Record<number, number> = {};
		for (const [title, quantity] of Object.entries(live.stocks.get(row.id) ?? {})) {
			const storeId = storeIdByTitle.get(normalizedStoreTitle(title));
			if (storeId !== undefined) stockByStore[storeId] = (stockByStore[storeId] ?? 0) + quantity;
		}
		return {
			...row,
			stockByStore,
			total: Object.values(stockByStore).reduce((sum, quantity) => sum + quantity, 0),
		};
	});
	return { data: { rows, generatedAt: live.generatedAt }, stores };
}

/** Reuses the exact live stock read already made for the legacy side of a shadow request. */
export function liveCatalogStockFromBase(base: CatalogProductBase): LiveCatalogStock {
	const titleById = new Map(base.stores.map((store) => [store.id, store.title]));
	const stocks = new Map<number, Record<string, number>>();
	for (const row of base.data.rows) {
		const byTitle: Record<string, number> = {};
		for (const [storeIdText, quantity] of Object.entries(row.stockByStore)) {
			const title = titleById.get(Number(storeIdText));
			if (title) byTitle[title] = Number(quantity);
		}
		if (Object.keys(byTitle).length) stocks.set(row.id, byTitle);
	}
	return {
		stocks,
		storeTitles: base.stores.filter((store) => store.active).map((store) => store.title),
		generatedAt: base.data.generatedAt,
	};
}
