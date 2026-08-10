import type { BaseRow, StoreInfo } from './b24.js';
import type { CatalogSortKey, CatalogTableRow } from './CatalogProductTable.js';

export interface IndexedCatalogRow {
	d: BaseRow;
	search: string;
	stockEntries: Array<{ id: number; qty: number }>;
}

export function indexCatalogRows(
	rows: BaseRow[],
	allowedStoreTitles: string[],
	visibleStoreIds: Set<number>,
	marketplaceMode: boolean,
	excludedProductId: number,
): IndexedCatalogRow[] {
	return rows
		.filter((row) => row.id !== excludedProductId)
		.filter((row) =>
			!allowedStoreTitles.length
			|| row.isService
			|| Object.entries(row.stockByStore).some(([storeId, qty]) =>
				visibleStoreIds.has(Number(storeId)) && qty > 0))
		.map((row) => ({
			d: row,
			search: `${row.id} ${marketplaceMode ? row.marketplaceOldId ?? '' : ''} ${row.name} ${row.article ?? ''} ${row.manufacturer ?? ''} ${row.model ?? ''} ${row.sectionName ?? ''} ${row.status ?? ''}`.toLowerCase(),
			stockEntries: Object.entries(row.stockByStore)
				.map(([storeId, quantity]) => ({ id: Number(storeId), qty: quantity }))
				.filter((stock) => stock.qty > 0 && (!allowedStoreTitles.length || visibleStoreIds.has(stock.id)))
				.sort((a, b) => b.qty - a.qty),
		}));
}

export function catalogSections(rows: BaseRow[]): Array<{ id: number; name: string }> {
	const byId = new Map<number, string>();
	for (const row of rows) {
		if (row.sectionId && row.sectionName) byId.set(row.sectionId, row.sectionName);
	}
	return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export function buildCatalogView({
	indexedRows,
	query,
	onlyStock,
	kind,
	section,
	isAll,
	storeId,
	sortKey,
	sortDirection,
	restrictStores,
	visibleStores,
}: {
	indexedRows: IndexedCatalogRow[];
	query: string;
	onlyStock: boolean;
	kind: 'all' | 'goods' | 'services';
	section: string;
	isAll: boolean;
	storeId: number | null;
	sortKey: CatalogSortKey;
	sortDirection: 1 | -1;
	restrictStores: boolean;
	visibleStores: StoreInfo[];
}): CatalogTableRow[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	let list = indexedRows;
	// Фильтр остатка к услугам не применяем — у работ остатка нет (иначе «Услуги» давали бы пусто).
	if (kind === 'goods') list = list.filter((row) => !row.d.isService);
	else if (kind === 'services') list = list.filter((row) => row.d.isService);
	if (section !== 'all') list = list.filter((row) => row.d.sectionId === Number(section));
	if (words.length) list = list.filter((row) => words.every((word) => row.search.includes(word)));
	const allStoresQty = (row: BaseRow): number =>
		restrictStores
			? visibleStores.reduce((sum, item) => sum + Number(row.stockByStore[item.id] ?? 0), 0)
			: row.total;
	if (onlyStock && kind !== 'services') {
		list = list.filter((row) => (isAll ? allStoresQty(row.d) : (row.d.stockByStore[storeId as number] ?? 0)) > 0 || row.d.isService);
	}
	const withQty = list.map((row) => ({
		d: row.d,
		qty: isAll ? allStoresQty(row.d) : (row.d.stockByStore[storeId as number] ?? 0),
		others: row.stockEntries,
	}));
	const value = (row: { d: BaseRow; qty: number }): string | number => {
		switch (sortKey) {
			case 'id': return row.d.id;
			case 'marketplaceOldId': return row.d.marketplaceOldId ?? '';
			case 'name': return row.d.name;
			case 'model': return row.d.model ?? row.d.article ?? '';
			case 'manufacturer': return row.d.manufacturer ?? '';
			case 'section': return row.d.sectionName ?? '';
			case 'retail': return row.d.retail ?? -1;
			case 'purchase': return row.d.purchase ?? -1;
			case 'stock': return row.qty;
			case 'total': return row.d.total;
		}
	};
	withQty.sort((a, b) => {
		const left = value(a);
		const right = value(b);
		if (typeof left === 'number' && typeof right === 'number') return (left - right) * sortDirection;
		return String(left).localeCompare(String(right), 'ru') * sortDirection;
	});
	return withQty;
}
