import {
	type SupplyDecisionAction,
	type SupplyDecisionLine,
	type SupplyOrderItem,
	type SupplyOrderRow,
} from './b24.js';

export interface DecisionState {
	id: string;
	action: SupplyDecisionAction | '';
	qty: number;
	fromStore: string;
	supplier: string;
}

export type DecisionMap = Record<string, DecisionState[]>;

export const requestItemsForOrder = (order: SupplyOrderRow): SupplyOrderItem[] => order.items ?? [];

export const rowKey = (orderName: string, productId: number, index: number): string => `${orderName}:${productId}:${index}`;

let allocationSequence = 0;

export const makeDecision = (key: string, qty: number): DecisionState => ({
	id: `${key}:allocation-${allocationSequence++}`,
	action: '',
	qty: Math.max(1, qty),
	fromStore: '',
	supplier: '',
});

export const decisionsForRow = (decisions: DecisionMap, key: string, qty: number): DecisionState[] =>
	decisions[key] ?? [{ ...makeDecision(key, qty), id: `${key}:initial` }];

export const decisionReady = (decision: DecisionState): boolean =>
	Boolean(decision.action && (decision.action === 'transfer' ? decision.fromStore : decision.supplier.trim()));

export function decisionLinesForOrder(order: SupplyOrderRow, decisions: DecisionMap): SupplyDecisionLine[] {
	return requestItemsForOrder(order).flatMap((item, index) => {
		const key = rowKey(order.name, item.productId, index);
		return decisionsForRow(decisions, key, item.qty)
			.filter(decisionReady)
			.map((decision) => ({
				productId: item.productId,
				itemName: item.itemName || `#${item.productId}`,
				qty: Math.max(1, Number(decision.qty || 1)),
				action: decision.action as SupplyDecisionAction,
				...(decision.fromStore ? { fromStore: decision.fromStore } : {}),
				...(decision.supplier.trim() ? { supplier: decision.supplier.trim() } : {}),
			}));
	});
}

/** Check a reviewed plan against a freshly loaded request before writing documents. */
export function decisionPlanFitsCurrentRequest(
	previous: SupplyOrderRow,
	current: SupplyOrderRow | undefined,
	lines: SupplyDecisionLine[],
): boolean {
	if (!current || current.requestKey !== previous.requestKey || current.toStore !== previous.toStore || current.closed) return false;
	const remaining = new Map<number, number>();
	for (const item of requestItemsForOrder(current)) {
		remaining.set(item.productId, (remaining.get(item.productId) ?? 0) + item.qty);
	}
	for (const line of lines) {
		const available = remaining.get(line.productId) ?? 0;
		if (line.qty > available + 0.0001) return false;
		remaining.set(line.productId, available - line.qty);
	}
	return true;
}

export function decisionGroups(lines: SupplyDecisionLine[], action: SupplyDecisionAction): Array<{ key: string; lines: SupplyDecisionLine[] }> {
	const groups = new Map<string, SupplyDecisionLine[]>();
	for (const line of lines.filter((item) => item.action === action)) {
		const key = action === 'transfer' ? String(line.fromStore ?? '') : String(line.supplier ?? '');
		groups.set(key, [...(groups.get(key) ?? []), line]);
	}
	return [...groups.entries()].map(([key, groupedLines]) => ({ key, lines: groupedLines }));
}
