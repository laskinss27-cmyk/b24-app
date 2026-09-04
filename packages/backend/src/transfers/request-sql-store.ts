import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import {
	parseTransferRequestItem,
	type StoredTransferRequest,
	type SupplyRequestLine,
	type TransferRequestData,
} from './request-model.js';
import type { TransferLine } from './model.js';
import type { TransferSqlConnection, TransferSqlPool } from './sql-store.js';

export type TransferRequestSqlSourceKind = 'bitrix_backfill' | 'bitrix_dual_write' | 'repair' | 'sql_native';
export const TRANSFER_REQUEST_SQL_STATE_FORMAT_VERSION = 1;

export interface WriteTransferRequestRevisionInput {
	externalId: number;
	name: string;
	data: TransferRequestData;
	sourceKind: TransferRequestSqlSourceKind;
}

export interface WriteTransferRequestRevisionResult {
	externalId: number;
	revisionId: number;
	revisionNo: number;
	stateHash: string;
	alreadyCurrent: boolean;
}

export interface WriteNativeTransferRequestResult {
	publicId: number;
	revisionId: number;
	revisionNo: number;
	stateHash: string;
	alreadyCurrent: boolean;
	alreadyApplied: boolean;
}

export interface PendingTransferRequestBitrixMirror {
	publicId: number;
	bitrixExternalId: number | null;
	revisionId: number;
	attemptCount: number;
	operationKind: 'upsert' | 'delete';
}

type QueryRow = Record<string, unknown>;
type SqlResult = { affectedRows?: number; insertId?: bigint | number | string };

function positiveInteger(value: unknown, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
	return parsed;
}

function bounded(value: unknown, max: number, name: string): string {
	const text = String(value ?? '');
	if (text.length > max) throw new Error(`${name} exceeds ${max} characters`);
	return text;
}

function sqlIdentifier(value: unknown, name: string): number {
	return positiveInteger(value, name);
}

function storedHash(value: unknown, name: string): string {
	if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error(`Invalid ${name}`);
	return value.toString('hex');
}

function idempotencyKey(value: unknown): string {
	const key = bounded(value, 191, 'transfer request idempotency key').trim();
	if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new Error('Invalid transfer request idempotency key');
	return key;
}

