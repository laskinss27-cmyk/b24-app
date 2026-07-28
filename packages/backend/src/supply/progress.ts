export interface SupplyProgressLine {
	productId: number;
	qty: number;
	warehouse?: string;
	requestQty?: number;
}

export interface SupplyProgressPurchase {
	lines: SupplyProgressLine[];
	receipts: Array<{ docstatus?: number; lines: SupplyProgressLine[] }>;
}

const storeKey = (value: string | undefined): string =>
	String(value ?? '').trim().toLocaleLowerCase('ru-RU');

/**
 * Фактическое выполнение заявки прямой поставкой.
 *
 * Приход засчитывается только когда он проведён на склад назначения самой заявки.
 * Количество ограничивается долей исходной заявки, закреплённой за закупкой:
 * лишний товар в заказе поставщику не должен случайно закрыть заявку.
 */
export function directReceiptFulfillment(
	toStore: string,
	purchases: SupplyProgressPurchase[],
): SupplyProgressLine[] {
	const destination = storeKey(toStore);
	if (!destination) return [];

	const fulfilled = new Map<number, number>();
	for (const purchase of purchases) {
		const allocated = new Map<number, number>();
		for (const line of purchase.lines) {
			const requestQty = Number(line.requestQty ?? line.qty);
			const qty = Math.min(Math.max(Number(line.qty) || 0, 0), Math.max(requestQty || 0, 0));
			if (Number.isInteger(line.productId) && line.productId > 0 && qty > 0) {
				allocated.set(line.productId, (allocated.get(line.productId) ?? 0) + qty);
			}
		}

		const received = new Map<number, number>();
		for (const receipt of purchase.receipts) {
			if (receipt.docstatus !== 1) continue;
			for (const line of receipt.lines) {
				if (storeKey(line.warehouse) !== destination) continue;
				const qty = Math.max(Number(line.qty) || 0, 0);
				if (Number.isInteger(line.productId) && line.productId > 0 && qty > 0) {
					received.set(line.productId, (received.get(line.productId) ?? 0) + qty);
				}
			}
		}

		for (const [productId, allocatedQty] of allocated.entries()) {
			const qty = Math.min(allocatedQty, received.get(productId) ?? 0);
			if (qty > 0) fulfilled.set(productId, (fulfilled.get(productId) ?? 0) + qty);
		}
	}

	return [...fulfilled.entries()].map(([productId, qty]) => ({ productId, qty }));
}
