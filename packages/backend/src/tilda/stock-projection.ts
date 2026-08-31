export type TildaMappingStatus = 'confirmed' | 'unresolved' | 'ignored';
export type TildaRowKind = 'parent' | 'variant';

export interface TildaProductMapping {
	productId: number;
	tildaUid: string;
	externalId: string;
	sku: string;
	title: string;
	status: TildaMappingStatus;
	rowKind?: TildaRowKind;
	parentTildaUid?: string | null;
}

export interface TildaStockOffer {
	productId: number;
	tildaUid: string;
	externalId: string;
	sku: string;
	title: string;
	quantity: number;
	price?: number;
}

export interface TildaStockPreview {
	offers: TildaStockOffer[];
	skipped: Array<TildaProductMapping & { reason: 'mapping_not_confirmed' }>;
	missingPrices: Array<TildaProductMapping & { reason: 'missing_erp_retail_price' }>;
	sourceStore: string;
}

export const TILDA_STOCK_SOURCE_STORE = 'Shelly';

function normalizedStore(value: string): string {
	return value.trim().toLocaleLowerCase('ru');
}

function sourceStoreQuantity(stocks: Record<string, number>, sourceStore: string): number {
	const normalizedSourceStore = normalizedStore(sourceStore);
	const total = Object.entries(stocks).reduce((sum, [store, rawQuantity]) => {
		if (normalizedStore(store) !== normalizedSourceStore) return sum;
		const quantity = Number(rawQuantity);
		return Number.isFinite(quantity) ? sum + quantity : sum;
	}, 0);
	return Math.max(0, Math.floor(total));
}

export function buildTildaStockPreview(
	mappings: TildaProductMapping[],
	stocksByProduct: Map<number, Record<string, number>>,
	sourceStore = TILDA_STOCK_SOURCE_STORE,
	pricesByProduct?: Map<number, number>,
): TildaStockPreview {
	const seenExternalIds = new Set<string>();
	const seenTildaUids = new Set<string>();
	const offers: TildaStockOffer[] = [];
	const skipped: TildaStockPreview['skipped'] = [];
	const missingPrices: TildaStockPreview['missingPrices'] = [];

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
		const offer: TildaStockOffer = {
			productId: mapping.productId,
			tildaUid,
			externalId,
			sku: mapping.sku.trim(),
			title: mapping.title.trim(),
			quantity: sourceStoreQuantity(stocksByProduct.get(mapping.productId) ?? {}, sourceStore),
		};
		if (pricesByProduct) {
			const rawPrice = pricesByProduct.get(mapping.productId);
			if (rawPrice === undefined) {
				missingPrices.push({ ...mapping, reason: 'missing_erp_retail_price' });
			} else {
				const price = Math.round(Number(rawPrice) * 100) / 100;
				if (!Number.isFinite(price) || price <= 0) throw new Error(`invalid ERP retail price for #${mapping.productId}: ${String(rawPrice)}`);
				offer.price = price;
			}
		}
		offers.push(offer);
	}

	offers.sort((left, right) => left.externalId.localeCompare(right.externalId));
	return { offers, skipped, missingPrices, sourceStore };
}
