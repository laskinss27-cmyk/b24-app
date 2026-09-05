import mariadb, { type Pool } from 'mariadb';
import type { TransferRequestData } from './request-model.js';
import {
	claimTransferRequestBitrixMirror,
	createNativeTransferRequestSql,
	deleteNativeTransferRequestSql,
	markTransferRequestBitrixDeleteDelivered,
	markTransferRequestBitrixMirrorDelivered,
	markTransferRequestSqlDeleted,
	readPendingTransferRequestBitrixMirrors,
	readTransferRequestBitrixExternalId,
	recordTransferRequestBitrixMirrorFailure,
	updateNativeTransferRequestSql,
	writeTransferRequestSqlRevision,
	type PendingTransferRequestBitrixMirror,
} from './request-sql-store.js';

export type TransferRequestSqlWriteConfig =
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

export interface TransferRequestSqlWriteRuntime {
	readonly mode: TransferRequestSqlWriteConfig['mode'];
	readonly enabled: boolean;
	write(input: { externalId: number; name: string; data: TransferRequestData }): ReturnType<typeof writeTransferRequestSqlRevision>;
	createNative(input: { idempotencyKey: string; name: string; data: TransferRequestData }): ReturnType<typeof createNativeTransferRequestSql>;
	updateNative(input: { publicId: number; idempotencyKey: string; name: string; data: TransferRequestData }): ReturnType<typeof updateNativeTransferRequestSql>;
	deleteNative(input: { publicId: number; idempotencyKey: string; name: string }): ReturnType<typeof deleteNativeTransferRequestSql>;
	pendingMirrors(limit?: number): Promise<PendingTransferRequestBitrixMirror[]>;
	claimMirror(input: { publicId: number; revisionId: number; operationKind: 'upsert' | 'delete'; leaseToken: string }): Promise<boolean>;
	bitrixExternalId(publicId: number): Promise<number | null>;
	markMirrorDelivered(input: { publicId: number; revisionId: number; bitrixExternalId: number; leaseToken: string }): Promise<void>;
	markDeleteDelivered(input: { publicId: number; revisionId: number; leaseToken: string }): Promise<void>;
	recordMirrorFailure(input: { publicId: number; revisionId: number; operationKind: 'upsert' | 'delete'; leaseToken: string; error: string }): Promise<void>;
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
	if (mode !== 'shadow' && mode !== 'primary') throw new Error('B24_APP_TRANSFER_REQUEST_SQL_WRITE must be off, shadow or primary');
	if (String(env['B24_APP_DB_MODE'] ?? 'off').trim() !== 'readiness') {
		throw new Error('B24_APP_DB_MODE=readiness is required for transfer request SQL writes');
	}
	const user = required(env, 'B24_APP_TRANSFER_DB_USER');
	const forbidden = [
		env['B24_APP_DB_USER'], env['B24_APP_MIGRATION_DB_USER'], env['B24_APP_BACKFILL_DB_USER'],
		env['B24_APP_TILDA_DB_USER'], env['B24_APP_RESERVATION_DB_USER'], env['B24_APP_INVENTORY_DB_USER'],
	].map((value) => String(value ?? '').trim()).filter(Boolean);
	if (forbidden.includes(user)) throw new Error('Transfer request SQL writer database user must be a separate identity');
	if (mode === 'primary' && String(env['B24_APP_TRANSFER_REQUEST_SQL_READ'] ?? 'off').trim() !== 'primary') {
		throw new Error('B24_APP_TRANSFER_REQUEST_SQL_READ=primary is required for SQL-first transfer request writes');
	}
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
		async createNative() { throw disabledError(); },
		async updateNative() { throw disabledError(); },
		async deleteNative() { throw disabledError(); },
		async pendingMirrors() { throw disabledError(); },
		async claimMirror() { throw disabledError(); },
		async bitrixExternalId() { throw disabledError(); },
		async markMirrorDelivered() { throw disabledError(); },
		async markDeleteDelivered() { throw disabledError(); },
		async recordMirrorFailure() { throw disabledError(); },
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
		createNative(input) { return createNativeTransferRequestSql(pool, input); },
		updateNative(input) { return updateNativeTransferRequestSql(pool, input); },
		deleteNative(input) { return deleteNativeTransferRequestSql(pool, input); },
		pendingMirrors(limit) { return readPendingTransferRequestBitrixMirrors(pool, limit); },
		claimMirror(input) { return claimTransferRequestBitrixMirror(pool, input); },
		bitrixExternalId(publicId) { return readTransferRequestBitrixExternalId(pool, publicId); },
		markMirrorDelivered(input) { return markTransferRequestBitrixMirrorDelivered(pool, input); },
		markDeleteDelivered(input) { return markTransferRequestBitrixDeleteDelivered(pool, input); },
		recordMirrorFailure(input) { return recordTransferRequestBitrixMirrorFailure(pool, input); },
		markDeleted(input) { return markTransferRequestSqlDeleted(pool, input); },
		async ping() {
			await Promise.all([
				pool.query('SELECT 1 AS ok'),
				...(config.mode === 'primary' ? [
					pool.query('SELECT public_id, bitrix_external_id FROM stock_transfer_request_records LIMIT 0'),
					pool.query('SELECT public_id FROM stock_transfer_request_public_ids LIMIT 0'),
					pool.query('SELECT idempotency_key FROM stock_transfer_request_commands LIMIT 0'),
					pool.query('SELECT status FROM stock_transfer_request_bitrix_outbox LIMIT 0'),
				] : []),
			]);
			if (config.mode === 'primary') {
				const rows = await pool.query<Array<Record<string, unknown>>>(`
					SELECT COUNT(*) AS missing_count
					FROM stock_transfer_request_records
					WHERE public_id IS NULL
				`);
				if (Number(rows[0]?.['missing_count'] ?? 0) !== 0) throw new Error('Transfer request SQL public identity backfill is incomplete');
			}
		},
		async close() { await pool.end(); },
	};
}
