import type { ErpClient } from '../erp/client.js';
import { fetchErpStocksFor } from '../erp/stock-catalog.js';
import { b24StoreTitle, erpContext } from '../erp/warehouse-context.js';
import { TILDA_STOCK_SOURCE_STORE } from './stock-projection.js';

function normalizedStore(value: unknown): string {
	return String(value ?? '').trim().toLocaleLowerCase('ru');
}

export async function fetchCompleteTildaErpStocks(
	erp: ErpClient,
	productIds: number[],
): Promise<Map<number, Record<string, number>>> {
	const ids = [...new Set(productIds)];
	const found = new Set<number>();
	for (let index = 0; index < ids.length; index += 200) {
		const chunk = ids.slice(index, index + 200).map(String);
		const items = await erp.list('Item', ['name'], [
			['name', 'in', chunk],
			['disabled', '=', 0],
		]);
		for (const item of items) {
			const productId = Number(item['name']);
			if (Number.isInteger(productId) && productId > 0) found.add(productId);
		}
	}
	const missing = ids.filter((productId) => !found.has(productId));
	if (missing.length) throw new Error(`Confirmed ERP Items are missing or disabled: ${missing.join(', ')}`);

	const context = await erpContext(erp);
	const warehouses = await erp.list('Warehouse', ['name'], [
		['is_group', '=', 0],
		['disabled', '=', 0],
	]);
	const sourceStoreExists = warehouses.some((warehouse) => (
		normalizedStore(b24StoreTitle(context, String(warehouse['name'] ?? '')))
		=== normalizedStore(TILDA_STOCK_SOURCE_STORE)
	));
	if (!sourceStoreExists) {
		throw new Error(`Tilda stock source warehouse is missing or disabled: ${TILDA_STOCK_SOURCE_STORE}`);
	}

	const stocks = await fetchErpStocksFor(erp, ids);
	for (const productId of ids) {
		if (!stocks.has(productId)) stocks.set(productId, {});
	}
	return stocks;
}
