import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { SupplyOrderRow } from './b24.js';
import type { OpenSupplyDocument } from './SupplyDocumentDetail.js';
import type { SupplyViewKey } from './SupplyNavigation.js';

type UseSupplyDeepLinksOptions = {
	contextTransferId: number | null | undefined;
	dealSupplyId: number;
	loading: boolean;
	orders: SupplyOrderRow[];
	setView: Dispatch<SetStateAction<SupplyViewKey>>;
	setOpenDocument: Dispatch<SetStateAction<OpenSupplyDocument | null>>;
	setExpanded: Dispatch<SetStateAction<string>>;
};

export function useSupplyDeepLinks({
	contextTransferId,
	dealSupplyId,
	loading,
	orders,
	setView,
	setOpenDocument,
	setExpanded,
}: UseSupplyDeepLinksOptions): void {
	const [deepLinkHandled, setDeepLinkHandled] = useState(false);

	useEffect(() => {
		if (loading || deepLinkHandled) return;
		const queryId = Number(new URLSearchParams(window.location.search).get('transfer') ?? 0);
		const transferId = Number(contextTransferId ?? queryId);
		if (Number.isInteger(transferId) && transferId > 0) {
			for (const order of orders) {
				const transfer = (order.transfers ?? []).find((row) => row.id === transferId);
				if (!transfer) continue;
				setView('logistics');
				setOpenDocument({ kind: 'transfer', order, transfer });
				break;
			}
		}
		setDeepLinkHandled(true);
	}, [contextTransferId, deepLinkHandled, loading, orders, setOpenDocument, setView]);

	useEffect(() => {
		if (loading || dealSupplyId <= 0) return;
		const order = orders.find((item) => Number(item.dealId) === dealSupplyId);
		if (!order) return;
		setView('orders');
		setExpanded(order.name);
	}, [dealSupplyId, loading, orders, setExpanded, setView]);
}
