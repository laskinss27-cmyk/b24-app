import type { ErpClient } from './client.js';
import { listWithBatchedInFilters } from './list-batched.js';

// 0.01 is the technical valuation used by stock migration/reconciliation when cost is unknown.
export const usablePurchasePrice = (value: unknown): boolean => Number.isFinite(Number(value)) && Number(value) > 0.01;

/** Fill missing catalog costs without changing receipts, price lists or stock valuation.
 * Historical valuation remains available after the last unit has been sold.
 */
export async function fillMissingPurchasePrices(
	erp: ErpClient,
	prices: Map<number, number>,
	productIds?: number[],
): Promise<void> {
	const ids = productIds && [...new Set(productIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
	if (ids?.length === 0) return;
	const fields = ['name', 'last_purchase_rate', 'valuation_rate'];
	const items = ids
		? await listWithBatchedInFilters(erp, 'Item', fields, [['name', 'in', ids.map(String)]])
		: await erp.list('Item', fields, [['disabled', '=', 0]]);
	const unresolved = new Set<number>();
	for (const item of items) {
		const id = Number(item['name']);
		if (!Number.isSafeInteger(id) || id <= 0 || usablePurchasePrice(prices.get(id))) continue;
		const fallback = [item['last_purchase_rate'], item['valuation_rate']].find(usablePurchasePrice);
		if (fallback !== undefined) prices.set(id, Number(fallback));
		else { if (prices.has(id)) prices.set(id, 0); unresolved.add(id); }
	}
	if (!unresolved.size) return;
	const ledgerFields = ['name', 'item_code', 'valuation_rate', 'posting_date', 'posting_time', 'creation'];
	const filters: unknown[] = [['is_cancelled', '=', 0], ['valuation_rate', '>', 0.01]];
	// Catalog-wide reads need only one ledger query; targeted deal reads use bounded IN filters.
	const ledger = ids
		? await listWithBatchedInFilters(erp, 'Stock Ledger Entry', ledgerFields, [...filters, ['item_code', 'in', [...unresolved].map(String)]])
		: await erp.list('Stock Ledger Entry', ledgerFields, filters);
	const key = (row: Record<string, unknown>): string => `${row['posting_date']} ${String(row['posting_time'] ?? '0:0:0').split(':').map((part, index) => index === 2 ? Number(part).toFixed(6).padStart(9, '0') : part.padStart(2, '0')).join(':')} ${row['creation'] ?? ''} ${row['name'] ?? ''}`;
	const latest = new Map<number, Record<string, unknown>>();
	for (const row of ledger) {
		const id = Number(row['item_code']);
		if (!unresolved.has(id) || !usablePurchasePrice(row['valuation_rate'])) continue;
		const previous = latest.get(id);
		if (!previous || key(row) > key(previous)) latest.set(id, row);
	}
	for (const [id, row] of latest) prices.set(id, Number(row['valuation_rate']));
}
