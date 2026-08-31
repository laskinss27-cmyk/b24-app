import type { TildaProductMapping, TildaStockOffer } from './stock-projection.js';
import type { TildaPublicStockRow } from './public-catalog.js';

export interface TildaStockDifference {
	productId: number;
	tildaUid: string;
	externalId: string;
	sku: string;
	currentQuantity: number;
	projectedQuantity: number;
}

export interface TildaUnlimitedStockBlocker {
	productId: number;
	tildaUid: string;
	externalId: string;
	sku: string;
	projectedQuantity: number;
}

export interface TildaPriceDifference {
	productId: number;
	tildaUid: string;
	externalId: string;
	sku: string;
	currentPrice: number;
	projectedPrice: number;
}

export interface TildaMissingPublicPriceBlocker {
	productId: number;
	tildaUid: string;
	externalId: string;
	sku: string;
	projectedPrice: number;
}

export function compareTildaPublicStock(
	mappings: TildaProductMapping[],
	projectedOffers: TildaStockOffer[],
	publicRows: TildaPublicStockRow[],
): {
	differences: TildaStockDifference[];
	priceDifferences: TildaPriceDifference[];
	projectionOffers: TildaStockOffer[];
	rollbackOffers: TildaStockOffer[];
	blockedUnlimited: TildaUnlimitedStockBlocker[];
	blockedMissingPrice: TildaMissingPublicPriceBlocker[];
} {
	const publicByUid = new Map(publicRows.map((row) => [row.tildaUid, row]));
	for (const mapping of mappings) {
		const current = publicByUid.get(mapping.tildaUid);
		if (!current) throw new Error(`Tilda public catalog is missing mapped UID: ${mapping.tildaUid}`);
		if (current.sku !== mapping.sku) throw new Error(`Tilda public SKU changed for UID ${mapping.tildaUid}: ${current.sku}/${mapping.sku}`);
	}
	const differences: TildaStockDifference[] = [];
	const priceDifferences: TildaPriceDifference[] = [];
	const projectionOffers: TildaStockOffer[] = [];
	const rollbackOffers: TildaStockOffer[] = [];
	const blockedUnlimited: TildaUnlimitedStockBlocker[] = [];
	const blockedMissingPrice: TildaMissingPublicPriceBlocker[] = [];
	for (const offer of projectedOffers) {
		const current = publicByUid.get(offer.tildaUid);
		if (!current) throw new Error(`Tilda public catalog is missing projected UID: ${offer.tildaUid}`);
		if (current.quantity === null) {
			blockedUnlimited.push({
				productId: offer.productId,
				tildaUid: offer.tildaUid,
				externalId: offer.externalId,
				sku: offer.sku,
				projectedQuantity: offer.quantity,
			});
			continue;
		}
		const projectionOffer = { ...offer };
		const rollbackOffer = { ...offer, quantity: current.quantity };
		if (offer.price !== undefined) {
			if (current.price === null || current.price === undefined) {
				delete projectionOffer.price;
				delete rollbackOffer.price;
				blockedMissingPrice.push({
					productId: offer.productId,
					tildaUid: offer.tildaUid,
					externalId: offer.externalId,
					sku: offer.sku,
					projectedPrice: offer.price,
				});
			} else {
				rollbackOffer.price = current.price;
				if (current.price !== offer.price) {
					priceDifferences.push({
						productId: offer.productId,
						tildaUid: offer.tildaUid,
						externalId: offer.externalId,
						sku: offer.sku,
						currentPrice: current.price,
						projectedPrice: offer.price,
					});
				}
			}
		}
		projectionOffers.push(projectionOffer);
		if (current.quantity !== offer.quantity) {
			differences.push({
				productId: offer.productId,
				tildaUid: offer.tildaUid,
				externalId: offer.externalId,
				sku: offer.sku,
				currentQuantity: current.quantity,
				projectedQuantity: offer.quantity,
			});
		}
		rollbackOffers.push(rollbackOffer);
	}
	return {
		differences: differences.sort((left, right) => left.externalId.localeCompare(right.externalId)),
		priceDifferences: priceDifferences.sort((left, right) => left.externalId.localeCompare(right.externalId)),
		projectionOffers,
		rollbackOffers,
		blockedUnlimited: blockedUnlimited.sort((left, right) => left.externalId.localeCompare(right.externalId)),
		blockedMissingPrice: blockedMissingPrice.sort((left, right) => left.externalId.localeCompare(right.externalId)),
	};
}
