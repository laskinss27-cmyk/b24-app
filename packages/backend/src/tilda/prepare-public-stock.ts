import { createHash } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import { ErpClient } from '../erp/client.js';
import { buildTildaOffersXml } from './commerce-ml.js';
import { fetchCompleteTildaErpPrices } from './erp-price-reader.js';
import { fetchCompleteTildaErpStocks } from './erp-stock-reader.js';
import { readTildaProductMappings } from './product-mapping-reader.js';
import { readTildaPublicStockRows } from './public-catalog.js';
import { compareTildaPublicStock } from './public-stock-comparison.js';
import { prepareTildaStockPreview } from './stock-preview-service.js';

const config = loadDatabaseConfig();
if (config.mode !== 'readiness') throw new Error('B24_APP_DB_MODE=readiness is required');
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERPNEXT_URL/TOKEN are required');
const publicUrl = String(process.env['TILDA_PUBLIC_CATALOG_URL'] ?? '').trim();
const outputDirectory = String(process.env['TILDA_PREPARE_OUTPUT_DIR'] ?? '').trim();
const runId = String(process.env['TILDA_PREPARE_RUN_ID'] ?? '').trim();
if (!publicUrl || !outputDirectory || !/^\d{8}_\d{6}$/u.test(runId)) throw new Error('Tilda preparation output configuration is incomplete');
const priceSyncMode = String(process.env['TILDA_PRICE_SYNC'] ?? 'off').trim().toLowerCase();
if (priceSyncMode !== 'on' && priceSyncMode !== 'off') throw new Error('TILDA_PRICE_SYNC must be on or off');
const priceSyncEnabled = priceSyncMode === 'on';

const pool = createDatabasePool(config);
const temporaryPaths: string[] = [];
try {
	const mappings = await readTildaProductMappings(pool);
	const preview = await prepareTildaStockPreview({
		readMappings: async () => mappings,
		fetchStocks: (productIds) => fetchCompleteTildaErpStocks(erp, productIds),
		...(priceSyncEnabled ? { fetchPrices: (productIds: number[]) => fetchCompleteTildaErpPrices(erp, productIds) } : {}),
	});
	const publicCatalog = await readTildaPublicStockRows(publicUrl);
	if (mappings.length !== 150 || preview.offers.length !== 134 || preview.skippedCount !== 16 || publicCatalog.parentCount !== 131 || publicCatalog.rows.length !== 150) {
		throw new Error('Tilda preparation counts differ from the audited baseline');
	}
	const comparison = compareTildaPublicStock(mappings, preview.offers, publicCatalog.rows);
	if (comparison.blockedUnlimited.length !== 2 || comparison.projectionOffers.length !== 132 || comparison.rollbackOffers.length !== 132) {
		throw new Error('Tilda reversible projection counts differ from the audited baseline');
	}
	const generatedAt = new Date();
	const projectionXml = buildTildaOffersXml(comparison.projectionOffers, generatedAt);
	const rollbackXml = buildTildaOffersXml(comparison.rollbackOffers, generatedAt);
	const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
	const auditOffer = (offer: (typeof comparison.projectionOffers)[number]) => ({
		productId: offer.productId,
		tildaUid: offer.tildaUid,
			externalId: offer.externalId,
			sku: offer.sku,
			title: offer.title,
			quantity: offer.quantity,
			...(offer.price === undefined ? {} : { price: offer.price }),
		});
	const priceTargets = comparison.projectionOffers.filter((offer) => offer.price !== undefined).length;
	const differenceCount = comparison.differences.length + comparison.priceDifferences.length;
	const publicCatalogContentHash = priceSyncEnabled ? publicCatalog.protectedContentHash : publicCatalog.contentHash;
	if (!publicCatalogContentHash) throw new Error('Tilda public catalog has no price-safe protected content hash');
	const report = JSON.stringify({
		generatedAt: generatedAt.toISOString(),
		...(priceSyncEnabled ? { priceSyncEnabled: true } : {}),
		counts: {
			mappings: mappings.length,
			fullProjectedOffers: preview.offers.length,
			reversibleProjectionOffers: comparison.projectionOffers.length,
			skipped: preview.skippedCount,
			blockedUnlimited: comparison.blockedUnlimited.length,
			publicParents: publicCatalog.parentCount,
			publicStockRows: publicCatalog.rows.length,
			differences: differenceCount,
			...(priceSyncEnabled ? {
				priceTargets,
				priceDifferences: comparison.priceDifferences.length,
				blockedMissingPrices: comparison.blockedMissingPrice.length,
				missingErpPrices: preview.missingPriceCount,
			} : {}),
		},
		publicCatalogContentHash,
		sourceStore: preview.sourceStore,
		fullProjectionHash: preview.projectionHash,
		safeProjectionXmlSha256: sha256(projectionXml),
		rollbackXmlSha256: sha256(rollbackXml),
		blockedUnlimited: comparison.blockedUnlimited,
		...(priceSyncEnabled ? { blockedMissingPrice: comparison.blockedMissingPrice } : {}),
		projectionOffers: comparison.projectionOffers.map(auditOffer),
		rollbackOffers: comparison.rollbackOffers.map(auditOffer),
		differences: comparison.differences,
		...(priceSyncEnabled ? { priceDifferences: comparison.priceDifferences } : {}),
	}, null, 2) + '\n';
	const outputs = [
		{ name: `${runId}-tilda-stock-projection.xml`, content: projectionXml },
		{ name: `${runId}-tilda-stock-rollback.xml`, content: rollbackXml },
		{ name: `${runId}-tilda-stock-comparison.json`, content: report },
	];
	for (const output of outputs) {
		const finalPath = join(outputDirectory, output.name);
		const temporaryPath = `${finalPath}.tmp`;
		temporaryPaths.push(temporaryPath);
		await writeFile(temporaryPath, output.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
		await rename(temporaryPath, finalPath);
		temporaryPaths.pop();
	}
	console.log(report.trim());
} finally {
	await Promise.all(temporaryPaths.map((path) => rm(path, { force: true })));
	await pool.end();
}
