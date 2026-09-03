import { pathToFileURL } from 'node:url';
import mariadb, { type Pool } from 'mariadb';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { buildCatalogMirrorPlan } from './plan.js';
import { readLatestCatalogMirrorPlan } from './reader.js';
import { readCompleteCatalogMirrorSnapshot } from './source-reader.js';
import { loadCatalogMirrorSyncConfig } from './sync-config.js';
import { applyCatalogMirrorPlan, type CatalogMirrorWriterPool } from './writer.js';

export async function syncCatalogMirror(args: {
	erp: ErpClient;
	bitrix: B24Client;
	pool: Pool;
	now?: Date;
}): Promise<{
	snapshotHash: string;
	alreadyApplied: boolean;
	observedAt: string;
	counts: { products: number; attributes: number; prices: number; warehouses: number; stocks: number };
}> {
	const snapshot = await readCompleteCatalogMirrorSnapshot(args.erp, args.bitrix, args.now ?? new Date());
	const plan = buildCatalogMirrorPlan(snapshot);
	const result = await applyCatalogMirrorPlan(args.pool as unknown as CatalogMirrorWriterPool, plan);
	const stored = await readLatestCatalogMirrorPlan(args.pool);
	if (!stored || stored.snapshotHash !== plan.snapshotHash) throw new Error('Catalog mirror read-back does not match the applied snapshot');
	return { snapshotHash: result.snapshotHash, alreadyApplied: result.alreadyApplied, observedAt: stored.observedAt, counts: result.counts };
}

async function main(): Promise<void> {
	const erp = ErpClient.fromEnv();
	if (!erp) throw new Error('ERPNEXT_URL and ERPNEXT_TOKEN are required for catalog mirror sync');
	const config = loadCatalogMirrorSyncConfig();
	const bitrix = new B24Client({ auth: { kind: 'webhook', url: config.b24Webhook } });
	const pool = mariadb.createPool({
		host: config.host,
		port: config.port,
		database: config.database,
		user: config.user,
		password: config.password,
		connectionLimit: config.connectionLimit,
		connectTimeout: config.connectTimeoutMs,
		acquireTimeout: config.connectTimeoutMs,
		bigIntAsNumber: false,
		insertIdAsNumber: false,
	});
	try {
		const startedAt = Date.now();
		const result = await syncCatalogMirror({ erp, bitrix, pool });
		console.log(JSON.stringify({ ok: true, ...result, durationMs: Date.now() - startedAt }));
	} finally {
		await pool.end();
	}
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
