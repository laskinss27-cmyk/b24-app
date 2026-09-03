import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import {
	parseTransferItem,
	type StoredTransfer,
	type TransferData,
	type TransferHistoryAction,
	type TransferHistoryChange,
	type TransferHistoryEvent,
	type TransferLine,
	type TransferStatus,
} from './model.js';

export type TransferSqlSourceKind = 'bitrix_backfill' | 'bitrix_dual_write' | 'sql_native' | 'repair';
export type TransferLinePhase = 'planned' | 'collected' | 'shipped' | 'accepted' | 'received' | 'shortage';
export const TRANSFER_SQL_STATE_FORMAT_VERSION = 2;

export interface TransferSqlConnection {
	query<T = unknown>(sql: string, values?: unknown[]): Promise<T>;
	batch(sql: string, values: unknown[][]): Promise<unknown>;
	beginTransaction(): Promise<void>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	release(): void | Promise<void>;
}

export interface TransferSqlPool {
	getConnection(): Promise<TransferSqlConnection>;
	query<T = unknown>(sql: string, values?: unknown[]): Promise<T>;
}

export interface WriteTransferRevisionInput {
	externalId: number;
	name: string;
	data: TransferData;
	sourceKind: TransferSqlSourceKind;
}

export interface WriteTransferRevisionResult {
	externalId: number;
	revisionNo: number;
	stateHash: string;
	alreadyCurrent: boolean;
}

type QueryRow = Record<string, unknown>;
type SqlResult = { affectedRows?: number; insertId?: bigint | number | string };

const STATUSES = new Set<TransferStatus>([
	'draft', 'collected', 'in_transit', 'accepted', 'posted', 'canceled',
	'requested', 'received', 'shortage',
]);
const ACTIONS = new Set<TransferHistoryAction>([
	'created', 'lines_changed', 'destination_changed', 'collected', 'shipped',
	'accepted', 'posted', 'canceled', 'notification_sent', 'notification_failed', 'legacy',
]);
const CHANGE_FIELDS = new Set<TransferHistoryChange['field']>(['planned', 'collected', 'accepted', 'destination']);

function requiredInteger(value: unknown, name: string, allowZero = false): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) throw new Error(`Invalid ${name}`);
	return parsed;
}

function bounded(value: unknown, max: number, name: string): string {
	const text = String(value ?? '');
	if (text.length > max) throw new Error(`${name} exceeds ${max} characters`);
	return text;
}

