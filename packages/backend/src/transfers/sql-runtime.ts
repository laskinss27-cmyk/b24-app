import mariadb, { type Pool } from 'mariadb';
import { markTransferSqlDeleted, writeTransferSqlRevision, type TransferSqlSourceKind } from './sql-store.js';
import type { TransferData } from './model.js';
import { readCurrentSqlTransfer, readCurrentSqlTransfers } from './sql-reader.js';

export type TransferSqlWriteConfig =
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

export interface TransferSqlWriteRuntime {
	readonly mode: TransferSqlWriteConfig['mode'];
	readonly enabled: boolean;
	write(input: { externalId: number; name: string; data: TransferData; sourceKind?: TransferSqlSourceKind }): ReturnType<typeof writeTransferSqlRevision>;
	markDeleted(input: { externalId: number; name: string; deletedAt?: Date }): Promise<void>;
	readAll(): ReturnType<typeof readCurrentSqlTransfers>;
	read(externalId: number): ReturnType<typeof readCurrentSqlTransfer>;
	ping(): Promise<void>;
	close(): Promise<void>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = String(env[name] ?? '').trim();
	if (!value) throw new Error(`${name} is required when transfer SQL shadow writes are enabled`);
	return value;
}

function positiveInteger(value: unknown, fallback: number, max: number, name: string): number {
	const parsed = value == null || value === '' ? fallback : Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) throw new Error(`${name} must be a positive integer <= ${max}`);
	return parsed;
}

export function loadTransferSqlWriteConfig(env: NodeJS.ProcessEnv = process.env): TransferSqlWriteConfig {
	const mode = String(env['B24_APP_TRANSFER_SQL_WRITE'] ?? 'off').trim();
	if (mode === 'off') return { mode: 'off' };
	if (mode !== 'shadow') throw new Error('B24_APP_TRANSFER_SQL_WRITE must be off or shadow');
	if (String(env['B24_APP_DB_MODE'] ?? 'off').trim() !== 'readiness') {
		throw new Error('B24_APP_DB_MODE=readiness is required for transfer SQL shadow writes');
	}
	const user = required(env, 'B24_APP_TRANSFER_DB_USER');
	const forbidden = [
		env['B24_APP_DB_USER'], env['B24_APP_MIGRATION_DB_USER'], env['B24_APP_BACKFILL_DB_USER'],
		env['B24_APP_TILDA_DB_USER'], env['B24_APP_RESERVATION_DB_USER'],
	].map((value) => String(value ?? '').trim()).filter(Boolean);
	if (forbidden.includes(user)) throw new Error('Transfer SQL writer database user must be a separate identity');
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
	return new Error('Transfer SQL shadow writes are disabled');
}

export function createTransferSqlWriteRuntime(config: TransferSqlWriteConfig): TransferSqlWriteRuntime {
	if (config.mode === 'off') {
		return {
			mode: 'off', enabled: false,
			async write() { throw disabledError(); },
			async markDeleted() { throw disabledError(); },
			async readAll() { throw disabledError(); },
			async read() { throw disabledError(); },
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
		write(input) {
			return writeTransferSqlRevision(pool, { ...input, sourceKind: input.sourceKind ?? 'bitrix_dual_write' });
		},
		markDeleted(input) { return markTransferSqlDeleted(pool, input); },
		readAll() { return readCurrentSqlTransfers(pool); },
		read(externalId) { return readCurrentSqlTransfer(pool, externalId); },
		async ping() { await pool.query('SELECT 1 AS ok'); },
		async close() { await pool.end(); },
	};
}
