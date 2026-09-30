import type { B24Client } from './b24/client.js';
import type { ErpClient } from './erp/client.js';
import { fetchErpStocksFor, listDealPlan, listDealRealizations } from './erp/operations.js';
import { listCoreSupplyCards, type SupplyCard } from './deal-supply-cards.js';

export function validateDealRepeatOrder(
	cards: SupplyCard[], lines: Array<{ productId: number; qty: number }>,
	remaining: ReadonlyMap<number, number>, stock: ReadonlyMap<number, number>,
): void {
	const requested = new Map<number, number>();
	for (const line of lines) requested.set(line.productId, (requested.get(line.productId) ?? 0) + line.qty);
	for (const [productId, qty] of requested) {
		const history = cards.filter((card) => card.source === 'core' && card.productIds?.includes(productId));
		if (history.some((card) => card.closed !== true)) {
			throw new Error(`По товару #${productId} ещё не выполнена предыдущая заявка. Обновите сделку.`);
		}
		if (!history.length) continue;
		const shortage = Math.max((remaining.get(productId) ?? 0) - Math.max(stock.get(productId) ?? 0, 0), 0);
		if (qty > shortage + 0.000001) {
			throw new Error(`По товару #${productId} на выбранном складе не хватает ${shortage}. Повторный заказ превышает нехватку; обновите сделку и проверьте количество.`);
		}
	}
}

/** Fresh server check protects a repeated order from stale UI and duplicate clicks. */
export async function assertDealSupplyOrderAllowed(
	erp: ErpClient, client: B24Client, dealId: number, toStore: string,
	lines: Array<{ productId: number; qty: number }>,
): Promise<void> {
	const cards = await listCoreSupplyCards(dealId, client, erp);
	const ids = lines.map((line) => line.productId);
	if (!cards.some((card) => card.productIds?.some((id) => ids.includes(id)))) return;
	const [plan, realizations, stocks] = await Promise.all([
		listDealPlan(erp, dealId), listDealRealizations(erp, dealId), fetchErpStocksFor(erp, ids),
	]);
	const remaining = new Map<number, number>();
	for (const line of plan) remaining.set(line.productId, (remaining.get(line.productId) ?? 0) + line.qty);
	for (const doc of realizations) for (const line of doc.items) {
		remaining.set(line.productId, (remaining.get(line.productId) ?? 0) - line.qty);
	}
	validateDealRepeatOrder(cards, lines, remaining, new Map(ids.map((id) => [id, stocks.get(id)?.[toStore] ?? 0])));
}
