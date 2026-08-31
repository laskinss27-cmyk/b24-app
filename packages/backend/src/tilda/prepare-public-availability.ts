import { createHash } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import { ErpClient } from '../erp/client.js';
import { buildTildaAvailabilityProjection } from './availability-projection.js';
import { buildTildaAvailabilityCatalogXml } from './commerce-ml.js';
import { fetchCompleteTildaErpStocks } from './erp-stock-reader.js';
import { readTildaProductMappings } from './product-mapping-reader.js';
import { readTildaPublicStockRows } from './public-catalog.js';
import { prepareTildaStockPreview } from './stock-preview-service.js';

function required(name: string): string {
	const value = String(process.env[name] ?? '').trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const config = loadDatabaseConfig();
if (config.mode !== 'readiness') throw new Error('B24_APP_DB_MODE=readiness is required');
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERPNEXT_URL/TOKEN are required');
const publicUrl = required('TILDA_PUBLIC_CATALOG_URL');
const propertyId = required('TILDA_AVAILABILITY_PROPERTY_ID');
const outputDirectory = required('TILDA_PREPARE_OUTPUT_DIR');
const runId = required('TILDA_PREPARE_RUN_ID');
if (!/^\d{8}_\d{6}$/u.test(runId)) throw new Error('TILDA_PREPARE_RUN_ID must use YYYYMMDD_HHMMSS');

const pool = createDatabasePool(config);
const temporaryPaths: string[] = [];
try {
	const mappings = await readTildaProductMappings(pool);
	const preview = await prepareTildaStockPreview({
		readMappings: async () => mappings,
		fetchStocks: (productIds) => fetchCompleteTildaErpStocks(erp, productIds),
	});
	const publicCatalog = await readTildaPublicStockRows(publicUrl);
	if (mappings.length !== 150 || preview.offers.length !== 134 || preview.skippedCount !== 16
		|| publicCatalog.parentCount !== 131 || publicCatalog.rows.length !== 150) {
		throw new Error('Tilda availability preparation counts differ from the audited baseline');
	}
	const projection = buildTildaAvailabilityProjection(mappings, preview.offers, publicCatalog.availabilityRows);
	if (projection.targets.length !== 112 || projection.skipped.length !== 14) {
		throw new Error('Tilda availability parent projection differs from the audited baseline');
	}
	if (projection.targets.some((target) => target.currentAvailability === null)) {
		throw new Error('Tilda availability projection contains a non-reversible blank current value');
	}
	const publicStockByUid = new Map(publicCatalog.rows.map((row) => [row.tildaUid, row]));
	const anchorOffer = preview.offers.find((offer) => {
		const row = publicStockByUid.get(offer.tildaUid);
		return row?.quantity !== null && row?.quantity === offer.quantity && row.sku === offer.sku;
	});
	if (!anchorOffer) throw new Error('Tilda availability preparation has no current numeric no-op offers anchor');

	const projectionXml = buildTildaAvailabilityCatalogXml(projection.targets.map((target) => ({
		externalId: target.externalId, title: target.title, availability: target.availability,
	})), propertyId);
	const rollbackXml = buildTildaAvailabilityCatalogXml(projection.targets.map((target) => ({
		externalId: target.externalId, title: target.title, availability: target.currentAvailability!,
	})), propertyId);
	const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
	const report = JSON.stringify({
		generatedAt: new Date().toISOString(),
		propertyId,
		fullProjectionHash: preview.projectionHash,
		publicCatalogContentHash: publicCatalog.availabilityProtectedContentHash,
		counts: {
			publicParents: publicCatalog.parentCount,
			publicStockRows: publicCatalog.rows.length,
			targets: projection.targets.length,
			differences: projection.differences.length,
			skippedGroups: projection.skipped.length,
		},
		sourceStore: preview.sourceStore,
		projectionXmlSha256: sha256(projectionXml),
		rollbackXmlSha256: sha256(rollbackXml),
		targets: projection.targets,
		skipped: projection.skipped,
		anchorOffer: { ...anchorOffer, price: undefined },
	}, null, 2) + '\n';
	const outputs = [
		{ name: `${runId}-tilda-availability-projection.xml`, content: projectionXml },
		{ name: `${runId}-tilda-availability-rollback.xml`, content: rollbackXml },
		{ name: `${runId}-tilda-availability-comparison.json`, content: report },
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
