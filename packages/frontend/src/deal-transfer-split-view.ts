import type { EnrichedRow } from './deal-products-table-types.js';

export function buildDealTransferSplitSources(
	row: EnrichedRow,
	destinationStoreId: number,
): Array<{ storeName: string; amount: number }> {
	return row.stocks
		.filter((stock) => stock.amount > 0 && stock.storeId !== destinationStoreId)
		.map((stock) => ({ storeName: stock.storeName, amount: stock.amount }));
}
