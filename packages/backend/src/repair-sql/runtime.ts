import mariadb, { type Pool } from 'mariadb';
import type { TransferSqlPool } from '../transfers/sql-store.js';
import type { RepairSqlRecord } from './model.js';
import {
	claimRepairBitrixMirror, createNativeRepairSql, deleteNativeRepairSql, markRepairBitrixDeleteDelivered,
	markRepairBitrixMirrorDelivered, markRepairSqlDeleted, readPendingRepairBitrixMirrors,
	readRepairBitrixExternalId, recordRepairBitrixMirrorFailure, reserveNativeRepairIdentity,
	updateNativeRepairSql, writeRepairSqlRecord, type PendingRepairBitrixMirror,
} from './writer.js';

export type RepairSqlWriteConfig =
	| { mode: 'off' }
	| {
		mode: 'shadow' | 'primary'; host: string; port: number; database: string; user: string; password: string;
		connectionLimit: number; connectTimeoutMs: number;
	};

export interface RepairSqlWriteRuntime {
	readonly mode: RepairSqlWriteConfig['mode'];
	readonly enabled: boolean;
	write(record: RepairSqlRecord): ReturnType<typeof writeRepairSqlRecord>;
	reserveIdentity(input: { idempotencyKey: string; request: unknown }): ReturnType<typeof reserveNativeRepairIdentity>;
	createNative(input: { publicId: number; repairNo: number; idempotencyKey: string; requestHash: string; name: string; data: Record<string, unknown> }): ReturnType<typeof createNativeRepairSql>;
	updateNative(input: { publicId: number; idempotencyKey: string; name: string; data: Record<string, unknown> }): ReturnType<typeof updateNativeRepairSql>;
	deleteNative(input: { publicId: number; idempotencyKey: string }): ReturnType<typeof deleteNativeRepairSql>;
	pendingMirrors(limit?: number): Promise<PendingRepairBitrixMirror[]>;
	claimMirror(input: { publicId: number; mutationId: number; operationKind: 'upsert' | 'delete'; leaseToken: string }): Promise<boolean>;
	bitrixExternalId(publicId: number): Promise<number | null>;
	markMirrorDelivered(input: { publicId: number; mutationId: number; bitrixExternalId: number; leaseToken: string }): Promise<void>;
	markDeleteDelivered(input: { publicId: number; mutationId: number; leaseToken: string }): Promise<void>;
	recordMirrorFailure(input: { publicId: number; mutationId: number; operationKind: 'upsert' | 'delete'; leaseToken: string; error: string }): Promise<void>;
	markDeleted(input: { externalId: number; deletedAt?: Date }): ReturnType<typeof markRepairSqlDeleted>;
	ping(): Promise<void>;
	close(): Promise<void>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = String(env[name] ?? '').trim();
	if (!value) throw new Error(`${name} is required when repair SQL writes are enabled`);
	return value;
}

function positiveInteger(value: unknown, fallback: number, max: number, name: string): number {
	const parsed = value == null || value === '' ? fallback : Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) throw new Error(`${name} must be a positive integer <= ${max}`);
	return parsed;
}

