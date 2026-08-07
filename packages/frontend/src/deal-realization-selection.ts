import { isWorkRow } from './b24.js';
import type { DealProductAvailabilityStatus } from './deal-product-availability.js';
import type { EnrichedRow } from './deal-products-table-types.js';

export function buildDealRealizationSelection({
	visibleGoods,
	visibleWorks,
	selected,
	segmentActionsBlocked,
	remaining,
	rowStatus,
	storeOf,
}: {
	visibleGoods: EnrichedRow[];
	visibleWorks: EnrichedRow[];
	selected: Record<string, boolean>;
	segmentActionsBlocked: boolean;
	remaining: (row: EnrichedRow) => number;
	rowStatus: (row: EnrichedRow) => DealProductAvailabilityStatus;
	storeOf: (row: EnrichedRow) => number;
}) {
	const canRealize = (row: EnrichedRow): boolean =>
		!segmentActionsBlocked && remaining(row) > 0 && (isWorkRow(row.type) || rowStatus(row) === 'ready');
	// В реализацию идут ТОЛЬКО отмеченные галочкой строки (дефолт — ничего не отмечено).
	const selectedRows = [...visibleGoods, ...visibleWorks].filter((row) => (selected[row.id] ?? false) && remaining(row) > 0);
	const blockedSelectedGoods = selectedRows.filter((row) => !isWorkRow(row.type) && !canRealize(row));
	const readyRows = selectedRows.filter(canRealize);
	const readyGoods = readyRows.filter((row) => !isWorkRow(row.type));
	const readyWorks = readyRows.filter((row) => isWorkRow(row.type));
	const realizeGroups = new Map<number, EnrichedRow[]>();
	for (const row of readyGoods) {
		const storeId = storeOf(row);
		if (!realizeGroups.has(storeId)) realizeGroups.set(storeId, []);
		realizeGroups.get(storeId)!.push(row);
	}
	const realizeDocumentCount = realizeGroups.size || (readyWorks.length ? 1 : 0);

	return { blockedSelectedGoods, readyRows, readyWorks, realizeGroups, realizeDocumentCount };
}
