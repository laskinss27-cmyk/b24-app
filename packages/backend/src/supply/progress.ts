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

export interface SupplyRequestProgress<T> {
	remaining: T[];
	unfulfilled: T[];
	closed: boolean;
}

/** Quantities in purchase-origin transfers that are not already represented by their purchases. */
export function coverageBeyondBaseline(
	coverage: ReadonlyMap<number, number>,
	baseline: ReadonlyMap<number, number>,
): SupplyProgressLine[] {
	return [...coverage.entries()]
		.map(([productId, qty]) => ({ productId, qty: Math.max(qty - (baseline.get(productId) ?? 0), 0) }))
		.filter((line) => line.qty > 0);
}

/**
 * Operational progress of a supply request.
 *
 * A cancelled purchase removes its attached quantity from the demand: it must
 * neither return to allocation nor keep the request open. The purchase itself
 * remains available as history.
 */
export function calculateRequestProgress<T extends { productId: number; qty: number }>(
	items: readonly T[],
	planned: ReadonlyMap<number, number>,
	fulfilled: ReadonlyMap<number, number>,
	cancelled: ReadonlyMap<number, number>,
): SupplyRequestProgress<T> {
	const uncovered = (item: T, covered: ReadonlyMap<number, number>): T => ({
		...item,
		qty: Math.max(item.qty - (covered.get(item.productId) ?? 0) - (cancelled.get(item.productId) ?? 0), 0),
	});
	const remaining = items.map((item) => uncovered(item, planned)).filter((item) => item.qty > 0);
	const unfulfilled = items.map((item) => uncovered(item, fulfilled)).filter((item) => item.qty > 0);
	return { remaining, unfulfilled, closed: items.length > 0 && unfulfilled.length === 0 };
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
