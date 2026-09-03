import mariadb, { type Pool } from 'mariadb';
import {
	createNativeTransferSql,
	claimTransferBitrixMirror,
	markTransferBitrixMirrorDelivered,
	markTransferSqlDeleted,
	readPendingTransferBitrixMirrors,
	readTransferBitrixExternalId,
	recordTransferBitrixMirrorFailure,
	updateNativeTransferSql,
	writeTransferSqlRevision,
	type PendingTransferBitrixMirror,
	type TransferSqlSourceKind,
} from './sql-store.js';
import type { TransferData } from './model.js';
import { readCurrentSqlTransfer, readCurrentSqlTransfers } from './sql-reader.js';

export type TransferSqlWriteConfig =
	| { mode: 'off' }
	| {
	mode: 'shadow' | 'primary';
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
	createNative(input: { idempotencyKey: string; name: string; data: TransferData }): ReturnType<typeof createNativeTransferSql>;
	updateNative(input: { publicId: number; idempotencyKey: string; name: string; data: TransferData }): ReturnType<typeof updateNativeTransferSql>;
	pendingMirrors(limit?: number): Promise<PendingTransferBitrixMirror[]>;
	claimMirror(input: { publicId: number; revisionId: number; leaseToken: string }): Promise<boolean>;
	bitrixExternalId(publicId: number): Promise<number | null>;
	markMirrorDelivered(input: { publicId: number; revisionId: number; bitrixExternalId: number; leaseToken: string }): Promise<void>;
	recordMirrorFailure(input: { publicId: number; revisionId: number; leaseToken: string; error: string }): Promise<void>;
	markDeleted(input: { externalId: number; name: string; deletedAt?: Date }): Promise<void>;
	readAll(): ReturnType<typeof readCurrentSqlTransfers>;
	read(externalId: number): ReturnType<typeof readCurrentSqlTransfer>;
	ping(): Promise<void>;
	close(): Promise<void>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = String(env[name] ?? '').trim();
	if (!value) throw new Error(`${name} is required when transfer SQL writes are enabled`);
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
	if (mode !== 'shadow' && mode !== 'primary') throw new Error('B24_APP_TRANSFER_SQL_WRITE must be off, shadow or primary');
	if (String(env['B24_APP_DB_MODE'] ?? 'off').trim() !== 'readiness') {
		throw new Error('B24_APP_DB_MODE=readiness is required for transfer SQL writes');
	}
	if (mode === 'primary' && String(env['B24_APP_TRANSFER_SQL_READ'] ?? 'off').trim() !== 'primary') {
		throw new Error('B24_APP_TRANSFER_SQL_READ=primary is required for transfer SQL primary writes');
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
	return new Error('Transfer SQL writes are disabled');
}

export function createTransferSqlWriteRuntime(config: TransferSqlWriteConfig): TransferSqlWriteRuntime {
	if (config.mode === 'off') {
		return {
			mode: 'off', enabled: false,
			async write() { throw disabledError(); },
			async createNative() { throw disabledError(); },
			async updateNative() { throw disabledError(); },
			async pendingMirrors() { throw disabledError(); },
			async claimMirror() { throw disabledError(); },
			async bitrixExternalId() { throw disabledError(); },
			async markMirrorDelivered() { throw disabledError(); },
			async recordMirrorFailure() { throw disabledError(); },
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
		createNative(input) { return createNativeTransferSql(pool, input); },
		updateNative(input) { return updateNativeTransferSql(pool, input); },
		pendingMirrors(limit) { return readPendingTransferBitrixMirrors(pool, limit); },
		claimMirror(input) { return claimTransferBitrixMirror(pool, input); },
		bitrixExternalId(publicId) { return readTransferBitrixExternalId(pool, publicId); },
		markMirrorDelivered(input) { return markTransferBitrixMirrorDelivered(pool, input); },
		recordMirrorFailure(input) { return recordTransferBitrixMirrorFailure(pool, input); },
		markDeleted(input) { return markTransferSqlDeleted(pool, input); },
		readAll() { return readCurrentSqlTransfers(pool); },
		read(externalId) { return readCurrentSqlTransfer(pool, externalId); },
		async ping() {
			await pool.query('SELECT 1 AS ok');
			if (config.mode === 'primary') {
				await Promise.all([
					pool.query('SELECT public_id, bitrix_external_id FROM stock_transfer_records LIMIT 0'),
					pool.query('SELECT idempotency_key FROM stock_transfer_commands LIMIT 0'),
					pool.query('SELECT status FROM stock_transfer_bitrix_outbox LIMIT 0'),
					pool.query('SELECT public_id FROM stock_transfer_public_ids LIMIT 0'),
				]);
			}
		},
		async close() { await pool.end(); },
	};
}