function canonicalTimestamp(value: string, name: string): string {
	if (!value.trim()) return '';
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid ${name}`);
	return parsed.toISOString();
}

function sqlDate(value: string, name: string): Date | null {
	const timestamp = canonicalTimestamp(value, name);
	return timestamp ? new Date(timestamp) : null;
}

function normalizeTransferLine(line: TransferLine): TransferLine {
	const qty = Number(line.qty);
	if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid transfer request quantity');
	return {
		productId: positiveInteger(line.productId, 'transfer request product id'),
		name: bounded(line.name, 500, 'transfer request product name'),
		qty,
	};
}

function normalizeSupplyLine(line: SupplyRequestLine): SupplyRequestLine {
	const qty = Number(line.qty);
	if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid supply request quantity');
	const productId = line.productId == null ? null : positiveInteger(line.productId, 'supply request product id');
	const name = bounded(line.name, 500, 'supply request product name');
	if (productId == null && !name.trim()) throw new Error('Supply request line requires a product id or name');
	return {
		productId,
		name,
		qty,
		link: bounded(line.link, 500, 'supply request product link'),
		note: bounded(line.note, 500, 'supply request line note'),
	};
}

function requestData(request: StoredTransferRequest): TransferRequestData {
	const { id: _id, name: _name, ...data } = request;
	return data;
}

export function normalizeTransferRequestSqlState(input: WriteTransferRequestRevisionInput): StoredTransferRequest {
	const externalId = positiveInteger(input.externalId, 'transfer request external id');
	const name = bounded(input.name.trim(), 255, 'transfer request display name');
	if (!name) throw new Error('Transfer request display name is required');
	const parsed = parseTransferRequestItem({ ID: externalId, NAME: name, DETAIL_TEXT: JSON.stringify(input.data) });
	if (!parsed) throw new Error('Transfer request data is invalid');
	const normalized: StoredTransferRequest = {
		...parsed,
		name,
		fromStore: bounded(parsed.fromStore, 191, 'transfer request source store'),
		toStore: bounded(parsed.toStore, 191, 'transfer request target store'),
		note: bounded(parsed.note, 500, 'transfer request note'),
		createdAt: canonicalTimestamp(bounded(parsed.createdAt, 64, 'transfer request created timestamp'), 'transfer request created timestamp'),
		createdById: bounded(parsed.createdById, 191, 'transfer request creator id'),
		createdByName: bounded(parsed.createdByName, 255, 'transfer request creator name'),
		convertedAt: canonicalTimestamp(bounded(parsed.convertedAt, 64, 'transfer request converted timestamp'), 'transfer request converted timestamp'),
		convertedById: bounded(parsed.convertedById, 191, 'transfer request converter id'),
		convertedByName: bounded(parsed.convertedByName, 255, 'transfer request converter name'),
		canceledAt: canonicalTimestamp(bounded(parsed.canceledAt, 64, 'transfer request canceled timestamp'), 'transfer request canceled timestamp'),
		canceledById: bounded(parsed.canceledById, 191, 'transfer request canceler id'),
		canceledByName: bounded(parsed.canceledByName, 255, 'transfer request canceler name'),
		lines: parsed.lines.map(normalizeTransferLine),
		supplyLines: parsed.supplyLines.map(normalizeSupplyLine),
	};
	if (normalized.kind === 'transfer' && (!normalized.fromStore || !normalized.toStore || !normalized.lines.length || normalized.supplyLines.length)) {
		throw new Error('Transfer request shape is invalid');
	}
	if (normalized.kind === 'supply' && (!normalized.toStore || !normalized.supplyLines.length || normalized.lines.length)) {
		throw new Error('Supply request shape is invalid');
	}
	return normalized;
}

export function transferRequestSqlStateHash(request: StoredTransferRequest): string {
	const normalized = normalizeTransferRequestSqlState({
		externalId: request.id,
		name: request.name,
		data: requestData(request),
		sourceKind: 'repair',
	});
	return createHash('sha256')
		.update(supplyMirrorCanonicalJson({ name: normalized.name, data: requestData(normalized) }))
		.digest('hex');
}

function hashBuffer(hash: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid transfer request state hash');
	return Buffer.from(hash, 'hex');
}

async function writeLockedTransferRequestRevision(
	connection: TransferSqlConnection,
	request: StoredTransferRequest,
	sourceKind: TransferRequestSqlSourceKind,
	requestId: unknown,
	currentHash: unknown,
	stateHash = transferRequestSqlStateHash(request),
): Promise<Omit<WriteTransferRequestRevisionResult, 'externalId'>> {
	const latest = await connection.query<QueryRow[]>(`
		SELECT id, revision_no, state_hash
		FROM stock_transfer_request_revisions
		WHERE request_id = ?
		ORDER BY revision_no DESC
		LIMIT 1
		FOR UPDATE
	`, [requestId]);
	if (latest.length && Buffer.isBuffer(currentHash) && currentHash.equals(hashBuffer(stateHash))) {
		return {
			revisionId: positiveInteger(latest[0]!['id'], 'transfer request revision id'),
			revisionNo: positiveInteger(latest[0]!['revision_no'], 'transfer request revision number'),
			stateHash,
			alreadyCurrent: true,
		};
	}
	const revisionNo = latest.length ? positiveInteger(latest[0]!['revision_no'], 'transfer request revision number') + 1 : 1;
	const inserted = await connection.query<SqlResult>(`
		INSERT INTO stock_transfer_request_revisions (
			request_id, revision_no, state_hash, source_kind, request_kind, request_status,
			from_store, to_store, note, source_created_at, created_by_id, created_by_name,
			converted_at, converted_by_id, converted_by_name, transfer_public_id, task_id,
			canceled_at, canceled_by_id, canceled_by_name
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, [
		requestId, revisionNo, hashBuffer(stateHash), sourceKind, request.kind, request.status,
		request.fromStore, request.toStore, request.note,
		sqlDate(request.createdAt, 'transfer request created timestamp'), request.createdById, request.createdByName,
		sqlDate(request.convertedAt, 'transfer request converted timestamp'), request.convertedById, request.convertedByName,
		request.transferId, request.taskId,
		sqlDate(request.canceledAt, 'transfer request canceled timestamp'), request.canceledById, request.canceledByName,
	]);
	const revisionId = positiveInteger(inserted.insertId, 'transfer request revision insert id');
	const lineRows: unknown[][] = [
		...request.lines.map((line, index) => [revisionId, 'transfer', index + 1, line.productId, line.name, line.qty, '', '']),
		...request.supplyLines.map((line, index) => [revisionId, 'supply', index + 1, line.productId, line.name, line.qty, line.link, line.note]),
	];
	if (lineRows.length) await connection.batch(`
		INSERT INTO stock_transfer_request_revision_lines (
			revision_id, line_kind, line_ordinal, product_id, product_name, quantity, product_link, line_note
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, lineRows);
	const updated = await connection.query<SqlResult>(`
		UPDATE stock_transfer_request_records
		SET display_name = ?, last_state_hash = ?, deleted_at = NULL
		WHERE id = ?
	`, [request.name, hashBuffer(stateHash), requestId]);
	if (Number(updated.affectedRows ?? 0) !== 1) throw new Error('Transfer request current revision update failed');
	return { revisionId, revisionNo, stateHash, alreadyCurrent: false };
}

export async function writeTransferRequestSqlRevisionOnConnection(
	connection: TransferSqlConnection,
	input: WriteTransferRequestRevisionInput,
): Promise<WriteTransferRequestRevisionResult> {
	const externalId = positiveInteger(input.externalId, 'transfer request external id');
	await connection.query(`
		INSERT IGNORE INTO stock_transfer_request_public_ids (public_id, legacy_bitrix_external_id)
		VALUES (?, ?)
	`, [externalId, externalId]);
	const allocations = await connection.query<QueryRow[]>(`
		SELECT public_id, legacy_bitrix_external_id
		FROM stock_transfer_request_public_ids
		WHERE public_id = ? OR legacy_bitrix_external_id = ?
		FOR UPDATE
	`, [externalId, externalId]);
	if (allocations.length !== 1 || Number(allocations[0]!['legacy_bitrix_external_id']) !== externalId) {
		throw new Error(`Transfer request Bitrix identity ${externalId} conflicts with the SQL public-id allocator`);
	}
	const publicId = positiveInteger(allocations[0]!['public_id'], 'transfer request public id');
	const request = normalizeTransferRequestSqlState({ ...input, externalId: publicId });
	const stateHash = transferRequestSqlStateHash(request);
	await connection.query(`
		INSERT INTO stock_transfer_request_records (public_id, bitrix_external_id, display_name, deleted_at)
		VALUES (?, ?, ?, NULL)
		ON DUPLICATE KEY UPDATE public_id = COALESCE(public_id, VALUES(public_id)), display_name = VALUES(display_name), deleted_at = NULL
	`, [publicId, externalId, request.name]);
	const records = await connection.query<QueryRow[]>(`
		SELECT id, public_id, last_state_hash
		FROM stock_transfer_request_records
		WHERE bitrix_external_id = ?
		FOR UPDATE
	`, [externalId]);
	if (records.length !== 1 || Number(records[0]!['public_id']) !== publicId) throw new Error('Transfer request identity row was not locked');
	const requestId = positiveInteger(records[0]!['id'], 'transfer request record id');
	const revision = await writeLockedTransferRequestRevision(
		connection, request, input.sourceKind, requestId, records[0]!['last_state_hash'], stateHash,
	);
	return { externalId, ...revision };
}

export async function writeTransferRequestSqlRevision(
	pool: TransferSqlPool,
	input: WriteTransferRequestRevisionInput,
): Promise<WriteTransferRequestRevisionResult> {
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const result = await writeTransferRequestSqlRevisionOnConnection(connection, input);
		await connection.commit();
		transaction = false;
		return result;
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		await connection.release();
	}
}

type NativeCommandKind = 'create' | 'update' | 'delete';

function nativeRequestState(name: string, data: TransferRequestData, publicId = 1): StoredTransferRequest {
	return normalizeTransferRequestSqlState({ externalId: publicId, name, data, sourceKind: 'sql_native' });
}

async function lockNativeCommand(
	connection: TransferSqlConnection,
	key: string,
	kind: NativeCommandKind,
	requestHash: string,
): Promise<QueryRow> {
	await connection.query(`
		INSERT IGNORE INTO stock_transfer_request_commands (idempotency_key, command_kind, request_hash)
		VALUES (?, ?, ?)
	`, [key, kind, hashBuffer(requestHash)]);
	const rows = await connection.query<QueryRow[]>(`
		SELECT id, command_kind, request_hash, request_id, revision_id, completed_at
		FROM stock_transfer_request_commands
		WHERE idempotency_key = ?
		FOR UPDATE
	`, [key]);
	if (rows.length !== 1) throw new Error('Transfer request idempotency command was not locked');
	const row = rows[0]!;
	if (String(row['command_kind']) !== kind || !Buffer.isBuffer(row['request_hash']) || !row['request_hash'].equals(hashBuffer(requestHash))) {
		throw new Error(`Transfer request idempotency key ${key} was already used for another command`);
	}
	const hasRequest = row['request_id'] != null;
	const hasRevision = row['revision_id'] != null;
	const completed = row['completed_at'] != null;
	if ((hasRequest || hasRevision || completed) && !(hasRequest && hasRevision && completed)) {
		throw new Error(`Transfer request idempotency command ${key} has an incomplete result`);
	}
	return row;
}

async function completedNativeCommandResult(
	connection: TransferSqlConnection,
	command: QueryRow,
): Promise<WriteNativeTransferRequestResult | null> {
	if (command['request_id'] == null) return null;
	const rows = await connection.query<QueryRow[]>(`
		SELECT rr.public_id, r.id AS revision_id, r.revision_no, r.state_hash
		FROM stock_transfer_request_records rr
		JOIN stock_transfer_request_revisions r ON r.id = ? AND r.request_id = rr.id
		WHERE rr.id = ?
		FOR UPDATE
	`, [command['revision_id'], command['request_id']]);
	if (rows.length !== 1) throw new Error('Transfer request idempotency result is missing');
	return {
		publicId: positiveInteger(rows[0]!['public_id'], 'transfer request public id'),
		revisionId: positiveInteger(rows[0]!['revision_id'], 'transfer request revision id'),
		revisionNo: positiveInteger(rows[0]!['revision_no'], 'transfer request revision number'),
		stateHash: storedHash(rows[0]!['state_hash'], 'transfer request revision hash'),
		alreadyCurrent: true,
		alreadyApplied: true,
	};
}

async function completeNativeCommand(
	connection: TransferSqlConnection,
	commandId: unknown,
	requestId: unknown,
	revisionId: number,
): Promise<void> {
	const updated = await connection.query<SqlResult>(`
		UPDATE stock_transfer_request_commands
		SET request_id = ?, revision_id = ?, completed_at = CURRENT_TIMESTAMP(6)
		WHERE id = ? AND request_id IS NULL AND revision_id IS NULL AND completed_at IS NULL
	`, [requestId, revisionId, commandId]);
	if (Number(updated.affectedRows ?? 0) !== 1) throw new Error('Transfer request idempotency command completion failed');
}

async function enqueueBitrixMirror(
	connection: TransferSqlConnection,
	requestId: unknown,
	revisionId: number,
	operationKind: 'upsert' | 'delete' = 'upsert',
): Promise<void> {
	await connection.query(`
		INSERT IGNORE INTO stock_transfer_request_bitrix_outbox (request_id, revision_id, operation_kind)
		VALUES (?, ?, ?)
	`, [requestId, revisionId, operationKind]);
}

export async function createNativeTransferRequestSql(
	pool: TransferSqlPool,
	input: { idempotencyKey: string; name: string; data: TransferRequestData },
): Promise<WriteNativeTransferRequestResult> {
	const key = idempotencyKey(input.idempotencyKey);
	const initial = nativeRequestState(input.name, input.data);
	const requestHash = transferRequestSqlStateHash(initial);
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const command = await lockNativeCommand(connection, key, 'create', requestHash);
		const completed = await completedNativeCommandResult(connection, command);
		if (completed) {
			await connection.commit();
			transaction = false;
			return completed;
		}
		const allocation = await connection.query<SqlResult>(`
			INSERT INTO stock_transfer_request_public_ids (legacy_bitrix_external_id)
			VALUES (NULL)
		`);
		const publicId = sqlIdentifier(allocation.insertId, 'allocated transfer request public id');
		const request = nativeRequestState(input.name, input.data, publicId);
		const stateHash = transferRequestSqlStateHash(request);
		if (stateHash !== requestHash) throw new Error('Transfer request public identity changed the command hash');
		const inserted = await connection.query<SqlResult>(`
			INSERT INTO stock_transfer_request_records (public_id, bitrix_external_id, display_name, deleted_at)
			VALUES (?, NULL, ?, NULL)
		`, [publicId, request.name]);
		const requestId = sqlIdentifier(inserted.insertId, 'transfer request record insert id');
		const revision = await writeLockedTransferRequestRevision(connection, request, 'sql_native', requestId, null, stateHash);
		await enqueueBitrixMirror(connection, requestId, revision.revisionId);
		await completeNativeCommand(connection, command['id'], requestId, revision.revisionId);
		await connection.commit();
		transaction = false;
		return { publicId, ...revision, alreadyApplied: false };
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		await connection.release();
	}
}

export async function updateNativeTransferRequestSql(
	pool: TransferSqlPool,
	input: { publicId: number; idempotencyKey: string; name: string; data: TransferRequestData },
): Promise<WriteNativeTransferRequestResult> {
	const publicId = positiveInteger(input.publicId, 'transfer request public id');
	const key = idempotencyKey(input.idempotencyKey);
	const request = nativeRequestState(input.name, input.data, publicId);
	const requestHash = transferRequestSqlStateHash(request);
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const command = await lockNativeCommand(connection, key, 'update', requestHash);
		const completed = await completedNativeCommandResult(connection, command);
		if (completed) {
			if (completed.publicId !== publicId) throw new Error(`Transfer request idempotency key ${key} belongs to another request`);
			await connection.commit();
			transaction = false;
			return completed;
		}
		const records = await connection.query<QueryRow[]>(`
			SELECT id, last_state_hash
			FROM stock_transfer_request_records
			WHERE public_id = ? AND deleted_at IS NULL
			FOR UPDATE
		`, [publicId]);
		if (records.length !== 1) throw new Error(`Transfer request #${publicId} was not found in SQL`);
		const requestId = records[0]!['id'];
		const revision = await writeLockedTransferRequestRevision(
			connection, request, 'sql_native', requestId, records[0]!['last_state_hash'], requestHash,
		);
		await enqueueBitrixMirror(connection, requestId, revision.revisionId);
		await completeNativeCommand(connection, command['id'], requestId, revision.revisionId);
		await connection.commit();
		transaction = false;
		return { publicId, ...revision, alreadyApplied: false };
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		await connection.release();
	}
}

