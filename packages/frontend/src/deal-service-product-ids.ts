/** Исторические карточки, которые в сделке проводятся без склада как услуги. */
const DEAL_SERVICE_PRODUCT_IDS = new Set([
	9814001,
	18816,
]);

export function isDealServiceProductId(productId: number): boolean {
	return DEAL_SERVICE_PRODUCT_IDS.has(productId);
}
