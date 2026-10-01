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
	// Old documents use "base" while the same order now has stable line keys.
	// Reconcile only a unique base line; never guess among repeated product rows.
	const requestedProducts = new Set(requested.map((line) => line.productId));
	for (const [key, qty] of [...used]) {
		if (Math.abs(qty) <= 0.000001 || budgets.has(key)) continue;
		const split = key.indexOf('\u0000');
		const productId = Number(key.slice(0, split));
		if (!requestedProducts.has(productId)) continue;
		const segment = key.slice(split + 1);
		const candidates = [...budgets.keys()].filter((candidate) => candidate.startsWith(`${productId}\u0000line:`) && (budgets.get(candidate) ?? 0) > 0);
		if (segment !== 'base' || candidates.length !== 1 || qty < 0) {
			throw new Error(`товар #${productId}: не удалось однозначно связать прежнюю реализацию со строкой плана — требуется сверка`);
		}
		const target = candidates[0]!;
		used.set(target, (used.get(target) ?? 0) + qty);
		used.delete(key);
	}
	const wanted = new Map<string, number>();
	for (const line of requested) {
		let key = identity(line.productId, line.segmentId || 'base');
		if ((!line.segmentId || line.segmentId === 'base') && !budgets.has(key)) {
			const candidates = [...budgets.keys()].filter((candidate) => candidate.startsWith(`${line.productId}\u0000line:`) && (budgets.get(candidate) ?? 0) > 0);
			if (candidates.length !== 1) throw new Error(`товар #${line.productId}: не удалось однозначно связать черновик со строкой плана — требуется сверка`);
			key = candidates[0]!;
		}
		wanted.set(key, (wanted.get(key) ?? 0) + line.qty);
	}
	for (const [key, qty] of wanted) {
		const available = Math.max(0, (budgets.get(key) ?? 0) - (used.get(key) ?? 0));
		if (qty > available + 0.000001) {
			const productId = Number(key.slice(0, key.indexOf('\u0000')));
			throw new Error(`товар #${productId}: в плане осталось ${available}, к реализации передано ${qty}`);
		}
	}
	// Segment changes must never create an extra product allowance.
	for (const productId of requestedProducts) {
		const planned = plan.filter((line) => line.productId === productId).reduce((sum, line) => sum + line.qty, 0);
		const consumed = history.flatMap((doc) => doc.items).filter((line) => line.productId === productId).reduce((sum, line) => sum + line.qty, 0);
		const quantity = requested.filter((line) => line.productId === productId).reduce((sum, line) => sum + line.qty, 0);
		const available = Math.max(0, planned - Math.max(0, consumed));
		if (quantity > available + 0.000001) throw new Error(`товар #${productId}: всего в плане осталось ${available}, к реализации передано ${quantity}`);
	}

}
