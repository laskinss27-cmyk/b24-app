import { type B24Client, type BatchCall } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import { fetchErpRetailPrices } from './erp/operations.js';
import {
	B24_COLLAPSE_SERVICE_PRODUCT_ID,
	setDealB24CollapsedService,
} from './deal-service.js';

export const VYEZD_PRODUCT_ID = B24_COLLAPSE_SERVICE_PRODUCT_ID;
export const CORE_ENGINEER_VISIT_SERVICE_ID = 9814001;
export const legacyB24CompositionDisabled = (): boolean => true;

/** Поставить в Б24-сделку одну служебную строку на сумму total (или очистить, если total<=0). */
export async function setDealB24Service(client: B24Client, dealId: number, total: number): Promise<void> {
	await setDealB24CollapsedService(client, dealId, total);
}

/** Розничная цена из ядра. Старый каталог Б24 остаётся fallback для ещё не перенесённых цен. */
export async function fetchBasePrices(client: B24Client, ids: number[]): Promise<Map<number, number>> {
	const map = new Map<number, number>();
	const uniq = [...new Set(ids.filter((x) => x > 0))];
	if (!uniq.length) return map;
	const erp = ErpClient.fromEnv();
	if (erp) {
		try {
			const corePrices = await fetchErpRetailPrices(erp, uniq);
			for (const [productId, price] of corePrices) map.set(productId, price);
		} catch { /* Для старых цен ниже остаётся read-only fallback Б24. */ }
	}
	const missing = uniq.filter((productId) => !map.has(productId));
	if (!missing.length) return map;
	const calls: Record<string, BatchCall> = {};
	for (const id of missing) calls[`pr${id}`] = { method: 'catalog.price.list', params: { filter: { productId: id, catalogGroupId: 2 }, select: ['productId', 'price'] } };
	const res = await client.callBatch(calls);
	for (const id of missing) {
		const pr = (res.result[`pr${id}`] as { prices?: Array<Record<string, unknown>> } | undefined)?.prices?.[0];
		if (pr) map.set(id, Number(pr['price'] ?? 0));
	}
	return map;
}

export async function fetchServiceProductIds(client: B24Client, ids: number[]): Promise<Set<number>> {
	const out = new Set<number>();
	const uniq = [...new Set(ids.filter((x) => x > 0 && x !== CORE_ENGINEER_VISIT_SERVICE_ID))];
	if (!uniq.length) return out;
	const calls: Record<string, BatchCall> = {};
	for (const id of uniq) calls[`p${id}`] = { method: 'catalog.product.get', params: { id } };
	const res = await client.callBatch(calls);
	for (const id of uniq) {
		const product = (res.result[`p${id}`] as { product?: Record<string, unknown> } | undefined)?.product;
		if (Number(product?.['type'] ?? 0) === 7) out.add(id);
	}
	out.add(CORE_ENGINEER_VISIT_SERVICE_ID);
	return out;
}
