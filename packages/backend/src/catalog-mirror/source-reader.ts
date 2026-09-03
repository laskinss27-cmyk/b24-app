import { buildProductBase } from '../b24/catalog.js';
import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { readErpCatalogMirrorSnapshot } from './erp-reader.js';
import type { CatalogMirrorPrice, CatalogMirrorSnapshot } from './model.js';

/** Complete catalog source: ERP stock core plus the remaining Bitrix catalog metadata fallback. */
export async function readCompleteCatalogMirrorSnapshot(
	erp: ErpClient,
	bitrix: B24Client,
	now = new Date(),
): Promise<CatalogMirrorSnapshot> {
	const [snapshot, metadata] = await Promise.all([
		readErpCatalogMirrorSnapshot(erp, now),
		buildProductBase(bitrix),
	]);
	return mergeCatalogMirrorMetadata(snapshot, metadata);
}

/** Pure merger kept separate so source reconciliation can be tested without credentials. */
export function mergeCatalogMirrorMetadata(
	snapshot: CatalogMirrorSnapshot,
	metadata: Awaited<ReturnType<typeof buildProductBase>>,
): CatalogMirrorSnapshot {
	if (!metadata.rows.length) throw new Error('Bitrix catalog metadata is empty');
	const metadataById = new Map(metadata.rows.map((row) => [row.id, row]));
	const products = snapshot.products.map((source) => ({ ...source }));
	for (const product of products) {
		const known = metadataById.get(product.itemCode);
		if (!known) continue;
		product.bitrixIblockId = known.iblockId === 26 ? 26 : 24;
		product.bitrixSectionId = Number.isSafeInteger(known.sectionId) && Number(known.sectionId) > 0 ? Number(known.sectionId) : null;
		product.article ||= known.article?.trim() ?? '';
		product.model ||= known.model?.trim() ?? '';
		product.brand ||= known.manufacturer?.trim() ?? '';
		product.sectionName ||= known.sectionName?.trim() ?? '';
		product.productStatus ||= known.status?.trim() ?? '';
		product.description ||= known.description?.trim() ?? '';
		if (product.imageSource === 'none' && known.photoPath) {
			product.imagePath = known.photoPath;
			product.imageSource = 'bitrix';
		}
	}
	const priceKeys = new Set(snapshot.prices.map((row) => `${row.itemCode}\u0000${row.priceKind}`));
	const fallbackPrices: CatalogMirrorPrice[] = [];
	for (const product of products) {
		const known = metadataById.get(product.itemCode);
		if (!known) continue;
		for (const [priceKind, priceList, value] of [
			['retail', 'Standard Selling', known.retail],
			['purchase', 'Standard Buying', known.purchase],
		] as const) {
			const key = `${product.itemCode}\u0000${priceKind}`;
			if (priceKeys.has(key) || value === null || !Number.isFinite(value) || value < 0) continue;
			fallbackPrices.push({
				itemCode: product.itemCode,
				priceKind,
				priceList,
				sourceSystem: 'bitrix',
				currency: 'RUB',
				rate: value,
				sourceModifiedAt: null,
			});
			priceKeys.add(key);
		}
	}
	return {
		...snapshot,
		sources: { ...snapshot.sources, bitrix: { complete: true, records: metadata.rows.length } },
		products,
		prices: [...snapshot.prices, ...fallbackPrices],
	};
}
