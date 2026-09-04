import mariadb, { type Pool } from 'mariadb';
import type { TransferRequestData } from './request-model.js';
import { markTransferRequestSqlDeleted, writeTransferRequestSqlRevision } from './request-sql-store.js';

export type TransferRequestSqlWriteConfig =
	| { mode: 'off' }
	| {
		mode: 'shadow';
		host: string;
		port: number;
		database: string;
		user: string;
		password: string;
		connectionLimit: number;
		connectTimeoutMs: number;
	};

export interface TransferRequestSqlWriteRuntime {
	readonly mode: TransferRequestSqlWriteConfig['mode'];
	readonly enabled: boolean;
	write(input: { externalId: number; name: string; data: TransferRequestData }): ReturnType<typeof writeTransferRequestSqlRevision>;
	markDeleted(input: { externalId: number; name: string }): Promise<void>;
	ping(): Promise<void>;
	close(): Promise<void>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = String(env[name] ?? '').trim();
	if (!value) throw new Error(`${name} is required when transfer request SQL writes are enabled`);
	return value;
}

function positiveInteger(value: unknown, fallback: number, max: number, name: string): number {
	const parsed = value == null || value === '' ? fallback : Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) throw new Error(`${name} must be a positive integer <= ${max}`);
	return parsed;
}

export function loadTransferRequestSqlWriteConfig(env: NodeJS.ProcessEnv = process.env): TransferRequestSqlWriteConfig {
	const mode = String(env['B24_APP_TRANSFER_REQUEST_SQL_WRITE'] ?? 'off').trim();
	if (mode === 'off') return { mode: 'off' };
	if (mode !== 'shadow') throw new Error('B24_APP_TRANSFER_REQUEST_SQL_WRITE must be off or shadow');
	if (String(env['B24_APP_DB_MODE'] ?? 'off').trim() !== 'readiness') {
		throw new Error('B24_APP_DB_MODE=readiness is required for transfer request SQL writes');
	}
	const user = required(env, 'B24_APP_TRANSFER_DB_USER');
	const forbidden = [
		env['B24_APP_DB_USER'], env['B24_APP_MIGRATION_DB_USER'], env['B24_APP_BACKFILL_DB_USER'],
		env['B24_APP_TILDA_DB_USER'], env['B24_APP_RESERVATION_DB_USER'],
	].map((value) => String(value ?? '').trim()).filter(Boolean);
	if (forbidden.includes(user)) throw new Error('Transfer request SQL writer database user must be a separate identity');
	return {
		mode,
		host: required(env, 'B24_APP_DB_HOST'),
		port: positiveInteger(env['B24_APP_DB_PORT'], 3306, 65_535, 'B24_APP_DB_PORT'),
		database: required(env, 'B24_APP_DB_NAME'),
		user,
		password: required(env, 'B24_APP_TRANSFER_DB_PASSWORD'),
		connectionLimit: positiveInteger(env['B24_APP_TRANSFER_DB_CONNECTION_LIMIT'], 4, 20, 'B24_APP_TRANSFER_DB_CONNECTION_LIMIT'),
		connectTimeoutMs: positiveInteger(env['B24_APP_DB_CONNECT_TIMEOUT_MS'], 3_000, 30_000, 'B24_APP_DB_CONNECT_TIMEOUT_MS'),
	};
}

function disabledError(): Error {
	return new Error('Transfer request SQL writes are disabled');
}

export function createTransferRequestSqlWriteRuntime(config: TransferRequestSqlWriteConfig): TransferRequestSqlWriteRuntime {
	if (config.mode === 'off') return {
		mode: 'off',
		enabled: false,
		async write() { throw disabledError(); },
		async markDeleted() { throw disabledError(); },
		async ping() {},
		async close() {},
	};
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
		write(input) { return writeTransferRequestSqlRevision(pool, { ...input, sourceKind: 'bitrix_dual_write' }); },
		markDeleted(input) { return markTransferRequestSqlDeleted(pool, input); },
		async ping() { await pool.query('SELECT 1 AS ok'); },
		async close() { await pool.end(); },
	};
}
