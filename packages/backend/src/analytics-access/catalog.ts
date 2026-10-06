import { isRetiredConsumablesProduct } from '@b24-app/shared';
import { ErpClient } from '../erp/client.js';
import { fetchCoreCatalogPrices, ITEM_GROUP } from '../erp/stock-catalog.js';
import { MARKETPLACE_OLD_ID_FIELD } from '../erp/marketplace-fields.js';
import { splitCatalogProductNameStatus } from '../catalog-product-status.js';
import { usablePurchasePrice } from '../erp/purchase-prices.js';

export interface AnalyticsCatalog {
	readStartedAt: string;
	generatedAt: string;
	warehouses: Array<{ id: string; name: string; type: string; disabled: boolean }>;
	products: Array<{ id: number; oldId: string; article: string; name: string; brand: string; model: string;
		section: string; status: string; unit: string; purchasePrice: number | null;
		stocks: Array<{ warehouseId: string; physicalQuantity: number }> }>;
}

/** Allow only list calls even if a reused reader later tries to perform setup/mutations. */
export function analyticsReadClient(erp: ErpClient): ErpClient {
	return new Proxy(erp, { get(target, property) {
		if (property === 'list') return target.list.bind(target);
		throw new Error('Analytics data source permits list reads only');
	} });
}

export async function readAnalyticsCatalog(source: ErpClient | null = ErpClient.fromEnv()): Promise<AnalyticsCatalog> {
	if (!source) throw new Error('ERP unavailable');
	const erp = analyticsReadClient(source), readStartedAt = new Date().toISOString();
	// No setup helpers, no metadata fallback from Bitrix, no generic proxy to ERP doctypes.
	const [items, bins, warehouses, prices] = await Promise.all([
		erp.list('Item', ['name', 'item_name', 'b24_article', 'b24_model', 'b24_brand', 'b24_section', 'b24_product_status', 'stock_uom', MARKETPLACE_OLD_ID_FIELD],
			[['item_group', '=', ITEM_GROUP], ['disabled', '=', 0], ['is_stock_item', '=', 1]]),
		erp.list('Bin', ['item_code', 'warehouse', 'actual_qty']),
		erp.list('Warehouse', ['name', 'warehouse_name', 'warehouse_type', 'disabled'], [['is_group', '=', 0]]),
		fetchCoreCatalogPrices(erp),
	]);
	const byProduct = new Map<number, Array<{ warehouseId: string; physicalQuantity: number }>>();
	const warehouseIds = new Set(warehouses.map(w => String(w.name)));
	for (const row of bins) {
		const id = Number(row.item_code);
		if (!Number.isSafeInteger(id) || id <= 0) continue;
		if (row.actual_qty == null || row.actual_qty === '' || !Number.isFinite(Number(row.actual_qty)) || !warehouseIds.has(String(row.warehouse))) throw new Error('Incomplete stock data');
		const values = byProduct.get(id) ?? [];
		values.push({ warehouseId: String(row.warehouse), physicalQuantity: Number(row.actual_qty) });
		byProduct.set(id, values);
	}
	return {
		readStartedAt, generatedAt: new Date().toISOString(),
		warehouses: warehouses.map(w => ({ id: String(w.name), name: String(w.warehouse_name || w.name), type: String(w.warehouse_type ?? ''), disabled: Boolean(Number(w.disabled)) })).sort((a,b) => a.id.localeCompare(b.id)),
		products: items.filter(row => Number.isSafeInteger(Number(row.name)) && Number(row.name) > 0 && !isRetiredConsumablesProduct(Number(row.name))).map(row => {
			const id = Number(row.name), identity = splitCatalogProductNameStatus(row.item_name, row.b24_product_status), purchase = prices.get(id)?.purchase;
			return { id, oldId: String(row[MARKETPLACE_OLD_ID_FIELD] ?? ''), article: String(row.b24_article ?? ''), name: identity.name,
				brand: String(row.b24_brand ?? ''), model: String(row.b24_model ?? ''), section: String(row.b24_section ?? ''), status: identity.status,
				unit: String(row.stock_uom ?? ''), purchasePrice: usablePurchasePrice(purchase) ? purchase! : null,
				stocks: (byProduct.get(id) ?? []).sort((a,b) => a.warehouseId.localeCompare(b.warehouseId)) };
		}).sort((a,b) => a.id - b.id),
	};
}