export async function deleteNativeTransferRequestSql(
	pool: TransferSqlPool,
	input: { publicId: number; idempotencyKey: string; name: string },
): Promise<WriteNativeTransferRequestResult> {
	const publicId = positiveInteger(input.publicId, 'transfer request public id');
	const key = idempotencyKey(input.idempotencyKey);
	const name = bounded(input.name.trim(), 255, 'transfer request display name');
	if (!name) throw new Error('Transfer request display name is required');
	const requestHash = createHash('sha256')
		.update(supplyMirrorCanonicalJson({ command: 'delete', publicId }))
		.digest('hex');
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const command = await lockNativeCommand(connection, key, 'delete', requestHash);
		const completed = await completedNativeCommandResult(connection, command);
		if (completed) {
			if (completed.publicId !== publicId) throw new Error(`Transfer request idempotency key ${key} belongs to another request`);
			await connection.commit();
			transaction = false;
			return completed;
		}
		const records = await connection.query<QueryRow[]>(`
			SELECT id FROM stock_transfer_request_records WHERE public_id = ? FOR UPDATE
		`, [publicId]);
		if (records.length !== 1) throw new Error(`Transfer request #${publicId} was not found in SQL`);
		const requestId = records[0]!['id'];
		const revisions = await connection.query<QueryRow[]>(`
			SELECT id, revision_no, state_hash FROM stock_transfer_request_revisions
			WHERE request_id = ? ORDER BY revision_no DESC LIMIT 1 FOR UPDATE
		`, [requestId]);
		if (revisions.length !== 1) throw new Error(`Transfer request #${publicId} has no SQL revision`);
		const revisionId = positiveInteger(revisions[0]!['id'], 'transfer request revision id');
		const revisionNo = positiveInteger(revisions[0]!['revision_no'], 'transfer request revision number');
		const stateHash = storedHash(revisions[0]!['state_hash'], 'transfer request revision hash');
		await connection.query(`
			UPDATE stock_transfer_request_records
			SET display_name = ?, deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP(6)) WHERE id = ?
		`, [name, requestId]);
		await connection.query(`
			UPDATE stock_transfer_request_bitrix_outbox
			SET status = 'superseded', lease_token = NULL, locked_until = NULL,
				completed_at = CURRENT_TIMESTAMP(6), last_error = 'superseded by delete'
			WHERE request_id = ? AND operation_kind = 'upsert' AND (
				status = 'pending' OR (status = 'processing' AND locked_until <= CURRENT_TIMESTAMP(6))
			)
		`, [requestId]);
		await enqueueBitrixMirror(connection, requestId, revisionId, 'delete');
		await completeNativeCommand(connection, command['id'], requestId, revisionId);
		await connection.commit();
		transaction = false;
		return { publicId, revisionId, revisionNo, stateHash, alreadyCurrent: true, alreadyApplied: false };
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		await connection.release();
	}
}

