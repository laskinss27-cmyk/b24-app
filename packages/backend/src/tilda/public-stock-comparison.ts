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

export function compareTildaPublicStock(
	mappings: TildaProductMapping[],
	projectedOffers: TildaStockOffer[],
	publicRows: TildaPublicStockRow[],
): {
	differences: TildaStockDifference[];
	projectionOffers: TildaStockOffer[];
	rollbackOffers: TildaStockOffer[];
	blockedUnlimited: TildaUnlimitedStockBlocker[];
} {
	const publicByUid = new Map(publicRows.map((row) => [row.tildaUid, row]));
	for (const mapping of mappings) {
		const current = publicByUid.get(mapping.tildaUid);
		if (!current) throw new Error(`Tilda public catalog is missing mapped UID: ${mapping.tildaUid}`);
		if (current.sku !== mapping.sku) throw new Error(`Tilda public SKU changed for UID ${mapping.tildaUid}: ${current.sku}/${mapping.sku}`);
	}
	const differences: TildaStockDifference[] = [];
	const projectionOffers: TildaStockOffer[] = [];
	const rollbackOffers: TildaStockOffer[] = [];
	const blockedUnlimited: TildaUnlimitedStockBlocker[] = [];
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
		projectionOffers.push(offer);
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
		rollbackOffers.push({ ...offer, quantity: current.quantity });
	}
	return {
		differences: differences.sort((left, right) => left.externalId.localeCompare(right.externalId)),
		projectionOffers,
		rollbackOffers,
		blockedUnlimited: blockedUnlimited.sort((left, right) => left.externalId.localeCompare(right.externalId)),
	};
}