export function loadRepairSqlWriteConfig(env: NodeJS.ProcessEnv = process.env): RepairSqlWriteConfig {
	const mode = String(env['B24_APP_REPAIR_SQL_WRITE'] ?? 'off').trim();
	if (mode === 'off') return { mode: 'off' };
	if (mode !== 'shadow' && mode !== 'primary') throw new Error('B24_APP_REPAIR_SQL_WRITE must be off, shadow or primary');
	if (String(env['B24_APP_DB_MODE'] ?? 'off').trim() !== 'readiness') {
		throw new Error('B24_APP_DB_MODE=readiness is required for repair SQL writes');
	}
	const user = required(env, 'B24_APP_REPAIR_DB_USER');
	const forbidden = [
		env['B24_APP_DB_USER'], env['B24_APP_MIGRATION_DB_USER'], env['B24_APP_BACKFILL_DB_USER'],
		env['B24_APP_TILDA_DB_USER'], env['B24_APP_RESERVATION_DB_USER'], env['B24_APP_TRANSFER_DB_USER'],
		env['B24_APP_INVENTORY_DB_USER'], env['B24_APP_CATALOG_SYNC_DB_USER'],
	].map((value) => String(value ?? '').trim()).filter(Boolean);
	if (forbidden.includes(user)) throw new Error('Repair SQL writer database user must be a separate identity');
	if (mode === 'primary' && String(env['B24_APP_REPAIR_SQL_READ'] ?? 'off').trim() !== 'primary') {
		throw new Error('B24_APP_REPAIR_SQL_READ=primary is required for SQL-first repair writes');
	}
	return {
		mode,
		host: required(env, 'B24_APP_DB_HOST'),
		port: positiveInteger(env['B24_APP_DB_PORT'], 3306, 65_535, 'B24_APP_DB_PORT'),
		database: required(env, 'B24_APP_DB_NAME'),
		user,
		password: required(env, 'B24_APP_REPAIR_DB_PASSWORD'),
		connectionLimit: positiveInteger(env['B24_APP_REPAIR_DB_CONNECTION_LIMIT'], 2, 10, 'B24_APP_REPAIR_DB_CONNECTION_LIMIT'),
		connectTimeoutMs: positiveInteger(env['B24_APP_DB_CONNECT_TIMEOUT_MS'], 3_000, 30_000, 'B24_APP_DB_CONNECT_TIMEOUT_MS'),
	};
}

function disabledError(): Error { return new Error('Repair SQL shadow writes are disabled'); }

export function createRepairSqlWriteRuntime(config: RepairSqlWriteConfig): RepairSqlWriteRuntime {
	if (config.mode === 'off') return {
		mode: 'off', enabled: false,
		async write() { throw disabledError(); },
		async reserveIdentity() { throw disabledError(); },
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
		async ping() {}, async close() {},
	};
	const pool: Pool = mariadb.createPool({
		host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
		connectionLimit: config.connectionLimit, connectTimeout: config.connectTimeoutMs, acquireTimeout: config.connectTimeoutMs,
		bigIntAsNumber: false, insertIdAsNumber: false,
	});
	const sqlPool = pool as unknown as TransferSqlPool;
	return {
		mode: config.mode, enabled: true,
		write(record) { return writeRepairSqlRecord(sqlPool, record); },
		reserveIdentity(input) { return reserveNativeRepairIdentity(sqlPool, input); },
		createNative(input) { return createNativeRepairSql(sqlPool, input); },
		updateNative(input) { return updateNativeRepairSql(sqlPool, input); },
		deleteNative(input) { return deleteNativeRepairSql(sqlPool, input); },
		pendingMirrors(limit) { return readPendingRepairBitrixMirrors(sqlPool, limit); },
		claimMirror(input) { return claimRepairBitrixMirror(sqlPool, input); },
		bitrixExternalId(publicId) { return readRepairBitrixExternalId(sqlPool, publicId); },
		markMirrorDelivered(input) { return markRepairBitrixMirrorDelivered(sqlPool, input); },
		markDeleteDelivered(input) { return markRepairBitrixDeleteDelivered(sqlPool, input); },
		recordMirrorFailure(input) { return recordRepairBitrixMirrorFailure(sqlPool, input); },
		markDeleted(input) { return markRepairSqlDeleted(sqlPool, input); },
		async ping() {
			await Promise.all([
				pool.query('SELECT bitrix_external_id FROM repair_records LIMIT 0'),
				pool.query('SELECT repair_id FROM repair_history LIMIT 0'),
				pool.query('SELECT repair_id FROM repair_media LIMIT 0'),
				...(config.mode === 'primary' ? [
					pool.query('SELECT mutation_no FROM repair_mutations LIMIT 0'),
					pool.query('SELECT idempotency_key FROM repair_commands LIMIT 0'),
					pool.query('SELECT status FROM repair_bitrix_outbox LIMIT 0'),
					pool.query('SELECT repair_no FROM repair_identities LIMIT 0'),
				] : []),
			]);
		},
		async close() { await pool.end(); },
	};
}
