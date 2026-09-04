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

export type TransferRequestSqlSourceKind = 'bitrix_backfill' | 'bitrix_dual_write' | 'repair';
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

export async function writeTransferRequestSqlRevisionOnConnection(
	connection: TransferSqlConnection,
	input: WriteTransferRequestRevisionInput,
): Promise<WriteTransferRequestRevisionResult> {
	const request = normalizeTransferRequestSqlState(input);
	const stateHash = transferRequestSqlStateHash(request);
	await connection.query(`
		INSERT INTO stock_transfer_request_records (bitrix_external_id, display_name, deleted_at)
		VALUES (?, ?, NULL)
		ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), deleted_at = NULL
	`, [request.id, request.name]);
	const records = await connection.query<QueryRow[]>(`
		SELECT id, last_state_hash
		FROM stock_transfer_request_records
		WHERE bitrix_external_id = ?
		FOR UPDATE
	`, [request.id]);
	if (records.length !== 1) throw new Error('Transfer request identity row was not locked');
	const requestId = positiveInteger(records[0]!['id'], 'transfer request record id');
	const latest = await connection.query<QueryRow[]>(`
		SELECT id, revision_no, state_hash
		FROM stock_transfer_request_revisions
		WHERE request_id = ?
		ORDER BY revision_no DESC
		LIMIT 1
		FOR UPDATE
	`, [requestId]);
	const currentHash = records[0]!['last_state_hash'];
	if (latest.length && Buffer.isBuffer(currentHash) && currentHash.equals(hashBuffer(stateHash))) {
		return {
			externalId: request.id,
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
		requestId, revisionNo, hashBuffer(stateHash), input.sourceKind, request.kind, request.status,
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
	return { externalId: request.id, revisionId, revisionNo, stateHash, alreadyCurrent: false };
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
