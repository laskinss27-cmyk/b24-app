import type { EnrichedRow } from './deal-products-table-types.js';

export interface DealProductRowEdit {
	qty: string;
	price: string;
	disc: string;
}

export function dealProductLine(row: EnrichedRow): number {
	return row.price * row.quantity;
}

/** Скидка строки в % (по сохранённой скидке за единицу): база = итог + скидка. */
export function dealProductDiscountPercent(row: EnrichedRow): number {
	const base = row.price + row.discountSum;
	return base > 0 && row.discountSum > 0
		? Math.round((row.discountSum / base) * 1000) / 10
		: 0;
}

export function dealProductBasePrice(row: EnrichedRow): number {
	return row.price + row.discountSum;
}

/** Итоговая цена за единицу из текущих правок (база · скидка). */
export function dealProductFinalUnit(edit: DealProductRowEdit): number {
	const price = Number(edit.price.replace(',', '.')) || 0;
	const discount = Number(edit.disc.replace(',', '.')) || 0;
	return Math.round(price * (1 - discount / 100) * 100) / 100;
}

/** Наценка относительно закупочной цены; считаем от фактической цены продажи после скидки. */
export function dealProductMarkupPercent(row: EnrichedRow, edit: DealProductRowEdit): number | null {
	if (row.purchasingPrice == null || row.purchasingPrice <= 0) return null;
	return Math.round(((dealProductFinalUnit(edit) - row.purchasingPrice) / row.purchasingPrice) * 1000) / 10;
}

export function dealProductMarkupText(row: EnrichedRow, edit: DealProductRowEdit): string {
	const value = dealProductMarkupPercent(row, edit);
	return value == null ? '—' : `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

// Строка товара — из плана ядра (id вида 'plan-<productId>'); работы — из Б24 (числовой rowId).
export function isPlanRow(row: EnrichedRow): boolean {
	return String(row.id).startsWith('plan-');
}

export function isVariantRow(row: EnrichedRow): boolean {
	return String(row.id).startsWith('variant-');
}