export async function readPendingTransferRequestBitrixMirrors(
	pool: TransferSqlPool,
	limit = 20,
): Promise<PendingTransferRequestBitrixMirror[]> {
	const safeLimit = Math.min(Math.max(positiveInteger(limit, 'transfer request outbox limit'), 1), 100);
	const rows = await pool.query<QueryRow[]>(`
		SELECT rr.public_id, rr.bitrix_external_id, o.operation_kind,
			MAX(o.revision_id) AS revision_id, MAX(o.attempt_count) AS attempt_count
		FROM stock_transfer_request_bitrix_outbox o
		JOIN stock_transfer_request_records rr ON rr.id = o.request_id
		WHERE (
			(o.status = 'pending' AND o.available_at <= CURRENT_TIMESTAMP(6))
			OR (o.status = 'processing' AND o.locked_until <= CURRENT_TIMESTAMP(6))
		) AND ((o.operation_kind = 'upsert' AND rr.deleted_at IS NULL) OR o.operation_kind = 'delete')
		GROUP BY rr.id, rr.public_id, rr.bitrix_external_id, o.operation_kind
		ORDER BY MIN(o.id)
		LIMIT ${safeLimit}
	`);
	return rows.map((row) => ({
		publicId: positiveInteger(row['public_id'], 'transfer request public id'),
		bitrixExternalId: row['bitrix_external_id'] == null ? null : positiveInteger(row['bitrix_external_id'], 'transfer request Bitrix id'),
		revisionId: positiveInteger(row['revision_id'], 'transfer request revision id'),
		attemptCount: Number(row['attempt_count'] ?? 0),
		operationKind: String(row['operation_kind']) === 'delete' ? 'delete' : 'upsert',
	}));
}

