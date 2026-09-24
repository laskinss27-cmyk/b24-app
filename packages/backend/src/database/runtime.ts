import mariadb, { type Pool } from 'mariadb';
import type { DatabaseConfig } from './config.js';
import { readLatestCatalogMirrorPlan } from '../catalog-mirror/reader.js';
import type { CatalogMirrorPlan } from '../catalog-mirror/model.js';

/** Read-only SQL access used by the catalog audit; the main API does not use this runtime. */
export function createDatabaseRuntime(config: DatabaseConfig): {
	readLatestCatalogMirrorPlan(): Promise<CatalogMirrorPlan | null>;
	close(): Promise<void>;
} {
	if (config.mode === 'off') {
		return {
			async readLatestCatalogMirrorPlan() { return null; },
			async close() {},
		};
	}
	const pool: Pool = mariadb.createPool({
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
	return {
		async readLatestCatalogMirrorPlan() { return readLatestCatalogMirrorPlan(pool); },
		async close() { await pool.end(); },
	};
}
