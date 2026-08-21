import { loadTildaSyncDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import { ErpClient } from '../erp/client.js';
import { TildaCommerceMlClient } from './commerce-ml-client.js';
import { fetchCompleteTildaErpStocks } from './erp-stock-reader.js';
import { readTildaProductMappings } from './product-mapping-reader.js';
import { readTildaPublicStockRows } from './public-catalog.js';
import { runTildaStockReconciliation } from './stock-reconciliation-service.js';
import { TildaStockSyncRunStore, withTildaSyncLock, type TildaSyncTrigger } from './stock-sync-run-store.js';

function required(name: string): string {
	const value = String(process.env[name] ?? '').trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

if (String(process.env['TILDA_STOCK_SYNC'] ?? 'off').trim() !== 'on') {
	throw new Error('TILDA_STOCK_SYNC=on is required for a reconciliation cycle');
}
const triggerValue = String(process.env['TILDA_SYNC_TRIGGER'] ?? 'scheduled').trim();
if (!['scheduled', 'manual'].includes(triggerValue)) throw new Error('TILDA_SYNC_TRIGGER must be scheduled or manual');
const trigger = triggerValue as TildaSyncTrigger;
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERPNEXT_URL/TOKEN are required');
const client = new TildaCommerceMlClient({
	url: required('TILDA_COMMERCE_URL'),
	username: required('TILDA_COMMERCE_USERNAME'),
	password: required('TILDA_COMMERCE_PASSWORD'),
});
const publicUrl = required('TILDA_PUBLIC_CATALOG_URL');
const pool = createDatabasePool(loadTildaSyncDatabaseConfig());

try {
	const locked = await withTildaSyncLock(pool, async (connection) => {
		const audit = new TildaStockSyncRunStore(connection);
		await audit.recoverInterruptedRuns();
		const exchange = async (catalogXml: string, offersXml: string) => {
			const session = await client.authenticateAndInitialize();
			return client.uploadAndImportStock(session, catalogXml, offersXml);
		};
		return runTildaStockReconciliation(trigger, {
			readMappings: () => readTildaProductMappings(connection),
			fetchStocks: (productIds) => fetchCompleteTildaErpStocks(erp, productIds),
			readPublicCatalog: () => readTildaPublicStockRows(publicUrl),
			publishProjection: exchange,
			publishRollback: exchange,
			audit,
		});
	});
	console.log(JSON.stringify(locked.acquired ? locked.value : { status: 'skipped_lock_held' }));
} finally {
	await pool.end();
}
