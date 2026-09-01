import mariadb, { type Pool, type PoolConnection } from 'mariadb';
import type { ReservationConfig } from './config.js';

export interface ReservationRuntime {
	readonly mode: ReservationConfig['mode'];
	readonly enabled: boolean;
	readonly canWrite: boolean;
	query<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T>;
	transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T>;
	ping(): Promise<void>;
	close(): Promise<void>;
}

function disabledError(): Error {
	return new Error('Механизм резервирования выключен');
}

export function createReservationRuntime(config: ReservationConfig): ReservationRuntime {
	if (config.mode === 'off') {
		return {
			mode: 'off', enabled: false, canWrite: false,
			async query<T>(): Promise<T> { throw disabledError(); },
			async transaction<T>(): Promise<T> { throw disabledError(); },
			async ping() {},
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
		mode: config.mode,
		enabled: true,
		canWrite: config.mode === 'active',
		async query<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
			const connection = await pool.getConnection();
			try { return await work(connection); }
			finally { await connection.release(); }
		},
		async transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
			if (config.mode !== 'active') throw new Error('Reservation writes require B24_APP_RESERVATIONS=active');
			const connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				const result = await work(connection);
				await connection.commit();
				return result;
			} catch (error) {
				await connection.rollback().catch(() => undefined);
				throw error;
			} finally {
				await connection.release();
			}
		},
		async ping() { await pool.query('SELECT 1 AS ok'); },
		async close() { await pool.end(); },
	};
}
