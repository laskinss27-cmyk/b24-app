import type { ErpClient } from './erp/client.js';
import type { SubmittedInventoryResult } from './inventory-stock-snapshot.js';

/** Read retail RUB prices only. Do not change catalog prices or stock valuation. */
export async function priceInventoryResult(erp: ErpClient, result: SubmittedInventoryResult): Promise<SubmittedInventoryResult> {
	const ids = [...new Set(result.lines.map((line) => line.productId))];
	const prices = new Map<number, number>();
	const ambiguous = new Set<number>();
	for (let start = 0; start < ids.length; start += 200) {
		const rows = await erp.list('Item Price', ['item_code', 'price_list_rate', 'currency'], [
			['price_list', '=', 'Standard Selling'], ['item_code', 'in', ids.slice(start, start + 200).map(String)],
		], 0);
		for (const row of rows) {
			const id = Number(row['item_code']);
			const raw = row['price_list_rate'];
			if (raw == null || raw === '' || String(row['currency']) !== 'RUB') continue;
			const price = Number(raw);
			if (!Number.isFinite(price) || price < 0) continue;
			const rounded = Math.round(price * 1e9) / 1e9;
			if (prices.has(id) && prices.get(id) !== rounded) ambiguous.add(id);
			prices.set(id, rounded);
		}
	}
	return { ...result, lines: result.lines.map((line) => {
		const { retailPrice: _ignored, ...saved } = line;
		const price = prices.get(line.productId);
		return { ...saved, ...(price !== undefined && !ambiguous.has(line.productId) ? { retailPrice: price } : {}) };
	}) };
}
