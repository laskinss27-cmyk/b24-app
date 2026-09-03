import mariadb, { type Pool } from 'mariadb';
import type { DatabaseConfig } from './config.js';
import { readLatestSupplyMirrorSnapshot, type StoredSupplyMirrorSnapshot } from './supply-mirror-reader.js';
import { readCurrentSqlTransfer, readCurrentSqlTransfers } from '../transfers/sql-reader.js';
import type { StoredTransfer } from '../transfers/model.js';
import { readLatestCatalogMirrorPlan } from '../catalog-mirror/reader.js';
import type { CatalogMirrorPlan } from '../catalog-mirror/model.js';

export interface DatabaseRuntime {
	readonly mode: DatabaseConfig['mode'];
	ping(): Promise<void>;
	readLatestSupplyMirrorSnapshot(): Promise<StoredSupplyMirrorSnapshot | null>;
	readCurrentTransfer(externalId: number): Promise<StoredTransfer | null>;
	readCurrentTransfers(): Promise<StoredTransfer[]>;
	readLatestCatalogMirrorPlan?(): Promise<CatalogMirrorPlan | null>;
	close(): Promise<void>;
}

export function createDatabasePool(config: Exclude<DatabaseConfig, { mode: 'off' }>): Pool {
	return mariadb.createPool({
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
}

export function createDatabaseRuntime(config: DatabaseConfig): DatabaseRuntime {
	if (config.mode === 'off') {
		return {
			mode: 'off',
			async ping() {},
			async readLatestSupplyMirrorSnapshot() { return null; },
			async readCurrentTransfer() { return null; },
			async readCurrentTransfers() { return []; },
			async readLatestCatalogMirrorPlan() { return null; },
			async close() {},
		};
	}

	const pool = createDatabasePool(config);
	return {
		mode: config.mode,
		async ping() {
			await pool.query('SELECT 1 AS ok');
		},
		async readLatestSupplyMirrorSnapshot() {
			return readLatestSupplyMirrorSnapshot(pool);
		},
		async readCurrentTransfer(externalId) {
			return readCurrentSqlTransfer(pool, externalId);
		},
		async readCurrentTransfers() {
			return readCurrentSqlTransfers(pool);
		},
		async readLatestCatalogMirrorPlan() {
			return readLatestCatalogMirrorPlan(pool);
		},
		async close() {
			await pool.end();
		},
	};
}
