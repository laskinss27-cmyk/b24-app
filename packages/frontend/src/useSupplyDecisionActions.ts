import { useState, type Dispatch, type SetStateAction } from 'react';
import {
	decisionGroups,
	decisionLinesForOrder,
	makeDecision,
	requestItemsForOrder,
	rowKey,
	type DecisionMap,
	type DecisionState,
} from './supply-decision-planning.js';
import { createSupplyDocuments, type SupplyOrderRow } from './b24.js';

type UseSupplyDecisionActionsOptions = {
	mock: boolean;
	setOrders: Dispatch<SetStateAction<SupplyOrderRow[]>>;
	setNotice: Dispatch<SetStateAction<string | null>>;
	reload: () => Promise<void>;
};

type SupplyDecisionActions = {
	decisions: DecisionMap;
	busy: string | null;
	reviewing: string;
	creationErrors: Record<string, string>;
	patchDecision: (key: string, id: string, patch: Partial<DecisionState>) => void;
	addDecision: (key: string, qty: number) => void;
	removeDecision: (key: string, id: string) => void;
	clearOrderDecisions: (orderName: string) => void;
	startReview: (orderName: string) => void;
	cancelReview: () => void;
	createDocs: (order: SupplyOrderRow) => Promise<void>;
};

export function useSupplyDecisionActions({
	mock,
	setOrders,
	setNotice,
	reload,
}: UseSupplyDecisionActionsOptions): SupplyDecisionActions {
	const [decisions, setDecisions] = useState<DecisionMap>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [reviewing, setReviewing] = useState('');
	const [creationErrors, setCreationErrors] = useState<Record<string, string>>({});

	const patchDecision = (key: string, id: string, patch: Partial<DecisionState>): void => {
		setReviewing('');
		setDecisions((current) => {
			const rows = current[key] ?? [{ ...makeDecision(key, 1), id }];
			return { ...current, [key]: rows.map((row) => row.id === id ? { ...row, ...patch } : row) };
		});
	};

	const addDecision = (key: string, qty: number): void => {
		setReviewing('');
		setDecisions((current) => ({ ...current, [key]: [...(current[key] ?? [{ ...makeDecision(key, qty), id: `${key}:initial` }]), makeDecision(key, qty)] }));
	};

	const removeDecision = (key: string, id: string): void => {
		setReviewing('');
		setDecisions((current) => {
			const nextRows = (current[key] ?? []).filter((row) => row.id !== id);
			return { ...current, [key]: nextRows.length ? nextRows : [makeDecision(key, 1)] };
		});
	};

	const clearOrderDecisions = (orderName: string): void => {
		setDecisions((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${orderName}:`))));
	};

	const startReview = (orderName: string): void => {
		setCreationErrors((current) => ({ ...current, [orderName]: '' }));
		setReviewing(orderName);
	};

	const cancelReview = (): void => setReviewing('');

	const createDocs = async (order: SupplyOrderRow): Promise<void> => {
		const lines = decisionLinesForOrder(order, decisions);
		if (!lines.length) {
			setNotice('Выбери действие хотя бы по одной строке заявки.');
			return;
		}
		setBusy(order.name);
		setCreationErrors((current) => ({ ...current, [order.name]: '' }));
		try {
			const transferPlan = decisionGroups(lines, 'transfer');
			const purchasePlan = decisionGroups(lines, 'purchase');
			let createdTransferCount = transferPlan.length;
			let createdPurchaseCount = purchasePlan.length;
			let updatedPurchaseCount = 0;
			if (mock) {
				setOrders((current) => current.map((row) => row.name === order.name ? {
					...row,
					items: row.items.map((item) => {
						const covered = lines.filter((line) => line.productId === item.productId).reduce((sum, line) => sum + line.qty, 0);
						return { ...item, qty: Math.max(item.qty - covered, 0) };
					}).filter((item) => item.qty > 0),
					transfers: [...(row.transfers ?? []), ...transferPlan.map((group, i) => ({ id: Date.now() + i, name: `TRN-DEMO-${i + 1}`, status: 'in_transit', fromStore: group.key, toStore: row.toStore, lines: group.lines.map((line) => ({ productId: line.productId, name: line.itemName, qty: line.qty })), receivedLines: [], shortageLines: [] }))],
					purchases: [...(row.purchases ?? []), ...purchasePlan.map((group, i) => ({ name: `PUR-DEMO-${i + 1}`, supplier: group.key, status: 'Draft', supplyStage: 'draft', lines: group.lines.map((line) => ({ productId: line.productId, name: line.itemName, qty: line.qty, rate: 0 })), receipts: [] }))],
				} : row));
			} else {
				const created = await createSupplyDocuments({ requestName: order.name, requestKey: order.requestKey, dealId: Number(order.dealId), toStore: order.toStore, lines });
				createdTransferCount = created.transfers.length;
				createdPurchaseCount = created.purchases.length;
				updatedPurchaseCount = created.updatedPurchases.length;
				await reload();
			}
			setDecisions((current) => {
				const next = { ...current };
				requestItemsForOrder(order).forEach((item, index) => { delete next[rowKey(order.name, item.productId, index)]; });
				return next;
			});
			setReviewing('');
			setCreationErrors((current) => ({ ...current, [order.name]: '' }));
			const parts = [
				createdTransferCount ? `Создано перемещений: ${createdTransferCount} (товар в транзите)` : '',
				createdPurchaseCount ? `Создано заявок поставщику: ${createdPurchaseCount} (черновики)` : '',
				updatedPurchaseCount ? `Дополнено черновиков: ${updatedPurchaseCount}` : '',
			].filter(Boolean);
			setNotice(`Готово. ${parts.join('; ')}.`);
		} catch (err) {
			if (!mock) await reload().catch(() => undefined);
			const message = err instanceof Error ? err.message : String(err);
			setCreationErrors((current) => ({ ...current, [order.name]: message }));
			setNotice(message);
		} finally {
			setBusy(null);
		}
	};

	return {
		decisions,
		busy,
		reviewing,
		creationErrors,
		patchDecision,
		addDecision,
		removeDecision,
		clearOrderDecisions,
		startReview,
		cancelReview,
		createDocs,
	};
}
