import { dealProductRealizedProductQuantity } from './deal-product-fulfillment-values.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';

export function buildDealReturnableProducts(
	goods: EnrichedRow[],
	documents: TableData['coreReals'],
) {
	return goods
		.filter((row) => dealProductRealizedProductQuantity(row.productId, documents) > 0)
		.map((row) => ({
			productId: row.productId,
			name: row.name,
			shipped: dealProductRealizedProductQuantity(row.productId, documents),
			measure: row.measure,
		}));
}
