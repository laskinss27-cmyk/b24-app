import type { ProductBaseData } from '../b24/catalog.js';
import type { ErpClient } from '../erp/client.js';
import {
	coreStoreId,
	fetchCoreCatalogItems,
	fetchCoreCatalogPrices,
	fetchErpStocks,
	listActiveStoreTitles,
} from '../erp/operations.js';
import type { CatalogStore, CoreProductBaseRow } from './api-catalog-types.js';
import { coreSectionId, normalizedStoreTitle } from './api-catalog-value-helpers.js';

export async function buildCoreProductBase(erp: ErpClient, metadata: ProductBaseData): Promise<{
	data: { rows: CoreProductBaseRow[]; generatedAt: string };
	stores: CatalogStore[];
}> {
	const [items, stocks, prices, storeTitles] = await Promise.all([
		fetchCoreCatalogItems(erp),
		fetchErpStocks(erp),
		fetchCoreCatalogPrices(erp),
		listActiveStoreTitles(erp),
	]);
	const stores = storeTitles.map((title) => ({ id: coreStoreId(title), title, active: true }));
	const storeIdByTitle = new Map(stores.map((store) => [normalizedStoreTitle(store.title), store.id]));
	const metadataById = new Map(metadata.rows.map((row) => [row.id, row]));
	const rows = items.map((item) => {
		const known = metadataById.get(item.productId);
		const stockByStore: Record<number, number> = {};
		for (const [title, qty] of Object.entries(stocks.get(item.productId) ?? {})) {
			const storeId = storeIdByTitle.get(normalizedStoreTitle(title));
			if (storeId != null) stockByStore[storeId] = (stockByStore[storeId] ?? 0) + qty;
		}
		const corePrices = prices.get(item.productId);
		const sectionName = item.section || known?.sectionName;
		const photoPath = item.image
			? `/api/inventory/erp-image?p=${encodeURIComponent(item.image)}`
			: known?.photoPath;
		return {
			id: item.productId,
			iblockId: known?.iblockId ?? 24,
			name: item.name || known?.name || `#${item.productId}`,
			isService: item.isService,
			isMarketplaceBundle: item.isMarketplaceBundle,
			article: item.article || known?.article,
			model: item.model || known?.model,
			manufacturer: item.manufacturer || known?.manufacturer,
			sectionId: known?.sectionId ?? (sectionName ? coreSectionId(sectionName) : undefined),
			sectionName,
			status: item.status || known?.status,
			description: item.description || known?.description,
			...(item.content ? { content: item.content } : {}),
			filterCategory: item.filterCategory,
			marketplaceOldId: item.marketplaceOldId,
			retail: corePrices?.retail ?? known?.retail ?? null,
			purchase: corePrices?.purchase ?? known?.purchase ?? null,
			photoPath,
			total: Object.values(stockByStore).reduce((sum, qty) => sum + qty, 0),
			stockByStore,
		};
	});
	rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
	stores.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
	return { data: { rows, generatedAt: new Date().toISOString() }, stores };
}
