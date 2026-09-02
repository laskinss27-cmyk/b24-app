import { createHash } from 'node:crypto';
import { buildTildaOffersXml } from './commerce-ml.js';
import {
	buildTildaStockPreview,
	TILDA_STOCK_SOURCE_STORE,
	type TildaProductMapping,
	type TildaStockOffer,
} from './stock-projection.js';

export interface TildaStockPreviewServices {
	readMappings(): Promise<TildaProductMapping[]>;
	fetchStocks(productIds: number[]): Promise<Map<number, Record<string, number>>>;
	fetchReservations(productIds: number[], sourceStore: string): Promise<Map<number, number>>;
	fetchPrices?(productIds: number[]): Promise<Map<number, number>>;
}

export interface PreparedTildaStockPreview {
	offers: TildaStockOffer[];
	skippedCount: number;
	missingPriceCount: number;
	priceSyncEnabled: boolean;
	sourceStore: string;
	projectionHash: string;
	xml: string;
}

export async function prepareTildaStockPreview(
	services: TildaStockPreviewServices,
	sourceStore?: string,
	generatedAt = new Date(),
): Promise<PreparedTildaStockPreview> {
	const mappings = await services.readMappings();
	const productIds = [...new Set(mappings
		.filter((mapping) => mapping.status === 'confirmed')
		.map((mapping) => mapping.productId))];
	const resolvedSourceStore = sourceStore ?? TILDA_STOCK_SOURCE_STORE;
	const [stocks, reservations, prices] = await Promise.all([
		services.fetchStocks(productIds),
		services.fetchReservations(productIds, resolvedSourceStore),
		services.fetchPrices ? services.fetchPrices(productIds) : Promise.resolve(undefined),
	]);
	const missingProductIds = productIds.filter((productId) => !stocks.has(productId));
	if (missingProductIds.length) {
		throw new Error(`ERP stock response is incomplete for confirmed Items: ${missingProductIds.join(', ')}`);
	}
	const preview = buildTildaStockPreview(mappings, stocks, resolvedSourceStore, prices, reservations);
	const xml = buildTildaOffersXml(preview.offers, generatedAt);
	const projection = JSON.stringify({
		version: prices ? 2 : 1,
		sourceStore: preview.sourceStore,
		offers: preview.offers.map(({ productId, tildaUid, externalId, sku, quantity, price }) => ({
			productId,
			tildaUid,
			externalId,
			sku,
			quantity,
			...(price === undefined ? {} : { price }),
		})),
	});
	return {
		offers: preview.offers,
		skippedCount: preview.skipped.length,
		missingPriceCount: preview.missingPrices.length,
		priceSyncEnabled: Boolean(prices),
		sourceStore: preview.sourceStore,
		projectionHash: createHash('sha256').update(projection).digest('hex'),
		xml,
	};
}
