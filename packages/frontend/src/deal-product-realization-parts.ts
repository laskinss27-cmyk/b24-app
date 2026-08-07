import type { CoreRealization } from './b24.js';
import type { EnrichedRow } from './deal-products-table-types.js';

export interface DealProductRealizationPart {
	name: string;
	submitted: boolean;
	isReturn: boolean;
	qty: number;
	storeName: string;
}

/** Партии строки — реализации из ядра (черновики и проведённые), связь по productId. */
export function dealProductRealizationParts(row: EnrichedRow, realizations: CoreRealization[]): DealProductRealizationPart[] {
	const segmentId = row.segmentKind === 'stage' && row.stageId ? `stage:${row.stageId}` : 'base';
	const matchesRow = (item: CoreRealization['items'][number]): boolean =>
		item.productId === row.productId && (!row.segmentKind || (item.segmentId || 'base') === segmentId);
	const linkedReturns = new Map<string, number>();
	let unlinkedReturns = 0;
	for (const document of realizations.filter((item) => item.isReturn && item.submitted)) {
		const qty = Math.abs(document.items
			.filter(matchesRow)
			.reduce((sum, item) => sum + item.qty, 0));
		if (qty <= 0.000001) continue;
		if (document.returnAgainst) linkedReturns.set(document.returnAgainst, (linkedReturns.get(document.returnAgainst) ?? 0) + qty);
		else unlinkedReturns += qty;
	}
	return realizations
		.filter((realization) => !realization.isReturn)
		.map((realization): DealProductRealizationPart | null => {
			const items = realization.items.filter(matchesRow);
			if (!items.length) return null;
			const gross = items.reduce((sum, item) => sum + item.qty, 0);
			const linked = linkedReturns.get(realization.name) ?? 0;
			const fallback = realization.submitted ? Math.min(Math.max(gross - linked, 0), unlinkedReturns) : 0;
			unlinkedReturns -= fallback;
			const qty = Math.max(0, gross - linked - fallback);
			if (qty <= 0.000001) return null;
			return { name: realization.name, submitted: realization.submitted, isReturn: false, qty, storeName: items[0]!.storeTitle };
		})
		.filter((part): part is DealProductRealizationPart => part != null);
}
