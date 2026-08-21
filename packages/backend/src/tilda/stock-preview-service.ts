import { createHash } from 'node:crypto';
import { buildTildaOffersXml } from './commerce-ml.js';
import {
	buildTildaStockPreview,
	type TildaProductMapping,
	type TildaStockOffer,
} from './stock-projection.js';

export interface TildaStockPreviewServices {
	readMappings(): Promise<TildaProductMapping[]>;
	fetchStocks(productIds: number[]): Promise<Map<number, Record<string, number>>>;
}

export interface PreparedTildaStockPreview {
	offers: TildaStockOffer[];
	skippedCount: number;
	excludedStores: string[];
	projectionHash: string;
	xml: string;
}

export async function prepareTildaStockPreview(
	services: TildaStockPreviewServices,
	excludedStores?: readonly string[],
	generatedAt = new Date(),
): Promise<PreparedTildaStockPreview> {
	const mappings = await services.readMappings();
	const productIds = [...new Set(mappings
		.filter((mapping) => mapping.status === 'confirmed')
		.map((mapping) => mapping.productId))];
	const stocks = await services.fetchStocks(productIds);
	const missingProductIds = productIds.filter((productId) => !stocks.has(productId));
	if (missingProductIds.length) {
		throw new Error(`ERP stock response is incomplete for confirmed Items: ${missingProductIds.join(', ')}`);
	}
	const preview = buildTildaStockPreview(mappings, stocks, excludedStores);
	const xml = buildTildaOffersXml(preview.offers, generatedAt);
	const projection = JSON.stringify({
		version: 1,
		excludedStores: preview.excludedStores,
		offers: preview.offers.map(({ productId, tildaUid, externalId, sku, quantity }) => ({
			productId,
			tildaUid,
			externalId,
			sku,
			quantity,
		})),
	});
	return {
		offers: preview.offers,
		skippedCount: preview.skipped.length,
		excludedStores: preview.excludedStores,
		projectionHash: createHash('sha256').update(projection).digest('hex'),
		xml,
	};
}
