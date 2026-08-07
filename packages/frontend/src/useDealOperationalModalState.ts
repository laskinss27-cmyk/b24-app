import { useState } from 'react';
import type { EnrichedRow } from './deal-products-table-types.js';

export function useDealTransferSplitState() {
	const [splitRow, setSplitRow] = useState<EnrichedRow | null>(null);
	return { splitRow, setSplitRow };
}

export function useDealReturnModalState() {
	const [showReturn, setShowReturn] = useState(false);
	return { showReturn, setShowReturn };
}

export function useDealContractModalState() {
	const [showContract, setShowContract] = useState(false);
	return { showContract, setShowContract };
}
