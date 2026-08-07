import type { StoreInfo, SupplyCard, TransferDoc } from './b24.js';
import type { EnrichedRow } from './deal-products-table-types.js';

export type DealProductAvailabilityStatus = 'ready' | 'transfer' | 'order';

export function dealProductSelectedStoreId(row: EnrichedRow, selectedStores: Record<string, number>, defaultStoreId: number): number {
	return selectedStores[row.id] ?? defaultStoreId;
}

export function dealProductStockAmount(row: EnrichedRow, storeId: number): number {
	return row.stocks.find((stock) => stock.storeId === storeId)?.amount ?? 0;
}

export function dealProductTotalStock(row: EnrichedRow): number {
	return row.stocks.reduce((total, stock) => total + stock.amount, 0);
}

export function dealProductAvailabilityStatus(row: EnrichedRow, selectedQuantity: number, storeId: number): DealProductAvailabilityStatus {
	if (selectedQuantity > 0 && dealProductStockAmount(row, storeId) >= selectedQuantity) return 'ready';
	if (dealProductTotalStock(row) > 0) return 'transfer';
	return 'order';
}

export function dealProductStoreName(stores: StoreInfo[], storeId: number): string {
	return stores.find((store) => store.id === storeId)?.title ?? `Склад #${storeId}`;
}

export function dealProductActiveTransfer(row: EnrichedRow, transfers: TransferDoc[]): TransferDoc | null {
	return transfers.find((transfer) =>
		!transfer.correctionOf
		&& ['draft', 'collected', 'requested', 'in_transit', 'accepted', 'shortage'].includes(transfer.status)
		&& transfer.lines.some((line) => line.productId === row.productId)) ?? null;
}

export function dealProductReceivedTransfer(row: EnrichedRow, transfers: TransferDoc[]): TransferDoc | null {
	return transfers.find((transfer) =>
		!transfer.correctionOf
		&& (transfer.status === 'received' || transfer.status === 'posted')
		&& transfer.lines.some((line) => line.productId === row.productId)) ?? null;
}

export function dealProductTransferLabel(transfer: TransferDoc): string {
	if (transfer.status === 'draft' || transfer.status === 'requested') return 'перемещение создано';
	if (transfer.status === 'collected') return 'собрано';
	if (transfer.status === 'in_transit') return 'в пути';
	if (transfer.status === 'accepted') return 'на проверке';
	return 'недовоз';
}

export function dealProductActiveSupply(row: EnrichedRow, supply: SupplyCard[]): SupplyCard | null {
	return supply.find((card) =>
		card.source === 'core'
		&& !/stopped|closed|completed|success|fail/i.test(card.stageId)
		&& (card.productIds ?? []).includes(row.productId)) ?? null;
}
