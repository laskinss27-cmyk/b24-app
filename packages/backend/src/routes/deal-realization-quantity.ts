export interface DealRealizationPlanLine {
	productId: number;
	qty: number;
	lineKey?: string;
}

export interface DealRealizationStage {
	id: string;
	items: Array<{ productId: number; qty: number }>;
}

export interface DealRealizationHistory {
	items: Array<{ productId: number; qty: number; segmentId?: string }>;
}

export interface DealRealizationRequestLine {
	productId: number;
	qty: number;
	segmentId: string;
}

const identity = (productId: number, segmentId: string): string => `${productId}\u0000${segmentId || 'base'}`;

export function assertDealRealizationQuantityAvailable(
	plan: DealRealizationPlanLine[],
	stages: DealRealizationStage[],
	history: DealRealizationHistory[],
	requested: DealRealizationRequestLine[],
): void {
	const budgets = new Map<string, number>();
	const remainingStageQty = new Map<number, number>();
	for (const stage of stages) for (const item of stage.items) {
		remainingStageQty.set(item.productId, (remainingStageQty.get(item.productId) ?? 0) + item.qty);
		const key = identity(item.productId, `stage:${stage.id}`);
		budgets.set(key, (budgets.get(key) ?? 0) + item.qty);
	}
	for (const line of plan) {
		const staged = Math.min(line.qty, remainingStageQty.get(line.productId) ?? 0);
		remainingStageQty.set(line.productId, Math.max(0, (remainingStageQty.get(line.productId) ?? 0) - staged));
		const baseQty = Math.max(0, line.qty - staged);
		const key = identity(line.productId, line.lineKey ? `line:${line.lineKey}` : 'base');
		budgets.set(key, (budgets.get(key) ?? 0) + baseQty);
	}

	const used = new Map<string, number>();
	for (const document of history) for (const item of document.items) {
		const key = identity(item.productId, item.segmentId || 'base');
		used.set(key, (used.get(key) ?? 0) + item.qty);
	}
	const wanted = new Map<string, number>();
	for (const line of requested) {
		const key = identity(line.productId, line.segmentId || 'base');
		wanted.set(key, (wanted.get(key) ?? 0) + line.qty);
	}
	for (const [key, qty] of wanted) {
		const available = Math.max(0, (budgets.get(key) ?? 0) - (used.get(key) ?? 0));
		if (qty > available + 0.000001) {
			const productId = Number(key.slice(0, key.indexOf('\u0000')));
			throw new Error(`товар #${productId}: в плане осталось ${available}, к реализации передано ${qty}`);
		}
	}
}
