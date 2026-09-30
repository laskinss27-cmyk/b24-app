import type { B24Client } from './b24/client.js';
import type { ErpClient } from './erp/client.js';
import { listCoreSupplyCards, type SupplyCard } from './deal-supply-cards.js';

export function validateDealRepeatOrder(
	cards: SupplyCard[], lines: Array<{ productId: number; qty: number }>,
): void {
	for (const productId of new Set(lines.map((line) => line.productId))) {
		const history = cards.filter((card) => card.source === 'core' && card.productIds?.includes(productId));
		if (history.some((card) => card.closed !== true)) {
			throw new Error(`По товару #${productId} ещё не выполнена предыдущая заявка. Обновите сделку.`);
		}
	}
}

/** Fresh server check protects a repeated order from stale UI and duplicate clicks. */
export async function assertDealSupplyOrderAllowed(
	erp: ErpClient, client: B24Client, dealId: number,
	lines: Array<{ productId: number; qty: number }>,
): Promise<void> {
	const cards = await listCoreSupplyCards(dealId, client, erp);
	// Book stock may be broken, missing or a display item. Staff choose the order quantity.
	validateDealRepeatOrder(cards, lines);
}
