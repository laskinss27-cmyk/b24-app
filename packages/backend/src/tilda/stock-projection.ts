export type TildaMappingStatus = 'confirmed' | 'unresolved' | 'ignored';

export interface TildaProductMapping {
	productId: number;
	tildaUid: string;
	externalId: string;
	sku: string;
	title: string;
	status: TildaMappingStatus;
}

export interface TildaStockOffer {
	productId: number;
	tildaUid: string;
	externalId: string;
	sku: string;
	title: string;
	quantity: number;
}

export interface TildaStockPreview {
	offers: TildaStockOffer[];
	skipped: Array<TildaProductMapping & { reason: 'mapping_not_confirmed' }>;
	excludedStores: string[];
}

export const DEFAULT_TILDA_EXCLUDED_STORES = ['Goods In Transit', 'Склад Прихода'] as const;

function normalizedStore(value: string): string {
	return value.trim().toLocaleLowerCase('ru');
}

function sellableQuantity(stocks: Record<string, number>, excludedStores: Set<string>): number {
	const total = Object.entries(stocks).reduce((sum, [store, rawQuantity]) => {
		if (excludedStores.has(normalizedStore(store))) return sum;
		const quantity = Number(rawQuantity);
		return Number.isFinite(quantity) ? sum + quantity : sum;
	}, 0);
	return Math.max(0, Math.floor(total));
}

export function buildTildaStockPreview(
	mappings: TildaProductMapping[],
	stocksByProduct: Map<number, Record<string, number>>,
	excludedStoreNames: readonly string[] = DEFAULT_TILDA_EXCLUDED_STORES,
): TildaStockPreview {
	const excludedStores = new Set(excludedStoreNames.map(normalizedStore));
	const seenExternalIds = new Set<string>();
	const seenTildaUids = new Set<string>();
	const offers: TildaStockOffer[] = [];
	const skipped: TildaStockPreview['skipped'] = [];

	for (const mapping of mappings) {
		if (mapping.status !== 'confirmed') {
			skipped.push({ ...mapping, reason: 'mapping_not_confirmed' });
			continue;
		}
		if (!Number.isInteger(mapping.productId) || mapping.productId <= 0) {
			throw new Error(`invalid ERP product id: ${mapping.productId}`);
		}
		const externalId = mapping.externalId.trim();
		const tildaUid = mapping.tildaUid.trim();
		if (!externalId || !tildaUid) throw new Error(`confirmed Tilda mapping for #${mapping.productId} has no identifiers`);
		if (seenExternalIds.has(externalId)) throw new Error(`duplicate Tilda external id: ${externalId}`);
		if (seenTildaUids.has(tildaUid)) throw new Error(`duplicate Tilda UID: ${tildaUid}`);
		seenExternalIds.add(externalId);
		seenTildaUids.add(tildaUid);
		offers.push({
			productId: mapping.productId,
			tildaUid,
			externalId,
			sku: mapping.sku.trim(),
			title: mapping.title.trim(),
			quantity: sellableQuantity(stocksByProduct.get(mapping.productId) ?? {}, excludedStores),
		});
	}

	offers.sort((left, right) => left.externalId.localeCompare(right.externalId));
	return { offers, skipped, excludedStores: [...excludedStoreNames] };
}
