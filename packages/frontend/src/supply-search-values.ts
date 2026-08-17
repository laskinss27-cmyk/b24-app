import { type SupplyOrderRow, type SupplyPurchaseChild, type SupplyTransferChild } from './b24.js';
import { requestItemsForOrder } from './supply-decision-planning.js';
import { transferNumberSearchValues } from './transfer-number.js';

export const searchMatches = (query: string, values: Array<string | number | undefined>): boolean => {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const haystack = values.map((value) => String(value ?? '')).join(' ').toLowerCase();
	return words.every((word) => haystack.includes(word));
};
export const orderSearchValues = (order: SupplyOrderRow): Array<string | number | undefined> => [
	order.name,
	order.dealId,
	order.dealTitle,
	order.toStore,
	order.deadline,
	order.note,
	...requestItemsForOrder(order).flatMap((item) => [item.productId, item.itemName, ...Object.keys(item.stocks ?? {})]),
	...(order.originalItems ?? []).flatMap((item) => [item.productId, item.itemName, ...Object.keys(item.stocks ?? {})]),
	...(order.purchases ?? []).flatMap((purchase) => [purchase.name, purchase.supplier, ...purchase.lines.flatMap((line) => [line.productId, line.name])]),
	...(order.transfers ?? []).flatMap((transfer) => [...transferNumberSearchValues(transfer), transfer.name, transfer.fromStore, transfer.toStore, ...transfer.lines.flatMap((line) => [line.productId, line.name])]),
];
export const purchaseSearchValues = (order: SupplyOrderRow, purchase: SupplyPurchaseChild): Array<string | number | undefined> => [
	order.name, order.dealId, order.dealTitle, order.toStore, purchase.name, purchase.supplier,
	...purchase.lines.flatMap((line) => [line.productId, line.name, line.warehouse]),
	...purchase.receipts.flatMap((receipt) => [receipt.name, ...receipt.lines.flatMap((line) => [line.productId, line.name, line.warehouse])]),
];
export const transferSearchValues = (order: SupplyOrderRow, transfer: SupplyTransferChild): Array<string | number | undefined> => [
	order.name, order.dealId, order.dealTitle, order.toStore, ...transferNumberSearchValues(transfer), transfer.name, transfer.purchaseOrder, transfer.fromStore, transfer.toStore,
	...transfer.lines.flatMap((line) => [line.productId, line.name, line.warehouse]),
];
