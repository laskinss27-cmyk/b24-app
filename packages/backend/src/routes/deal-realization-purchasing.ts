import { dealLinePurchasingPrice, isPassThroughProduct } from '@b24-app/shared';
import type { ErpClient } from '../erp/client.js';
import type { B24Client } from '../b24/client.js';
import { canonicalProductId } from '../product-aliases.js';
import { fetchDealCatalogPurchasing } from './catalog-purchasing.js';

/** isService may only come from server-side classification, never the request body. */
export async function assertDealRealizationPurchasing(
	erp: ErpClient,
	client: B24Client,
	lines: Array<{ productId: number; rate: number; itemName?: string; isService?: boolean }>,
): Promise<void> {
	const candidates = lines.filter(line => !line.isService);
	const ids = [...new Set(candidates.map(line => canonicalProductId(line.productId)))];
	if (!ids.length) return;
	const items = await erp.list<Record<string, unknown>>('Item', ['name', 'item_name', 'is_stock_item', 'last_purchase_rate'], [['name', 'in', ids.map(String)]], 0);
	const byId = new Map(items.map(item => [Number(item['name']), item]));
	// A missing card or unknown item type must not silently exempt goods from validation.
	const goods = candidates.filter(line => {
		const stock = byId.get(canonicalProductId(line.productId))?.['is_stock_item'];
		return stock !== 0 && stock !== '0' && stock !== false;
	});
	const priceIds = [...new Set(goods.filter(line => !isPassThroughProduct(line.productId)).map(line => canonicalProductId(line.productId)))];
	// Always read fresh prices, without the catalog display cache.
	const prices = priceIds.length ? await fetchDealCatalogPurchasing(erp, client, priceIds) : new Map<number, number>();
	const invalid = new Map<number, string>();
	for (const line of goods) {
		const id = canonicalProductId(line.productId);
		const catalogPrice = prices.get(id);
		const lastPurchaseRate = Number(byId.get(id)?.['last_purchase_rate']);
		// A submitted Purchase Receipt updates last_purchase_rate even when the
		// Standard Buying list has not been updated. It is a valid document-backed
		// valuation source for realization, and is never exposed to the browser.
		const purchasingPrice = catalogPrice != null && Number.isFinite(catalogPrice) && catalogPrice > 0
			? catalogPrice
			: Number.isFinite(lastPurchaseRate) && lastPurchaseRate > 0
				? lastPurchaseRate
				: catalogPrice;
		const price = dealLinePurchasingPrice(line.productId, line.rate, purchasingPrice);
		if (price != null && Number.isFinite(price) && price > 0) continue;
		const name = String(line.itemName || byId.get(id)?.['item_name'] || `Товар #${line.productId}`);
		invalid.set(line.productId, `${name} (#${line.productId})`);
	}
	if (invalid.size) throw new Error(`Реализация запрещена: не заполнена закупочная цена товаров: ${[...invalid.values()].join('; ')}. Обратитесь в снабжение: необходимо заполнить закупочную цену больше 0 ₽, затем повторить реализацию.`);
}