function mirrorLeaseToken(value: unknown): string {
	const token = bounded(value, 36, 'transfer request mirror lease token').trim();
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(token)) {
		throw new Error('Invalid transfer request mirror lease token');
	}
	return token;
}

export async function claimTransferRequestBitrixMirror(
	pool: TransferSqlPool,
	input: { publicId: number; revisionId: number; operationKind: 'upsert' | 'delete'; leaseToken: string },
): Promise<boolean> {
	const publicId = positiveInteger(input.publicId, 'transfer request public id');
	const revisionId = positiveInteger(input.revisionId, 'transfer request revision id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const records = await connection.query<QueryRow[]>(`
			SELECT id FROM stock_transfer_request_records
			WHERE public_id = ? AND (? = 'delete' OR deleted_at IS NULL)
			FOR UPDATE
		`, [publicId, input.operationKind]);
		if (records.length !== 1) throw new Error(`Transfer request #${publicId} was not found for Bitrix mirroring`);
		const requestId = records[0]!['id'];
		const active = await connection.query<QueryRow[]>(`
			SELECT id FROM stock_transfer_request_bitrix_outbox
			WHERE request_id = ? AND status = 'processing' AND locked_until > CURRENT_TIMESTAMP(6)
			LIMIT 1 FOR UPDATE
		`, [requestId]);
		if (active.length) {
			await connection.commit();
			transaction = false;
			return false;
		}
		const claimed = await connection.query<SqlResult>(`
			UPDATE stock_transfer_request_bitrix_outbox
			SET status = 'processing', lease_token = ?, locked_until = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 60 SECOND)
			WHERE request_id = ? AND operation_kind = ? AND revision_id <= ? AND (
				(status = 'pending' AND available_at <= CURRENT_TIMESTAMP(6))
				OR (status = 'processing' AND locked_until <= CURRENT_TIMESTAMP(6))
			)
		`, [leaseToken, requestId, input.operationKind, revisionId]);
		await connection.commit();
		transaction = false;
		return Number(claimed.affectedRows ?? 0) > 0;
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		await connection.release();
	}
}

