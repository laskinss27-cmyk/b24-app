import type { SupplyCard } from './b24.js';
import { dealProductActiveSupplyQuantity } from './deal-product-availability.js';
import type { EnrichedRow } from './deal-products-table-types.js';

export interface DealSupplySelection {
	rows: EnrichedRow[];
	availableByRow: Map<string, number>;
}

/**
 * Материальные заявки ядра не хранят сегмент строки сделки, только товар и количество.
 * Поэтому считаем незакрытую потребность по товару целиком, а затем распределяем её только
 * между отмеченными строками. Так новый сегмент товара можно заказать, даже если старая
 * заявка уже покрыла предыдущую часть плана, но две отмеченные строки не задублируют остаток.
 */
export function buildDealSupplySelection({
	rows,
	supply,
	isSelected,
	remaining,
}: {
	rows: EnrichedRow[];
	supply: SupplyCard[];
	isSelected: (row: EnrichedRow) => boolean;
	remaining: (row: EnrichedRow) => number;
}): DealSupplySelection {
	const demandByProduct = new Map<number, number>();
	for (const row of rows) {
		const quantity = Math.max(0, remaining(row));
		demandByProduct.set(row.productId, (demandByProduct.get(row.productId) ?? 0) + quantity);
	}

	const uncoveredByProduct = new Map<number, number>();
	for (const [productId, demand] of demandByProduct) {
		uncoveredByProduct.set(productId, Math.max(0, demand - dealProductActiveSupplyQuantity(productId, supply)));
	}

	const selectedRows: EnrichedRow[] = [];
	const availableByRow = new Map<string, number>();
	for (const row of rows) {
		if (!isSelected(row)) continue;
		const rowRemaining = Math.max(0, remaining(row));
		const productRemaining = uncoveredByProduct.get(row.productId) ?? 0;
		const available = Math.min(rowRemaining, productRemaining);
		if (available <= 0) continue;
		selectedRows.push(row);
		availableByRow.set(row.id, available);
		uncoveredByProduct.set(row.productId, Math.max(0, productRemaining - available));
	}

	return { rows: selectedRows, availableByRow };
}
