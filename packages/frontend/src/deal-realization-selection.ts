import { isWorkRow } from './b24.js';
import type { DealProductAvailabilityStatus } from './deal-product-availability.js';
import type { EnrichedRow } from './deal-products-table-types.js';

export function buildDealRealizationSelection({
	visibleGoods,
	selected,
	segmentActionsBlocked,
	remaining,
	rowStatus,
	storeOf,
}: {
	visibleGoods: EnrichedRow[];
	selected: Record<string, boolean>;
	segmentActionsBlocked: boolean;
	remaining: (row: EnrichedRow) => number;
	rowStatus: (row: EnrichedRow) => DealProductAvailabilityStatus;
	storeOf: (row: EnrichedRow) => number;
}) {
	const canRealize = (row: EnrichedRow): boolean =>
		!row.manual && !isWorkRow(row.type) && !segmentActionsBlocked && remaining(row) > 0 && rowStatus(row) === 'ready';
	// В реализацию идут ТОЛЬКО отмеченные галочкой строки (дефолт — ничего не отмечено).
	const selectedRows = visibleGoods.filter((row) => !row.manual && !isWorkRow(row.type) && (selected[row.id] ?? false) && remaining(row) > 0);
	const blockedSelectedGoods = selectedRows.filter((row) => !isWorkRow(row.type) && !canRealize(row));
	const readyRows = selectedRows.filter(canRealize);
	const readyGoods = readyRows.filter((row) => !isWorkRow(row.type));
	const realizeGroups = new Map<number, EnrichedRow[]>();
	for (const row of readyGoods) {
		const storeId = storeOf(row);
		if (!realizeGroups.has(storeId)) realizeGroups.set(storeId, []);
		realizeGroups.get(storeId)!.push(row);
	}
	const realizeDocumentCount = realizeGroups.size;

	return { blockedSelectedGoods, readyRows, realizeGroups, realizeDocumentCount };
}
