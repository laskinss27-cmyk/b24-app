import { loadDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import { ErpClient } from '../erp/client.js';
import { fetchCompleteTildaErpStocks } from './erp-stock-reader.js';
import { readTildaProductMappings } from './product-mapping-reader.js';
import { fetchActiveTildaReservations } from './reservation-stock-reader.js';
import { prepareTildaStockPreview } from './stock-preview-service.js';

const config = loadDatabaseConfig();
if (config.mode !== 'readiness') throw new Error('B24_APP_DB_MODE=readiness is required for Tilda preview');
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERPNEXT_URL/TOKEN are required for Tilda preview');
const pool = createDatabasePool(config);

try {
	const preview = await prepareTildaStockPreview({
		readMappings: () => readTildaProductMappings(pool),
		fetchStocks: (productIds) => fetchCompleteTildaErpStocks(erp, productIds),
		fetchReservations: (productIds, sourceStore) => fetchActiveTildaReservations(pool, erp, productIds, sourceStore),
	});
	const zeroQuantity = preview.offers.filter((offer) => offer.quantity === 0);
	console.log(JSON.stringify({
		generatedAt: new Date().toISOString(),
		offerCount: preview.offers.length,
		skippedCount: preview.skippedCount,
		zeroQuantityCount: zeroQuantity.length,
		positiveQuantityCount: preview.offers.length - zeroQuantity.length,
		totalQuantity: preview.offers.reduce((sum, offer) => sum + offer.quantity, 0),
		sourceStore: preview.sourceStore,
		projectionHash: preview.projectionHash,
		xmlBytes: Buffer.byteLength(preview.xml),
		zeroQuantity: zeroQuantity.map(({ productId, tildaUid, externalId, sku }) => ({
			productId,
			tildaUid,
			externalId,
			sku,
		})),
	}));
} finally {
	await pool.end();
}
