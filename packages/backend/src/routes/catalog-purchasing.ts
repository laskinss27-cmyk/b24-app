import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { fetchErpCatalogPurchasing } from '../erp/stock-catalog.js';

/** Same precedence in the catalog and deal: an explicit ERP price (including zero)
 * wins; legacy catalog price is used only when the ERP record is absent. */
export function catalogPurchasingPrice(core: number | null | undefined, legacy: number | null | undefined): number | null {
	return core ?? legacy ?? null;
}

function price(value: unknown): number | null {
	if (value == null || value === '') return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function parentId(product: Record<string, unknown>): number | null {
	const raw = product['parentId'];
	const id = Number(raw && typeof raw === 'object' ? (raw as { value?: unknown }).value : raw);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function readProducts(client: Pick<B24Client, 'callBatch'>, ids: number[]): Promise<Map<number, Record<string, unknown>>> {
	if (!ids.length) return new Map();
	const response = await client.callBatch(Object.fromEntries(ids.map(id => [`p${id}`, { method: 'catalog.product.get', params: { id } }])));
	const result = new Map<number, Record<string, unknown>>();
	for (const id of ids) {
		const error = response.result_error[`p${id}`];
		if (error) {
			// ERP-only items have no legacy card. Other failures must not look like a missing price.
			if (/NOT_FOUND/i.test(error.error) || (error.error === '' && error.error_description === 'product does not exist.')) continue;
			throw new Error(`Не удалось получить закупочную цену товара #${id} из каталога Б24`);
		}
		const payload = response.result[`p${id}`] as { product?: Record<string, unknown> } | undefined;
		if (payload?.product) result.set(id, payload.product);
	}
	return result;
}

export async function fetchDealCatalogPurchasing(
	erp: ErpClient,
	client: Pick<B24Client, 'callBatch'> | null,
	productIds: number[],
	legacyCache?: ReadonlyMap<number, number | null>,
): Promise<Map<number, number>> {
	const ids = [...new Set(productIds.filter(id => Number.isSafeInteger(id) && id > 0))];
	const result = await fetchErpCatalogPurchasing(erp, ids);
	const unresolved: number[] = [];
	for (const id of ids) {
		if (result.has(id)) continue;
		if (legacyCache?.has(id)) {
			const value = catalogPurchasingPrice(undefined, legacyCache.get(id));
			if (value != null) result.set(id, value);
		} else unresolved.push(id);
	}
	if (!unresolved.length) return result;
	if (!client) throw new Error('Не удалось проверить закупочные цены: требуется авторизация Б24');
	const products = await readProducts(client, unresolved);
	const parents = [...new Set([...products.values()].filter(p => Number(p['type']) === 4 && price(p['purchasingPrice']) == null).map(parentId).filter((id): id is number => id != null))];
	const parentProducts = await readProducts(client, parents);
	for (const id of unresolved) {
		const product = products.get(id);
		if (!product) continue;
		const parent = Number(product['type']) === 4 ? parentProducts.get(parentId(product) ?? 0) : undefined;
		const value = catalogPurchasingPrice(price(product['purchasingPrice']), price(parent?.['purchasingPrice']));
		if (value != null) result.set(id, value);
	}
	return result;
}
