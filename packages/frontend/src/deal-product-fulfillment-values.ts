import type { CoreRealization } from './b24.js';
import type { EnrichedRow } from './deal-products-table-types.js';

function rowSegmentId(row: EnrichedRow): string {
	return row.segmentKind === 'stage' && row.stageId ? `stage:${row.stageId}` : 'base';
}

export function dealProductRealizedProductQuantity(productId: number, realizations: CoreRealization[]): number {
	return realizations.reduce((total, realization) =>
		total + realization.items
			.filter((item) => item.productId === productId)
			.reduce((sum, item) => sum + item.qty, 0), 0);
}

export function dealProductRealizedQuantity(row: EnrichedRow, realizations: CoreRealization[]): number {
	if (!row.segmentKind) {
		return dealProductRealizedProductQuantity(row.productId, realizations);
	}

	const segmentId = rowSegmentId(row);
	return realizations.reduce((total, realization) =>
		total + realization.items
			.filter((item) => item.productId === row.productId && (item.segmentId || 'base') === segmentId)
			.reduce((sum, item) => sum + item.qty, 0), 0);
}

export function dealProductShippedQuantity(row: EnrichedRow, realizations: CoreRealization[]): number {
	const submitted = realizations.filter((realization) => realization.submitted);
	if (!row.segmentKind) {
		return Math.max(0, submitted.reduce((total, realization) =>
			total + realization.items
				.filter((item) => item.productId === row.productId)
				.reduce((sum, item) => sum + item.qty, 0), 0));
	}

	const segmentId = rowSegmentId(row);
	return Math.max(0, submitted.reduce((total, realization) =>
		total + realization.items
			.filter((item) => item.productId === row.productId && (item.segmentId || 'base') === segmentId)
			.reduce((sum, item) => sum + item.qty, 0), 0));
}

export function dealProductRemainingQuantity(row: EnrichedRow, realizations: CoreRealization[]): number {
	return Math.max(0, row.quantity - dealProductRealizedQuantity(row, realizations));
}

export function dealProductSelectedQuantity(row: EnrichedRow, realizations: CoreRealization[], entered: string | undefined): number {
	const remaining = dealProductRemainingQuantity(row, realizations);
	const value = Number(String(entered ?? remaining).replace(',', '.')) || 0;
	return Math.min(Math.max(0, value), remaining);
}
