import type { ErpClient } from './client.js';
import { listWithBatchedInFilters } from './list-batched.js';

// 0.01 is the technical valuation used by stock migration/reconciliation when cost is unknown.
export const usablePurchasePrice = (value: unknown): boolean => Number.isFinite(Number(value)) && Number(value) > 0.01;

const postingKey = (row: Record<string, unknown>): string => `${row['posting_date']} ${String(row['posting_time'] ?? '0:0:0').split(':').map((part, index) => index === 2 ? Number(part).toFixed(6).padStart(9, '0') : part.padStart(2, '0')).join(':')} ${row['creation'] ?? ''} ${row['name'] ?? ''} ${String(row['idx'] ?? 0).padStart(8, '0')}`;
const timestampKey = (value: unknown): string => {
	const [seconds, fraction = ''] = String(value ?? '').split('.');
	return `${seconds}.${fraction.padEnd(6, '0')}`;
};

/** Current reference cost: latest posted purchase, or a catalog edit made after it.
 * Read the submitted documents directly so cancellation/amendment cannot leave a stale
 * copied price behind. base_rate / conversion_factor is company currency per stock unit.
 */
export async function resolvePurchasePrices(
	erp: ErpClient,
	prices: Map<number, number>,
	catalogModified: Map<number, string>,
	productIds?: number[],
): Promise<void> {
	if (productIds?.length === 0) return;
	const wanted = productIds && new Set(productIds);
	// One parent/child join also covers the catalog; no per-receipt requests or long IN URLs.
	const rows = await erp.list('Purchase Receipt', [
		'name', 'docstatus', 'is_return', 'posting_date', 'posting_time', 'creation', 'modified',
		'items.item_code', 'items.base_rate', 'items.conversion_factor', 'items.qty', 'items.idx',
	], [['docstatus', '=', 1], ['is_return', '=', 0]]);
	const latest = new Map<number, Record<string, unknown>>();
	for (const row of rows) {
		const id = Number(row['item_code']);
		const factor = Number(row['conversion_factor']);
		if (!Number.isSafeInteger(id) || id <= 0 || (wanted && !wanted.has(id))
			|| Number(row['docstatus']) !== 1 || Number(row['is_return']) !== 0
			|| !(Number(row['qty']) > 0) || !(factor > 0)
			|| !usablePurchasePrice(Number(row['base_rate']) / factor)) continue;
		const previous = latest.get(id);
		if (!previous || postingKey(row) > postingKey(previous)) latest.set(id, row);
	}
	for (const [id, row] of latest) {
		// ERP timestamps use the same timezone/format; pad the optional fractional part.
		const manualAt = timestampKey(catalogModified.get(id));
		const receiptAt = timestampKey(row['modified'] ?? row['creation']);
		if (usablePurchasePrice(prices.get(id)) && manualAt > receiptAt) continue;
		prices.set(id, Number(row['base_rate']) / Number(row['conversion_factor']));
	}
	await fillMissingPurchasePrices(erp, prices, productIds);
}

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
	const latest = new Map<number, Record<string, unknown>>();
	for (const row of ledger) {
		const id = Number(row['item_code']);
		if (!unresolved.has(id) || !usablePurchasePrice(row['valuation_rate'])) continue;
		const previous = latest.get(id);
		if (!previous || postingKey(row) > postingKey(previous)) latest.set(id, row);
	}
	for (const [id, row] of latest) prices.set(id, Number(row['valuation_rate']));
}
