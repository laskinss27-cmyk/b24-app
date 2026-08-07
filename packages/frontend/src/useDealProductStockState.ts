import { useState } from 'react';
import type { TableData } from './deal-products-table-types.js';

export function useDealProductRowStores() {
	const [rowStore, setRowStore] = useState<Record<string, number>>({});
	return { rowStore, setRowStore };
}

export function useDealProductStockExpansion() {
	const [expandedStocks, setExpandedStocks] = useState<Record<string, boolean>>({});
	return { expandedStocks, setExpandedStocks };
}

export function useDealDefaultRealizationStore(data: TableData): number {
	const [realizeStore] = useState<number>(() => {
		const sourceStoreId = data.sourceStoreId;
		return sourceStoreId != null && data.stores.some((store) => store.id === sourceStoreId)
			? sourceStoreId
			: (data.stores[0]?.id ?? 0);
	});
	return realizeStore;
}
