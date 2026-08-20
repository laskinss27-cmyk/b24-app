import mariadb, { type Pool } from 'mariadb';
import type { DatabaseConfig } from './config.js';

export interface DatabaseRuntime {
	readonly mode: DatabaseConfig['mode'];
	ping(): Promise<void>;
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
			async close() {},
		};
	}

	const pool = createDatabasePool(config);
	return {
		mode: config.mode,
		async ping() {
			await pool.query('SELECT 1 AS ok');
		},
		async close() {
			await pool.end();
		},
	};
}
