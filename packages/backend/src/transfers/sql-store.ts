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
	revisionId: number;
	revisionNo: number;
	stateHash: string;
	alreadyCurrent: boolean;
}

export interface WriteNativeTransferResult {
	publicId: number;
	revisionId: number;
	revisionNo: number;
	stateHash: string;
	alreadyCurrent: boolean;
	alreadyApplied: boolean;
}

export interface PendingTransferBitrixMirror {
	publicId: number;
	bitrixExternalId: number | null;
	revisionId: number;
	attemptCount: number;
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

function sqlIdentifier(value: unknown, name: string): number {
	return requiredInteger(value, name);
}

function idempotencyKey(value: unknown): string {
	const key = bounded(value, 191, 'transfer idempotency key').trim();
	if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new Error('Invalid transfer idempotency key');
	return key;
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
	const externalId = requiredInteger(input.externalId, 'transfer external id');
	await connection.query(`
		INSERT IGNORE INTO stock_transfer_public_ids (public_id, legacy_bitrix_external_id)
		VALUES (?, ?)
	`, [externalId, externalId]);
	const allocations = await connection.query<QueryRow[]>(`
		SELECT public_id, legacy_bitrix_external_id
		FROM stock_transfer_public_ids
		WHERE public_id = ? OR legacy_bitrix_external_id = ?
		FOR UPDATE
	`, [externalId, externalId]);
	if (allocations.length !== 1 || Number(allocations[0]!['legacy_bitrix_external_id']) !== externalId) {
		throw new Error(`Transfer Bitrix identity ${externalId} conflicts with the SQL public-id allocator`);
	}
	const publicId = requiredInteger(allocations[0]!['public_id'], 'transfer public id');
	const transfer = normalizeTransferSqlState({ ...input, externalId: publicId });
	const stateHash = transferSqlStateHash(transfer);
	await connection.query(`
		INSERT INTO stock_transfer_records (public_id, bitrix_external_id, display_name, deleted_at)
		VALUES (?, ?, ?, NULL)
		ON DUPLICATE KEY UPDATE
			public_id = COALESCE(public_id, VALUES(public_id)),
			display_name = VALUES(display_name),
			deleted_at = NULL
	`, [publicId, externalId, transfer.name]);
	const records = await connection.query<QueryRow[]>(`
		SELECT id, public_id, last_state_hash
		FROM stock_transfer_records
		WHERE bitrix_external_id = ?
		FOR UPDATE
	`, [externalId]);
	if (records.length !== 1 || Number(records[0]!['public_id']) !== publicId) throw new Error('Transfer identity row was not locked');
	const result = await writeLockedTransferRevision(
		connection,
		transfer,
		input.sourceKind,
		records[0]!['id'],
		records[0]!['last_state_hash'],
		stateHash,
	);
	return { externalId, ...result };
}

async function writeLockedTransferRevision(
	connection: TransferSqlConnection,
	transfer: StoredTransfer,
	sourceKind: TransferSqlSourceKind,
	transferId: unknown,
	currentHash: unknown,
	stateHash = transferSqlStateHash(transfer),
): Promise<Omit<WriteTransferRevisionResult, 'externalId'>> {
	const latest = await connection.query<QueryRow[]>(`
		SELECT id, revision_no, state_format_version
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
		return {
			revisionId: sqlIdentifier(latest[0]!['id'], 'transfer revision id'),
			revisionNo: currentRevisionNo,
			stateHash,
			alreadyCurrent: true,
		};
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
		transferId, revisionNo, hashBuffer(stateHash), sourceKind, TRANSFER_SQL_STATE_FORMAT_VERSION,
		transfer.supplyRequest, transfer.supplyRequestKey, transfer.purchaseOrder,
		transfer.dealId, transfer.toStore, transfer.fromStore, transfer.status,
		transfer.note, transfer.taskId, transfer.shipEntry, transfer.receiveEntry,
		transfer.shortageReturnEntry, transfer.correctionOf, transfer.correctionKind,
		sqlDateTime(transfer.createdAt, 'created timestamp'), transfer.createdById,
		transfer.createdByName,
	]);
	const revisionId = sqlIdentifier(inserted.insertId, 'transfer revision insert id');
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
	return { revisionId, revisionNo, stateHash, alreadyCurrent: false };
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

type NativeCommandKind = 'create' | 'update';

async function lockNativeCommand(
	connection: TransferSqlConnection,
	key: string,
	kind: NativeCommandKind,
	requestHash: string,
): Promise<QueryRow> {
	await connection.query(`
		INSERT IGNORE INTO stock_transfer_commands (idempotency_key, command_kind, request_hash)
		VALUES (?, ?, ?)
	`, [key, kind, hashBuffer(requestHash)]);
	const rows = await connection.query<QueryRow[]>(`
		SELECT id, command_kind, request_hash, transfer_id, revision_id, completed_at
		FROM stock_transfer_commands
		WHERE idempotency_key = ?
		FOR UPDATE
	`, [key]);
	if (rows.length !== 1) throw new Error('Transfer idempotency command was not locked');
	const row = rows[0]!;
	if (String(row['command_kind']) !== kind || !Buffer.isBuffer(row['request_hash']) || !row['request_hash'].equals(hashBuffer(requestHash))) {
		throw new Error(`Transfer idempotency key ${key} was already used for another command`);
	}
	const hasTransfer = row['transfer_id'] != null;
	const hasRevision = row['revision_id'] != null;
	const completed = row['completed_at'] != null;
	if ((hasTransfer || hasRevision || completed) && !(hasTransfer && hasRevision && completed)) {
		throw new Error(`Transfer idempotency command ${key} has an incomplete result`);
	}
	return row;
}

async function completedNativeCommandResult(
	connection: TransferSqlConnection,
	command: QueryRow,
	requestHash: string,
): Promise<WriteNativeTransferResult | null> {
	if (command['transfer_id'] == null) return null;
	const rows = await connection.query<QueryRow[]>(`
		SELECT tr.public_id, r.id AS revision_id, r.revision_no
		FROM stock_transfer_records tr
		JOIN stock_transfer_revisions r ON r.id = ? AND r.transfer_id = tr.id
		WHERE tr.id = ?
		FOR UPDATE
	`, [command['revision_id'], command['transfer_id']]);
	if (rows.length !== 1) throw new Error('Transfer idempotency result is missing');
	return {
		publicId: requiredInteger(rows[0]!['public_id'], 'transfer public id'),
		revisionId: sqlIdentifier(rows[0]!['revision_id'], 'transfer revision id'),
		revisionNo: requiredInteger(rows[0]!['revision_no'], 'transfer revision number'),
		stateHash: requestHash,
		alreadyCurrent: true,
		alreadyApplied: true,
	};
}

async function completeNativeCommand(
	connection: TransferSqlConnection,
	commandId: unknown,
	transferId: unknown,
	revisionId: number,
): Promise<void> {
	const updated = await connection.query<SqlResult>(`
		UPDATE stock_transfer_commands
		SET transfer_id = ?, revision_id = ?, completed_at = CURRENT_TIMESTAMP(6)
		WHERE id = ? AND transfer_id IS NULL AND revision_id IS NULL AND completed_at IS NULL
	`, [transferId, revisionId, commandId]);
	if (Number(updated.affectedRows ?? 0) !== 1) throw new Error('Transfer idempotency command completion failed');
}

async function enqueueBitrixMirror(
	connection: TransferSqlConnection,
	transferId: unknown,
	revisionId: number,
): Promise<void> {
	await connection.query(`
		INSERT IGNORE INTO stock_transfer_bitrix_outbox (transfer_id, revision_id, operation_kind)
		VALUES (?, ?, 'upsert')
	`, [transferId, revisionId]);
}

function nativeRequestState(name: string, data: TransferData, publicId = 1): StoredTransfer {
	return normalizeTransferSqlState({ externalId: publicId, name, data, sourceKind: 'sql_native' });
}

export async function createNativeTransferSql(
	pool: TransferSqlPool,
	input: { idempotencyKey: string; name: string; data: TransferData },
): Promise<WriteNativeTransferResult> {
	const key = idempotencyKey(input.idempotencyKey);
	const requestState = nativeRequestState(input.name, input.data);
	const requestHash = transferSqlStateHash(requestState);
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const command = await lockNativeCommand(connection, key, 'create', requestHash);
		const completed = await completedNativeCommandResult(connection, command, requestHash);
		if (completed) {
			await connection.commit();
			transaction = false;
			return completed;
		}
		const allocation = await connection.query<SqlResult>(`
			INSERT INTO stock_transfer_public_ids (legacy_bitrix_external_id)
			VALUES (NULL)
		`);
		const publicId = sqlIdentifier(allocation.insertId, 'allocated transfer public id');
		const transfer = nativeRequestState(input.name, input.data, publicId);
		const stateHash = transferSqlStateHash(transfer);
		if (stateHash !== requestHash) throw new Error('Transfer public identity changed the command hash');
		const inserted = await connection.query<SqlResult>(`
			INSERT INTO stock_transfer_records (public_id, bitrix_external_id, display_name, deleted_at)
			VALUES (?, NULL, ?, NULL)
		`, [publicId, transfer.name]);
		const transferId = sqlIdentifier(inserted.insertId, 'transfer record insert id');
		const revision = await writeLockedTransferRevision(connection, transfer, 'sql_native', transferId, null, stateHash);
		await enqueueBitrixMirror(connection, transferId, revision.revisionId);
		await completeNativeCommand(connection, command['id'], transferId, revision.revisionId);
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

export async function updateNativeTransferSql(
	pool: TransferSqlPool,
	input: { publicId: number; idempotencyKey: string; name: string; data: TransferData },
): Promise<WriteNativeTransferResult> {
	const publicId = requiredInteger(input.publicId, 'transfer public id');
	const key = idempotencyKey(input.idempotencyKey);
	const transfer = nativeRequestState(input.name, input.data, publicId);
	const requestHash = transferSqlStateHash(transfer);
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const command = await lockNativeCommand(connection, key, 'update', requestHash);
		const completed = await completedNativeCommandResult(connection, command, requestHash);
		if (completed) {
			if (completed.publicId !== publicId) throw new Error(`Transfer idempotency key ${key} belongs to another document`);
			await connection.commit();
			transaction = false;
			return completed;
		}
		const records = await connection.query<QueryRow[]>(`
			SELECT id, last_state_hash
			FROM stock_transfer_records
			WHERE public_id = ? AND deleted_at IS NULL
			FOR UPDATE
		`, [publicId]);
		if (records.length !== 1) throw new Error(`Transfer #${publicId} was not found in SQL`);
		const transferId = records[0]!['id'];
		const revision = await writeLockedTransferRevision(
			connection,
			transfer,
			'sql_native',
			transferId,
			records[0]!['last_state_hash'],
			requestHash,
		);
		await enqueueBitrixMirror(connection, transferId, revision.revisionId);
		await completeNativeCommand(connection, command['id'], transferId, revision.revisionId);
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

export async function readPendingTransferBitrixMirrors(
	pool: TransferSqlPool,
	limit = 20,
): Promise<PendingTransferBitrixMirror[]> {
	const safeLimit = Math.min(Math.max(requiredInteger(limit, 'transfer outbox limit'), 1), 100);
	const rows = await pool.query<QueryRow[]>(`
		SELECT tr.public_id, tr.bitrix_external_id, MAX(o.revision_id) AS revision_id,
			MAX(o.attempt_count) AS attempt_count
		FROM stock_transfer_bitrix_outbox o
		JOIN stock_transfer_records tr ON tr.id = o.transfer_id
		WHERE (
			(o.status = 'pending' AND o.available_at <= CURRENT_TIMESTAMP(6))
			OR (o.status = 'processing' AND o.locked_until <= CURRENT_TIMESTAMP(6))
		) AND tr.deleted_at IS NULL
		GROUP BY tr.id, tr.public_id, tr.bitrix_external_id
		ORDER BY MIN(o.id)
		LIMIT ${safeLimit}
	`);
	return rows.map((row) => ({
		publicId: requiredInteger(row['public_id'], 'transfer public id'),
		bitrixExternalId: row['bitrix_external_id'] == null ? null : requiredInteger(row['bitrix_external_id'], 'transfer Bitrix id'),
		revisionId: sqlIdentifier(row['revision_id'], 'transfer revision id'),
		attemptCount: requiredInteger(row['attempt_count'], 'transfer mirror attempt count', true),
	}));
}

function mirrorLeaseToken(value: unknown): string {
	const token = bounded(value, 36, 'transfer mirror lease token').trim();
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(token)) {
		throw new Error('Invalid transfer mirror lease token');
	}
	return token;
}

export async function claimTransferBitrixMirror(
	pool: TransferSqlPool,
	input: { publicId: number; revisionId: number; leaseToken: string },
): Promise<boolean> {
	const publicId = requiredInteger(input.publicId, 'transfer public id');
	const revisionId = requiredInteger(input.revisionId, 'transfer revision id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const records = await connection.query<QueryRow[]>(`
			SELECT id
			FROM stock_transfer_records
			WHERE public_id = ? AND deleted_at IS NULL
			FOR UPDATE
		`, [publicId]);
		if (records.length !== 1) throw new Error(`Transfer #${publicId} was not found for Bitrix mirroring`);
		const transferId = records[0]!['id'];
		const active = await connection.query<QueryRow[]>(`
			SELECT id
			FROM stock_transfer_bitrix_outbox
			WHERE transfer_id = ? AND status = 'processing' AND locked_until > CURRENT_TIMESTAMP(6)
			LIMIT 1
			FOR UPDATE
		`, [transferId]);
		if (active.length) {
			await connection.commit();
			transaction = false;
			return false;
		}
		const claimed = await connection.query<SqlResult>(`
			UPDATE stock_transfer_bitrix_outbox
			SET status = 'processing', lease_token = ?, locked_until = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 60 SECOND)
			WHERE transfer_id = ? AND revision_id <= ? AND (
				(status = 'pending' AND available_at <= CURRENT_TIMESTAMP(6))
				OR (status = 'processing' AND locked_until <= CURRENT_TIMESTAMP(6))
			)
		`, [leaseToken, transferId, revisionId]);
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

export async function readTransferBitrixExternalId(
	pool: TransferSqlPool,
	publicIdInput: number,
): Promise<number | null> {
	const publicId = requiredInteger(publicIdInput, 'transfer public id');
	const rows = await pool.query<QueryRow[]>(`
		SELECT bitrix_external_id
		FROM stock_transfer_records
		WHERE public_id = ? AND deleted_at IS NULL
	`, [publicId]);
	if (!rows.length) return null;
	if (rows.length !== 1) throw new Error(`Transfer #${publicId} identity is ambiguous`);
	return rows[0]!['bitrix_external_id'] == null
		? null
		: requiredInteger(rows[0]!['bitrix_external_id'], 'transfer Bitrix id');
}

export async function recordTransferBitrixMirrorFailure(
	pool: TransferSqlPool,
	input: { publicId: number; revisionId: number; leaseToken: string; error: string },
): Promise<void> {
	const publicId = requiredInteger(input.publicId, 'transfer public id');
	const revisionId = requiredInteger(input.revisionId, 'transfer revision id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	const error = bounded(input.error, 1000, 'transfer mirror error');
	await pool.query(`
		UPDATE stock_transfer_bitrix_outbox o
		JOIN stock_transfer_records tr ON tr.id = o.transfer_id
		SET o.attempt_count = o.attempt_count + 1,
			o.last_attempt_at = CURRENT_TIMESTAMP(6),
			o.available_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL LEAST(300, POW(2, LEAST(o.attempt_count, 8))) SECOND),
			o.last_error = ?, o.status = 'pending', o.lease_token = NULL, o.locked_until = NULL
		WHERE tr.public_id = ? AND o.status = 'processing' AND o.lease_token = ? AND o.revision_id <= ?
	`, [error, publicId, leaseToken, revisionId]);
}

export async function markTransferBitrixMirrorDelivered(
	pool: TransferSqlPool,
	input: { publicId: number; revisionId: number; bitrixExternalId: number; leaseToken: string },
): Promise<void> {
	const publicId = requiredInteger(input.publicId, 'transfer public id');
	const revisionId = requiredInteger(input.revisionId, 'transfer revision id');
	const bitrixExternalId = requiredInteger(input.bitrixExternalId, 'transfer Bitrix id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	const connection = await pool.getConnection();
	let transaction = false;
	try {
		await connection.beginTransaction();
		transaction = true;
		const claims = await connection.query<QueryRow[]>(`
			SELECT o.id
			FROM stock_transfer_bitrix_outbox o
			JOIN stock_transfer_records tr ON tr.id = o.transfer_id
			WHERE tr.public_id = ? AND o.status = 'processing' AND o.lease_token = ? AND o.revision_id <= ?
			FOR UPDATE
		`, [publicId, leaseToken, revisionId]);
		if (!claims.length) {
			await connection.commit();
			transaction = false;
			return;
		}
		const allocations = await connection.query<QueryRow[]>(`
			SELECT public_id, legacy_bitrix_external_id
			FROM stock_transfer_public_ids
			WHERE public_id = ?
			FOR UPDATE
		`, [publicId]);
		if (allocations.length !== 1) throw new Error(`Transfer #${publicId} allocator row is missing`);
		const legacy = allocations[0]!['legacy_bitrix_external_id'];
		if (legacy != null && Number(legacy) !== bitrixExternalId) throw new Error(`Transfer #${publicId} already has another Bitrix mirror`);
		await connection.query(`
			UPDATE stock_transfer_public_ids
			SET legacy_bitrix_external_id = ?
			WHERE public_id = ?
		`, [bitrixExternalId, publicId]);
		const records = await connection.query<QueryRow[]>(`
			SELECT id, bitrix_external_id
			FROM stock_transfer_records
			WHERE public_id = ?
			FOR UPDATE
		`, [publicId]);
		if (records.length !== 1) throw new Error(`Transfer #${publicId} record is missing`);
		const currentExternalId = records[0]!['bitrix_external_id'];
		if (currentExternalId != null && Number(currentExternalId) !== bitrixExternalId) {
			throw new Error(`Transfer #${publicId} already points to another Bitrix mirror`);
		}
		await connection.query(`
			UPDATE stock_transfer_records
			SET bitrix_external_id = ?
			WHERE public_id = ?
		`, [bitrixExternalId, publicId]);
		await connection.query(`
			UPDATE stock_transfer_bitrix_outbox o
			JOIN stock_transfer_records tr ON tr.id = o.transfer_id
			SET o.status = 'delivered', o.attempt_count = o.attempt_count + 1,
				o.last_attempt_at = CURRENT_TIMESTAMP(6), o.lease_token = NULL, o.locked_until = NULL,
				o.completed_at = CURRENT_TIMESTAMP(6), o.last_error = ''
			WHERE tr.public_id = ? AND o.status = 'processing' AND o.lease_token = ? AND o.revision_id <= ?
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
