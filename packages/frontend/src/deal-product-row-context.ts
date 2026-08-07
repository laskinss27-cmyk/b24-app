import type { TransferDoc } from './b24.js';
import {
	dealProductActiveSupply,
	dealProductActiveTransfer,
	dealProductAvailabilityStatus,
	dealProductReceivedTransfer,
	dealProductSelectedStoreId,
	dealProductStockAmount,
	dealProductStoreName,
	dealProductTotalStock,
} from './deal-product-availability.js';
import {
	dealProductRealizedQuantity,
	dealProductRemainingQuantity,
	dealProductSelectedQuantity,
	dealProductShippedQuantity,
} from './deal-product-fulfillment-values.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';

export function createDealProductRowContext({
	data,
	batchQty,
	rowStore,
	realizeStore,
	dealTransfers,
}: {
	data: TableData;
	batchQty: Record<string, string>;
	rowStore: Record<string, number>;
	realizeStore: number;
	dealTransfers: TransferDoc[];
}) {
	const realizedForRow = (row: EnrichedRow): number => dealProductRealizedQuantity(row, data.coreReals);
	const shippedForRow = (row: EnrichedRow): number => dealProductShippedQuantity(row, data.coreReals);
	const remaining = (row: EnrichedRow): number => dealProductRemainingQuantity(row, data.coreReals);
	const qtyOf = (row: EnrichedRow): number => dealProductSelectedQuantity(row, data.coreReals, batchQty[row.id]);

	// ── Склад на строке → статус → группировка по складам ──
	const storeOf = (row: EnrichedRow): number => dealProductSelectedStoreId(row, rowStore, realizeStore);
	const amountAt = (row: EnrichedRow, storeId: number): number => dealProductStockAmount(row, storeId);
	const totalStock = (row: EnrichedRow): number => dealProductTotalStock(row);
	const rowStatus = (row: EnrichedRow) => dealProductAvailabilityStatus(row, qtyOf(row), storeOf(row));
	const storeName = (storeId: number): string => dealProductStoreName(data.stores, storeId);
	/** Незакрытое перемещение по этому товару (запрошено/в пути) — чтобы показать статус вместо кнопки. */
	const activeTransferOf = (row: EnrichedRow): TransferDoc | null => dealProductActiveTransfer(row, dealTransfers);
	/** Полученное перемещение по товару: товар уже на складе Б, но остаток открытой вкладки мог не обновиться. */
	const receivedTransferOf = (row: EnrichedRow): TransferDoc | null => dealProductReceivedTransfer(row, dealTransfers);
	const activeSupplyOf = (row: EnrichedRow) => dealProductActiveSupply(row, data.supply);

	return {
		realizedForRow,
		shippedForRow,
		remaining,
		qtyOf,
		storeOf,
		amountAt,
		totalStock,
		rowStatus,
		storeName,
		activeTransferOf,
		receivedTransferOf,
		activeSupplyOf,
	};
}
