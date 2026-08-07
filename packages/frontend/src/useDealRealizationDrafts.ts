import { useState } from 'react';
import type { TableData } from './deal-products-table-types.js';

export function useDealRealizationDrafts(documents: TableData['coreReals']) {
	const [draftNames, setDraftNames] = useState<string[]>([]);
	const persistedDraftNames = documents
		.filter((document) => !document.submitted && !document.isReturn)
		.map((document) => document.name);
	const pendingDraftNames = [...new Set([...persistedDraftNames, ...draftNames])];
	return {
		pendingDraftNames,
		hasPendingDrafts: pendingDraftNames.length > 0,
		setDraftNames,
	};
}
