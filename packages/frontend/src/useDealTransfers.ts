import { useEffect, useState } from 'react';
import { listTransfers, type TransferDoc } from './b24.js';

export function useDealTransfers(dealId: number | null): {
	dealTransfers: TransferDoc[];
	refreshDealTransfers: () => Promise<void>;
} {
	const [dealTransfers, setDealTransfers] = useState<TransferDoc[]>([]);

	useEffect(() => {
		if (dealId == null) { setDealTransfers([]); return; }
		let alive = true;
		listTransfers(dealId).then((result) => {
			if (alive) setDealTransfers(result.transfers);
		}).catch(() => {
			if (alive) setDealTransfers([]);
		});
		return () => { alive = false; };
	}, [dealId]);

	const refreshDealTransfers = async (): Promise<void> => {
		if (dealId == null) return;
		const fresh = await listTransfers(dealId).catch(() => null);
		if (fresh) setDealTransfers(fresh.transfers);
	};

	return { dealTransfers, refreshDealTransfers };
}
