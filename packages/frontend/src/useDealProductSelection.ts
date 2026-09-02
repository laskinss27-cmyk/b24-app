import { useState } from 'react';
import type { EnrichedRow } from './deal-products-table-types.js';

export function selectionForRows(current: Record<string, boolean>, rowIds: readonly string[], selected: boolean): Record<string, boolean> {
	const next = { ...current };
	for (const rowId of rowIds) next[rowId] = selected;
	return next;
}

export function useDealProductSelection() {
	const [selected, setSelected] = useState<Record<string, boolean>>({});
	const isSelected = (row: EnrichedRow): boolean => selected[row.id] ?? false;
	const toggleSelected = (row: EnrichedRow): void => {
		setSelected((selection) => ({
			...selection,
			[row.id]: !(selection[row.id] ?? false),
		}));
	};
	return { selected, setSelected, isSelected, toggleSelected };
}
