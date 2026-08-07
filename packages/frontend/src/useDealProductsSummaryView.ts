import { useState } from 'react';
import type { EnrichedRow } from './deal-products-table-types.js';
import { isPlanRow } from './deal-product-row-values.js';

export function useDealProductsSummaryView({
	hasStages,
	tableEditable,
}: {
	hasStages: boolean;
	tableEditable: boolean;
}) {
	const [summaryView, setSummaryView] = useState(false);
	const segmentActionsBlocked = summaryView && hasStages;
	const rowEditable = (row: EnrichedRow): boolean =>
		tableEditable && !(segmentActionsBlocked && isPlanRow(row));
	return { summaryView, setSummaryView, segmentActionsBlocked, rowEditable };
}