function canonicalTimestamp(value: string, name: string): string {
	if (!value.trim()) return '';
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${name}`);
	return date.toISOString();
}

function sqlDateTime(value: string, name: string): Date | null {
	const canonical = canonicalTimestamp(value, name);
	return canonical ? new Date(canonical) : null;
}

function normalizedLine(value: TransferLine): TransferLine {
	const productId = requiredInteger(value.productId, 'transfer product id');
	const qty = Number(value.qty);
	if (!Number.isFinite(qty) || qty < 0) throw new Error('Invalid transfer quantity');
	return { productId, name: bounded(value.name, 500, 'transfer product name'), qty };
}

function normalizedChange(value: TransferHistoryChange): TransferHistoryChange {
	const field = String(value.field) as TransferHistoryChange['field'];
	if (!CHANGE_FIELDS.has(field)) throw new Error(`Invalid transfer history field: ${field}`);
	return {
		productId: requiredInteger(value.productId, 'transfer history product id', field === 'destination'),
		name: bounded(value.name, 500, 'transfer history product name'),
		field,
		from: typeof value.from === 'number' ? value.from : bounded(value.from, 500, 'transfer history from value'),
		to: typeof value.to === 'number' ? value.to : bounded(value.to, 500, 'transfer history to value'),
	};
}

function normalizedHistory(value: TransferHistoryEvent): TransferHistoryEvent {
	const status = String(value.status) as TransferStatus;
	if (!STATUSES.has(status)) throw new Error(`Invalid transfer history status: ${status}`);
	const action = value.action == null ? undefined : String(value.action) as TransferHistoryAction;
	if (action && !ACTIONS.has(action)) throw new Error(`Invalid transfer history action: ${action}`);
	const at = canonicalTimestamp(bounded(value.at, 64, 'transfer history timestamp'), 'transfer history timestamp');
	const byName = value.byName == null ? '' : bounded(value.byName, 255, 'transfer history actor name');
	const note = value.note == null ? '' : bounded(value.note, 10_000, 'transfer history note');
	const changes = value.changes == null ? [] : value.changes.map(normalizedChange);
	return {
		at,
		status,
		byId: bounded(value.byId, 191, 'transfer history actor id'),
		...(byName ? { byName } : {}),
		...(action ? { action } : {}),
		...(note ? { note } : {}),
		...(changes.length ? { changes } : {}),
	};
}

export function normalizeTransferSqlState(input: WriteTransferRevisionInput): StoredTransfer {
	const externalId = requiredInteger(input.externalId, 'transfer external id');
	const name = bounded(input.name.trim(), 255, 'transfer display name');
	if (!name) throw new Error('Transfer display name is required');
	if (!STATUSES.has(input.data.status)) throw new Error('Transfer status is invalid');
	for (const [field, lines] of Object.entries({
		lines: input.data.lines,
		collectedLines: input.data.collectedLines,
		shippedLines: input.data.shippedLines,
		acceptedLines: input.data.acceptedLines,
		receivedLines: input.data.receivedLines,
		shortageLines: input.data.shortageLines,
	})) {
		if (!Array.isArray(lines)) throw new Error(`Transfer ${field} must be an array`);
		lines.forEach(normalizedLine);
	}
	if (!Array.isArray(input.data.history)) throw new Error('Transfer history must be an array');
	if (!Array.isArray(input.data.correctionIds)) throw new Error('Transfer correctionIds must be an array');
	const parsed = parseTransferItem({ ID: externalId, NAME: name, DETAIL_TEXT: JSON.stringify(input.data) });
	if (!parsed) throw new Error('Transfer data is invalid');
	if (!STATUSES.has(parsed.status)) throw new Error('Transfer status is invalid');
	return {
		...parsed,
		supplyRequest: bounded(parsed.supplyRequest, 191, 'supply request'),
		supplyRequestKey: bounded(parsed.supplyRequestKey, 191, 'supply request key'),
		purchaseOrder: bounded(parsed.purchaseOrder, 191, 'purchase order'),
		dealId: bounded(parsed.dealId, 64, 'deal id'),
		toStore: bounded(parsed.toStore, 191, 'target store'),
		fromStore: bounded(parsed.fromStore, 191, 'source store'),
		note: bounded(parsed.note, 10_000, 'transfer note'),
		shipEntry: parsed.shipEntry == null ? null : bounded(parsed.shipEntry, 191, 'ship entry'),
		receiveEntry: parsed.receiveEntry == null ? null : bounded(parsed.receiveEntry, 191, 'receive entry'),
		shortageReturnEntry: parsed.shortageReturnEntry == null ? null : bounded(parsed.shortageReturnEntry, 191, 'shortage return entry'),
		createdAt: canonicalTimestamp(bounded(parsed.createdAt, 64, 'created timestamp'), 'created timestamp'),
		createdById: bounded(parsed.createdById, 191, 'creator id'),
		createdByName: bounded(parsed.createdByName, 255, 'creator name'),
		lines: parsed.lines.map(normalizedLine),
		collectedLines: parsed.collectedLines.map(normalizedLine),
		shippedLines: parsed.shippedLines.map(normalizedLine),
		acceptedLines: parsed.acceptedLines.map(normalizedLine),
		receivedLines: parsed.receivedLines.map(normalizedLine),
		shortageLines: parsed.shortageLines.map(normalizedLine),
		correctionIds: parsed.correctionIds.map((id) => requiredInteger(id, 'correction id')),
		history: parsed.history.map(normalizedHistory),
	};
}

function transferData(transfer: StoredTransfer): TransferData {
	const { id: _id, name: _name, ...data } = transfer;
	return data;
}

export function transferSqlStateHash(transfer: StoredTransfer): string {
	const normalized = normalizeTransferSqlState({
		externalId: transfer.id,
		name: transfer.name,
		data: transferData(transfer),
		sourceKind: 'repair',
	});
	return createHash('sha256')
		.update(supplyMirrorCanonicalJson({ name: normalized.name, data: transferData(normalized) }))
		.digest('hex');
}

function hashBuffer(hash: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid transfer state hash');
	return Buffer.from(hash, 'hex');
}

function phaseRows(revisionId: unknown, phase: TransferLinePhase, lines: TransferLine[]): unknown[][] {
	return lines.map((line, index) => [revisionId, phase, index + 1, line.productId, line.name, line.qty]);
}

export async function writeTransferSqlRevisionOnConnection(
	connection: TransferSqlConnection,
	input: WriteTransferRevisionInput,
): Promise<WriteTransferRevisionResult> {
	const transfer = normalizeTransferSqlState(input);
	const stateHash = transferSqlStateHash(transfer);
	await connection.query(`
		INSERT INTO stock_transfer_records (bitrix_external_id, display_name, deleted_at)
		VALUES (?, ?, NULL)
		ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), deleted_at = NULL
	`, [transfer.id, transfer.name]);
	const records = await connection.query<QueryRow[]>(`
		SELECT id, last_state_hash
		FROM stock_transfer_records
		WHERE bitrix_external_id = ?
		FOR UPDATE
	`, [transfer.id]);
	if (records.length !== 1) throw new Error('Transfer identity row was not locked');
	const transferId = records[0]!['id'];
	const currentHash = records[0]!['last_state_hash'];
	const latest = await connection.query<QueryRow[]>(`
		SELECT revision_no, state_format_version
		FROM stock_transfer_revisions
		WHERE transfer_id = ?
		ORDER BY revision_no DESC
		LIMIT 1
		FOR UPDATE
	`, [transferId]);
	const currentRevisionNo = latest.length ? Number(latest[0]!['revision_no']) : 0;
	const currentFormatVersion = latest.length ? Number(latest[0]!['state_format_version']) : 0;
	if (Buffer.isBuffer(currentHash)
		&& currentHash.equals(hashBuffer(stateHash))
		&& currentFormatVersion === TRANSFER_SQL_STATE_FORMAT_VERSION) {
		return { externalId: transfer.id, revisionNo: currentRevisionNo, stateHash, alreadyCurrent: true };
	}
	const revisionNo = currentRevisionNo + 1;
	const inserted = await connection.query<SqlResult>(`
		INSERT INTO stock_transfer_revisions (
			transfer_id, revision_no, state_hash, source_kind, state_format_version, supply_request,
			supply_request_key, purchase_order, deal_id, to_store, from_store,
			status, note, task_id, ship_entry, receive_entry, shortage_return_entry,
			correction_of_external_id, correction_kind, source_created_at,
			created_by_id, created_by_name
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, [
		transferId, revisionNo, hashBuffer(stateHash), input.sourceKind, TRANSFER_SQL_STATE_FORMAT_VERSION,
		transfer.supplyRequest, transfer.supplyRequestKey, transfer.purchaseOrder,
		transfer.dealId, transfer.toStore, transfer.fromStore, transfer.status,
		transfer.note, transfer.taskId, transfer.shipEntry, transfer.receiveEntry,
		transfer.shortageReturnEntry, transfer.correctionOf, transfer.correctionKind,
		sqlDateTime(transfer.createdAt, 'created timestamp'), transfer.createdById,
		transfer.createdByName,
	]);
	const revisionId = inserted.insertId;
	if (revisionId == null || String(revisionId) === '0') throw new Error('Transfer revision insert did not return id');
	const lines = [
		...phaseRows(revisionId, 'planned', transfer.lines),
		...phaseRows(revisionId, 'collected', transfer.collectedLines),
		...phaseRows(revisionId, 'shipped', transfer.shippedLines),
		...phaseRows(revisionId, 'accepted', transfer.acceptedLines),
		...phaseRows(revisionId, 'received', transfer.receivedLines),
		...phaseRows(revisionId, 'shortage', transfer.shortageLines),
	];
	if (lines.length) await connection.batch(`
		INSERT INTO stock_transfer_revision_lines (
			revision_id, phase, line_ordinal, product_id, product_name, quantity
		) VALUES (?, ?, ?, ?, ?, ?)
	`, lines);
	const history = transfer.history.map((event, index) => [
		revisionId, index + 1, sqlDateTime(event.at, 'history timestamp'), event.status,
		event.byId, event.byName ?? '', event.action ?? null, event.note ?? '',
	]);
	if (history.length) await connection.batch(`
		INSERT INTO stock_transfer_revision_history (
			revision_id, event_ordinal, event_at, status, actor_id, actor_name,
			action_name, note
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, history);
	const changes = transfer.history.flatMap((event, eventIndex) => (event.changes ?? []).map((change, changeIndex) => [
		revisionId, eventIndex + 1, changeIndex + 1, change.productId, change.name,
		change.field, String(change.from), typeof change.from, String(change.to), typeof change.to,
	]));
	if (changes.length) await connection.batch(`
		INSERT INTO stock_transfer_history_changes (
			revision_id, event_ordinal, change_ordinal, product_id, product_name,
			field_name, from_value, from_value_type, to_value, to_value_type
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, changes);
	if (transfer.correctionIds.length) await connection.batch(`
		INSERT INTO stock_transfer_revision_corrections (
			revision_id, correction_ordinal, correction_external_id
		) VALUES (?, ?, ?)
	`, transfer.correctionIds.map((id, index) => [revisionId, index + 1, id]));
	const updated = await connection.query<SqlResult>(`
		UPDATE stock_transfer_records
		SET display_name = ?, last_state_hash = ?, deleted_at = NULL
		WHERE id = ?
	`, [transfer.name, hashBuffer(stateHash), transferId]);
	if (Number(updated.affectedRows ?? 0) !== 1) throw new Error('Transfer current revision pointer update failed');
	return { externalId: transfer.id, revisionNo, stateHash, alreadyCurrent: false };
}

export async function writeTransferSqlRevision(
	pool: TransferSqlPool,
	input: WriteTransferRevisionInput,
): Promise<WriteTransferRevisionResult> {
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const result = await writeTransferSqlRevisionOnConnection(connection, input);
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

export async function markTransferSqlDeleted(
	pool: TransferSqlPool,
	input: { externalId: number; name: string; deletedAt?: Date },
): Promise<void> {
	const externalId = requiredInteger(input.externalId, 'transfer external id');
	const name = bounded(input.name.trim(), 255, 'transfer display name');
	if (!name) throw new Error('Transfer display name is required');
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		await connection.query(`
			INSERT INTO stock_transfer_records (bitrix_external_id, display_name, deleted_at)
			VALUES (?, ?, ?)
			ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), deleted_at = VALUES(deleted_at)
		`, [externalId, name, input.deletedAt ?? new Date()]);
		await connection.commit();
		transaction = false;
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		await connection.release();
	}
}
