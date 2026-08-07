import { useState } from 'react';
import type { DealProductRowEdit } from './deal-product-row-values.js';

export function useDealProductRowMutationState() {
	const [removing, setRemoving] = useState<string | null>(null);
	const [rowEdits, setRowEdits] = useState<Record<string, DealProductRowEdit>>({});
	const [savingRow, setSavingRow] = useState<string | null>(null);
	return {
		removing,
		setRemoving,
		rowEdits,
		setRowEdits,
		savingRow,
		setSavingRow,
	};
}
