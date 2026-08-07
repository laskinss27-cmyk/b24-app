import { useState } from 'react';

export type DealWorkspaceNotice = { kind: 'ok' | 'err'; text: string };

export function useDealBatchQuantityState() {
	const [batchQty, setBatchQty] = useState<Record<string, string>>({});
	return { batchQty, setBatchQty };
}

export function useDealWorkspaceNoticeState() {
	const [notice, setNotice] = useState<DealWorkspaceNotice | null>(null);
	return { notice, setNotice };
}

export function useDealRealizationBusyState() {
	const [busy, setBusy] = useState(false);
	return { busy, setBusy };
}