export async function readTransferRequestBitrixExternalId(
	pool: TransferSqlPool,
	publicIdInput: number,
): Promise<number | null> {
	const publicId = positiveInteger(publicIdInput, 'transfer request public id');
	const rows = await pool.query<QueryRow[]>(`
		SELECT bitrix_external_id FROM stock_transfer_request_records WHERE public_id = ?
	`, [publicId]);
	if (!rows.length) return null;
	if (rows.length !== 1) throw new Error(`Transfer request #${publicId} identity is ambiguous`);
	return rows[0]!['bitrix_external_id'] == null ? null : positiveInteger(rows[0]!['bitrix_external_id'], 'transfer request Bitrix id');
}

export async function recordTransferRequestBitrixMirrorFailure(
	pool: TransferSqlPool,
	input: { publicId: number; revisionId: number; operationKind: 'upsert' | 'delete'; leaseToken: string; error: string },
): Promise<void> {
	const publicId = positiveInteger(input.publicId, 'transfer request public id');
	const revisionId = positiveInteger(input.revisionId, 'transfer request revision id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	const error = bounded(input.error, 1000, 'transfer request mirror error');
	await pool.query(`
		UPDATE stock_transfer_request_bitrix_outbox o
		JOIN stock_transfer_request_records rr ON rr.id = o.request_id
		SET o.attempt_count = o.attempt_count + 1, o.last_attempt_at = CURRENT_TIMESTAMP(6),
			o.available_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL LEAST(300, POW(2, LEAST(o.attempt_count, 8))) SECOND),
			o.last_error = ?, o.status = 'pending', o.lease_token = NULL, o.locked_until = NULL
		WHERE rr.public_id = ? AND o.operation_kind = ? AND o.status = 'processing'
			AND o.lease_token = ? AND o.revision_id <= ?
	`, [error, publicId, input.operationKind, leaseToken, revisionId]);
}

export async function markTransferRequestBitrixMirrorDelivered(
	pool: TransferSqlPool,
	input: { publicId: number; revisionId: number; bitrixExternalId: number; leaseToken: string },
): Promise<void> {
	const publicId = positiveInteger(input.publicId, 'transfer request public id');
	const revisionId = positiveInteger(input.revisionId, 'transfer request revision id');
	const bitrixExternalId = positiveInteger(input.bitrixExternalId, 'transfer request Bitrix id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const claims = await connection.query<QueryRow[]>(`
			SELECT o.id FROM stock_transfer_request_bitrix_outbox o
			JOIN stock_transfer_request_records rr ON rr.id = o.request_id
			WHERE rr.public_id = ? AND o.operation_kind = 'upsert' AND o.status = 'processing'
				AND o.lease_token = ? AND o.revision_id <= ? FOR UPDATE
		`, [publicId, leaseToken, revisionId]);
		if (!claims.length) {
			await connection.commit();
			transaction = false;
			return;
		}
		const allocations = await connection.query<QueryRow[]>(`
			SELECT public_id, legacy_bitrix_external_id FROM stock_transfer_request_public_ids
			WHERE public_id = ? FOR UPDATE
		`, [publicId]);
		if (allocations.length !== 1) throw new Error(`Transfer request #${publicId} allocator row is missing`);
		const legacy = allocations[0]!['legacy_bitrix_external_id'];
		if (legacy != null && Number(legacy) !== bitrixExternalId) throw new Error(`Transfer request #${publicId} already has another Bitrix mirror`);
		await connection.query(`
			UPDATE stock_transfer_request_public_ids SET legacy_bitrix_external_id = ? WHERE public_id = ?
		`, [bitrixExternalId, publicId]);
		const records = await connection.query<QueryRow[]>(`
			SELECT bitrix_external_id FROM stock_transfer_request_records WHERE public_id = ? FOR UPDATE
		`, [publicId]);
		if (records.length !== 1) throw new Error(`Transfer request #${publicId} record is missing`);
		const current = records[0]!['bitrix_external_id'];
		if (current != null && Number(current) !== bitrixExternalId) throw new Error(`Transfer request #${publicId} already points to another Bitrix mirror`);
		await connection.query(`UPDATE stock_transfer_request_records SET bitrix_external_id = ? WHERE public_id = ?`, [bitrixExternalId, publicId]);
		await connection.query(`
			UPDATE stock_transfer_request_bitrix_outbox o
			JOIN stock_transfer_request_records rr ON rr.id = o.request_id
			SET o.status = 'delivered', o.attempt_count = o.attempt_count + 1,
				o.last_attempt_at = CURRENT_TIMESTAMP(6), o.lease_token = NULL, o.locked_until = NULL,
				o.completed_at = CURRENT_TIMESTAMP(6), o.last_error = ''
			WHERE rr.public_id = ? AND o.operation_kind = 'upsert' AND o.status = 'processing'
				AND o.lease_token = ? AND o.revision_id <= ?
		`, [publicId, leaseToken, revisionId]);
		await connection.commit();
		transaction = false;
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		await connection.release();
	}
}

export async function markTransferRequestBitrixDeleteDelivered(
	pool: TransferSqlPool,
	input: { publicId: number; revisionId: number; leaseToken: string },
): Promise<void> {
	const publicId = positiveInteger(input.publicId, 'transfer request public id');
	const revisionId = positiveInteger(input.revisionId, 'transfer request revision id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	await pool.query(`
		UPDATE stock_transfer_request_bitrix_outbox o
		JOIN stock_transfer_request_records rr ON rr.id = o.request_id
		SET o.status = 'delivered', o.attempt_count = o.attempt_count + 1,
			o.last_attempt_at = CURRENT_TIMESTAMP(6), o.lease_token = NULL, o.locked_until = NULL,
			o.completed_at = CURRENT_TIMESTAMP(6), o.last_error = ''
		WHERE rr.public_id = ? AND o.operation_kind = 'delete' AND o.status = 'processing'
			AND o.lease_token = ? AND o.revision_id <= ?
	`, [publicId, leaseToken, revisionId]);
}

export async function markTransferRequestSqlDeleted(
	pool: TransferSqlPool,
	input: { externalId: number; name: string; deletedAt?: Date },
): Promise<void> {
	const externalId = positiveInteger(input.externalId, 'transfer request external id');
	const name = bounded(input.name.trim(), 255, 'transfer request display name');
	const result = await pool.query<SqlResult>(`
		UPDATE stock_transfer_request_records
		SET display_name = ?, deleted_at = COALESCE(deleted_at, ?)
		WHERE bitrix_external_id = ?
	`, [name || `Заявка #${externalId}`, input.deletedAt ?? new Date(), externalId]);
	if (Number(result.affectedRows ?? 0) > 1) throw new Error('Transfer request deletion affected more than one record');
}
