import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import type { TransferSqlConnection, TransferSqlPool } from '../transfers/sql-store.js';
import type { InventorySqlBackfillPlan } from './backfill-plan.js';
import { normalizeInventorySqlState, type InventorySqlPoint, type InventorySqlRecord, type InventorySqlSnapshotLine } from './model.js';

type QueryRow = Record<string, unknown>;
type SqlResult = { affectedRows?: number; insertId?: bigint | number | string };
const INVENTORY_WRITE_LOCK = 'b24_app_inventory_write';

export interface WriteNativeInventoryResult {
	publicId: number;
	mutationId: number;
	mutationNo: number;
	stateHash: string;
	alreadyCurrent: boolean;
	alreadyApplied: boolean;
}

export interface PendingInventoryBitrixMirror {
	publicId: number;
	bitrixExternalId: number | null;
	mutationId: number;
	attemptCount: number;
	operationKind: 'upsert' | 'delete';
}

function hashBuffer(hash: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid inventory hash');
	return Buffer.from(hash, 'hex');
}

function positiveSqlId(value: unknown, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
	return parsed;
}

function sqlDate(value: string | null): string | null {
	if (!value) return null;
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid inventory timestamp');
	// DATETIME has no timezone. Passing a JavaScript Date lets the MariaDB driver
	// translate it through the host timezone, so an 08:00Z snapshot can come back
	// as 11:00Z on a Moscow host. Store the already-canonical UTC wall time.
	return parsed.toISOString().replace('T', ' ').replace('Z', '');
}

function storedTimestamp(value: unknown, name: string): string | null {
	if (value == null || String(value).trim() === '') return null;
	const source = String(value).trim();
	const sql = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(source);
	const parsed = new Date(sql
		? `${sql[1]}T${sql[2]}.${String(sql[3] ?? '').padEnd(3, '0').slice(0, 3)}Z`
		: source);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid ${name}`);
	return parsed.toISOString();
}

function normalizedQuantity(value: unknown): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error('Invalid stored inventory quantity');
	return parsed;
}

export function assertFrozenInventorySnapshot(
	storedRows: Array<{ productId: number; bookQty: number }>,
	sourceRows: InventorySqlSnapshotLine[],
): void {
	const stored = [...storedRows].sort((left, right) => left.productId - right.productId);
	const source = [...sourceRows].sort((left, right) => left.productId - right.productId);
	if (stored.length !== source.length) throw new Error('Frozen inventory snapshot changed after its first SQL write');
	for (let index = 0; index < source.length; index += 1) {
		if (stored[index]!.productId !== source[index]!.productId || Math.abs(stored[index]!.bookQty - source[index]!.bookQty) >= 1e-9) {
			throw new Error('Frozen inventory snapshot changed after its first SQL write');
		}
	}
}

async function lockInventoryRecord(
	connection: TransferSqlConnection,
	inventory: InventorySqlRecord,
	bitrixExternalId: number | null = inventory.bitrixExternalId,
): Promise<QueryRow> {
	await connection.query(`
		INSERT IGNORE INTO inventory_public_ids (public_id, legacy_bitrix_external_id)
		VALUES (?, ?)
	`, [inventory.bitrixExternalId, bitrixExternalId]);
	const allocations = await connection.query<QueryRow[]>(`
		SELECT public_id, legacy_bitrix_external_id FROM inventory_public_ids
		WHERE public_id = ? OR (? IS NOT NULL AND legacy_bitrix_external_id = ?) FOR UPDATE
	`, [inventory.bitrixExternalId, bitrixExternalId, bitrixExternalId]);
	if (allocations.length !== 1
		|| Number(allocations[0]!['public_id']) !== inventory.bitrixExternalId
		|| (bitrixExternalId != null && Number(allocations[0]!['legacy_bitrix_external_id']) !== bitrixExternalId)) {
		throw new Error(`Inventory ${inventory.bitrixExternalId} conflicts with the SQL public-id allocator`);
	}
	let rows = await connection.query<QueryRow[]>(`
		SELECT id, public_id, bitrix_external_id, last_state_hash,
			DATE_FORMAT(stock_snapshot_at, '%Y-%m-%d %H:%i:%s.%f') AS stock_snapshot_at
		FROM inventory_records
		WHERE public_id = ? OR (? IS NOT NULL AND bitrix_external_id = ?)
		FOR UPDATE
	`, [inventory.bitrixExternalId, bitrixExternalId, bitrixExternalId]);
	if (rows.length > 1) throw new Error(`Inventory ${inventory.bitrixExternalId} identity is duplicated`);
	if (rows.length && Number(rows[0]!['public_id']) !== inventory.bitrixExternalId) {
		throw new Error(`Inventory ${inventory.bitrixExternalId} SQL public identity differs from its record`);
	}
	if (rows.length && storedTimestamp(rows[0]!['stock_snapshot_at'], 'inventory stock snapshot timestamp')
		&& storedTimestamp(rows[0]!['stock_snapshot_at'], 'inventory stock snapshot timestamp') !== inventory.stockSnapshotAt) {
		throw new Error(`Inventory ${inventory.bitrixExternalId} opening snapshot timestamp changed`);
	}
	await connection.query(`
		INSERT INTO inventory_records (
			public_id, bitrix_external_id, display_name, inventory_status, deadline, created_by_id,
			source_created_at, stock_snapshot_at, last_state_hash, deleted_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
		ON DUPLICATE KEY UPDATE
			public_id = COALESCE(public_id, VALUES(public_id)),
			display_name = VALUES(display_name), inventory_status = VALUES(inventory_status),
			deadline = VALUES(deadline), created_by_id = VALUES(created_by_id),
			source_created_at = VALUES(source_created_at), stock_snapshot_at = VALUES(stock_snapshot_at),
			deleted_at = NULL
	`, [
		inventory.bitrixExternalId, bitrixExternalId, inventory.displayName, inventory.status, inventory.deadline,
		inventory.createdById, sqlDate(inventory.sourceCreatedAt), sqlDate(inventory.stockSnapshotAt),
	]);
	if (!rows.length) rows = await connection.query<QueryRow[]>(`
		SELECT id, public_id, bitrix_external_id, last_state_hash,
			DATE_FORMAT(stock_snapshot_at, '%Y-%m-%d %H:%i:%s.%f') AS stock_snapshot_at
		FROM inventory_records
		WHERE public_id = ?
		FOR UPDATE
	`, [inventory.bitrixExternalId]);
	if (rows.length !== 1) throw new Error(`Inventory ${inventory.bitrixExternalId} identity row was not locked`);
	return rows[0]!;
}

async function tombstoneInventoryChildren(connection: TransferSqlConnection, inventoryId: number): Promise<void> {
	await connection.query('UPDATE inventory_sections SET is_present = 0 WHERE inventory_id = ?', [inventoryId]);
	await connection.query(`
		UPDATE inventory_count_lines line
		JOIN inventory_points point ON point.id = line.point_id
		SET line.is_present = 0
		WHERE point.inventory_id = ?
	`, [inventoryId]);
	await connection.query(`
		UPDATE inventory_result_lines line
		JOIN inventory_points point ON point.id = line.point_id
		SET line.is_present = 0
		WHERE point.inventory_id = ?
	`, [inventoryId]);
	await connection.query(`
		UPDATE inventory_erp_documents document
		JOIN inventory_points point ON point.id = document.point_id
		SET document.is_present = 0
		WHERE point.inventory_id = ?
	`, [inventoryId]);
	await connection.query('UPDATE inventory_points SET is_present = 0 WHERE inventory_id = ?', [inventoryId]);
}

async function upsertSections(connection: TransferSqlConnection, inventoryId: number, sectionIds: number[]): Promise<void> {
	if (!sectionIds.length) return;
	await connection.batch(`
		INSERT INTO inventory_sections (inventory_id, section_id, section_ordinal, is_present)
		VALUES (?, ?, ?, 1)
		ON DUPLICATE KEY UPDATE section_ordinal = VALUES(section_ordinal), is_present = 1
	`, sectionIds.map((sectionId, index) => [inventoryId, sectionId, index + 1]));
}

async function lockPoint(connection: TransferSqlConnection, inventoryId: number, point: InventorySqlPoint): Promise<number> {
	let rows = await connection.query<QueryRow[]>(`
		SELECT id, snapshot_version,
			DATE_FORMAT(snapshot_captured_at, '%Y-%m-%d %H:%i:%s.%f') AS snapshot_captured_at
		FROM inventory_points
		WHERE inventory_id = ? AND store_id = ?
		FOR UPDATE
	`, [inventoryId, point.storeId]);
	if (rows.length > 1) throw new Error(`Inventory point ${inventoryId}/${point.storeId} is duplicated`);
	if (rows.length && rows[0]!['snapshot_version'] != null) {
		const storedVersion = Number(rows[0]!['snapshot_version']);
		const storedCapturedAt = storedTimestamp(rows[0]!['snapshot_captured_at'], 'inventory point snapshot timestamp');
		if (storedVersion !== point.snapshotVersion || storedCapturedAt !== point.snapshotCapturedAt) {
			throw new Error(`Inventory point ${inventoryId}/${point.storeId} frozen snapshot metadata changed`);
		}
	}
	await connection.query(`
		INSERT INTO inventory_points (
			inventory_id, point_ordinal, store_id, store_name, point_status,
			responsible_id, responsible_name, started_at, submitted_at, act_at,
			snapshot_version, snapshot_captured_at, snapshot_migrated_at,
			draft_updated_at, draft_updated_by_id, draft_updated_by_name,
			draft_session_id, draft_sequence,
			result_total, result_counted, result_discrepancies, result_book_at, is_present
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		ON DUPLICATE KEY UPDATE
			point_ordinal = VALUES(point_ordinal), store_name = VALUES(store_name), point_status = VALUES(point_status),
			responsible_id = VALUES(responsible_id), responsible_name = VALUES(responsible_name),
			started_at = VALUES(started_at), submitted_at = VALUES(submitted_at), act_at = VALUES(act_at),
			snapshot_version = VALUES(snapshot_version), snapshot_captured_at = VALUES(snapshot_captured_at),
			snapshot_migrated_at = VALUES(snapshot_migrated_at), draft_updated_at = VALUES(draft_updated_at),
			draft_updated_by_id = VALUES(draft_updated_by_id), draft_updated_by_name = VALUES(draft_updated_by_name),
			draft_session_id = VALUES(draft_session_id), draft_sequence = VALUES(draft_sequence),
			result_total = VALUES(result_total), result_counted = VALUES(result_counted),
			result_discrepancies = VALUES(result_discrepancies), result_book_at = VALUES(result_book_at), is_present = 1
	`, [
		inventoryId, point.ordinal, point.storeId, point.storeName, point.status,
		point.responsibleId, point.responsibleName, sqlDate(point.startedAt), sqlDate(point.submittedAt), sqlDate(point.actAt),
		point.snapshotVersion, sqlDate(point.snapshotCapturedAt), sqlDate(point.snapshotMigratedAt),
		sqlDate(point.draftUpdatedAt), point.draftUpdatedById, point.draftUpdatedByName,
		point.draftSessionId, point.draftSequence,
		point.resultTotal, point.resultCounted, point.resultDiscrepancies,
		sqlDate(point.resultBookAt),
	]);
	if (!rows.length) rows = await connection.query<QueryRow[]>(`
		SELECT id, snapshot_version,
			DATE_FORMAT(snapshot_captured_at, '%Y-%m-%d %H:%i:%s.%f') AS snapshot_captured_at
		FROM inventory_points
		WHERE inventory_id = ? AND store_id = ?
		FOR UPDATE
	`, [inventoryId, point.storeId]);
	if (rows.length !== 1) throw new Error(`Inventory point ${inventoryId}/${point.storeId} was not locked`);
	return positiveSqlId(rows[0]!['id'], 'inventory point id');
}

async function preserveSnapshot(connection: TransferSqlConnection, pointId: number, point: InventorySqlPoint): Promise<void> {
	const rows = await connection.query<QueryRow[]>(`
		SELECT product_id, book_qty
		FROM inventory_snapshot_lines
		WHERE point_id = ?
		ORDER BY product_id
		FOR UPDATE
	`, [pointId]);
	const stored = rows.map((row) => ({
		productId: positiveSqlId(row['product_id'], 'inventory snapshot product id'),
		bookQty: normalizedQuantity(row['book_qty']),
	}));
	if (stored.length) {
		assertFrozenInventorySnapshot(stored, point.snapshotLines);
		return;
	}
	if (!point.snapshotLines.length) return;
	await connection.batch(`
		INSERT INTO inventory_snapshot_lines (point_id, product_id, book_qty)
		VALUES (?, ?, ?)
	`, point.snapshotLines.map((line) => [pointId, line.productId, line.bookQty]));
}

async function upsertPointLines(connection: TransferSqlConnection, pointId: number, point: InventorySqlPoint): Promise<void> {
	if (point.countLines.length) await connection.batch(`
		INSERT INTO inventory_count_lines (point_id, product_id, fact_qty, line_comment, is_present)
		VALUES (?, ?, ?, ?, 1)
		ON DUPLICATE KEY UPDATE fact_qty = VALUES(fact_qty), line_comment = VALUES(line_comment), is_present = 1
	`, point.countLines.map((line) => [pointId, line.productId, line.factQty, line.comment]));
	if (point.resultLines.length) await connection.batch(`
		INSERT INTO inventory_result_lines (
			point_id, line_ordinal, product_id, product_name, book_qty, fact_qty,
			difference_qty, line_comment, is_present
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
		ON DUPLICATE KEY UPDATE
			line_ordinal = VALUES(line_ordinal), product_name = VALUES(product_name),
			book_qty = VALUES(book_qty), fact_qty = VALUES(fact_qty), difference_qty = VALUES(difference_qty),
			line_comment = VALUES(line_comment), is_present = 1
	`, point.resultLines.map((line) => [
		pointId, line.ordinal, line.productId, line.productName, line.bookQty,
		line.factQty, line.differenceQty, line.comment,
	]));
	if (point.erpDocuments.length) await connection.batch(`
		INSERT INTO inventory_erp_documents (
			point_id, document_kind, erp_doctype, erp_document_name,
			document_status, line_count, saved_at, submitted_at, is_present
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
		ON DUPLICATE KEY UPDATE
			erp_doctype = VALUES(erp_doctype), erp_document_name = VALUES(erp_document_name),
			document_status = VALUES(document_status), line_count = VALUES(line_count),
			saved_at = VALUES(saved_at), submitted_at = VALUES(submitted_at), is_present = 1
	`, point.erpDocuments.map((document) => [
		pointId, document.kind, document.erpDoctype, document.name, document.status,
		document.lineCount, sqlDate(document.savedAt), sqlDate(document.submittedAt),
	]));
}

async function writeInventory(connection: TransferSqlConnection, inventory: InventorySqlRecord, bitrixExternalId?: number | null): Promise<boolean> {
	const locked = await lockInventoryRecord(connection, inventory, bitrixExternalId);
	const inventoryId = positiveSqlId(locked['id'], 'inventory record id');
	if (Buffer.isBuffer(locked['last_state_hash']) && locked['last_state_hash'].equals(hashBuffer(inventory.stateHash))) return false;
	await tombstoneInventoryChildren(connection, inventoryId);
	await upsertSections(connection, inventoryId, inventory.sectionIds);
	for (const point of inventory.points) {
		const pointId = await lockPoint(connection, inventoryId, point);
		await preserveSnapshot(connection, pointId, point);
		await upsertPointLines(connection, pointId, point);
	}
	const result = await connection.query<SqlResult>(`
		UPDATE inventory_records SET last_state_hash = ?, deleted_at = NULL WHERE id = ?
	`, [hashBuffer(inventory.stateHash), inventoryId]);
	if (Number(result.affectedRows ?? 0) !== 1) throw new Error(`Inventory ${inventory.bitrixExternalId} final hash update failed`);
	return true;
}

async function withInventorySqlWriteLock<T>(
	pool: TransferSqlPool,
	action: (connection: TransferSqlConnection) => Promise<T>,
): Promise<T> {
	const connection = await pool.getConnection();
	let transaction = false;
	let locked = false;
	try {
		const lockRows = await connection.query<QueryRow[]>('SELECT GET_LOCK(?, 10) AS acquired', [INVENTORY_WRITE_LOCK]);
		if (Number(lockRows[0]?.['acquired']) !== 1) throw new Error('Could not acquire inventory SQL write lock');
		locked = true;
		await connection.beginTransaction();
		transaction = true;
		const result = await action(connection);
		await connection.commit();
		transaction = false;
		return result;
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		if (locked) await connection.query('SELECT RELEASE_LOCK(?) AS released', [INVENTORY_WRITE_LOCK]).catch(() => undefined);
		await connection.release();
	}
}

export async function writeInventorySqlRecord(
	pool: TransferSqlPool,
	inventory: InventorySqlRecord,
): Promise<{ changed: boolean }> {
	return withInventorySqlWriteLock(pool, async (connection) => ({ changed: await writeInventory(connection, inventory) }));
}

export async function markInventorySqlDeleted(
	pool: TransferSqlPool,
	input: { externalId: number; deletedAt?: Date },
): Promise<{ alreadyDeleted: boolean }> {
	if (!Number.isSafeInteger(input.externalId) || input.externalId <= 0) throw new Error('Invalid inventory external id');
	return withInventorySqlWriteLock(pool, async (connection) => {
		const rows = await connection.query<QueryRow[]>(`
			SELECT id, deleted_at
			FROM inventory_records
			WHERE bitrix_external_id = ?
			FOR UPDATE
		`, [input.externalId]);
		if (rows.length !== 1) throw new Error(`Inventory ${input.externalId} SQL row is missing or duplicated`);
		if (rows[0]!['deleted_at'] != null) return { alreadyDeleted: true };
		const result = await connection.query<SqlResult>(`
			UPDATE inventory_records
			SET deleted_at = ?
			WHERE id = ? AND deleted_at IS NULL
		`, [sqlDate((input.deletedAt ?? new Date()).toISOString()), positiveSqlId(rows[0]!['id'], 'inventory record id')]);
		if (Number(result.affectedRows ?? 0) !== 1) throw new Error(`Inventory ${input.externalId} SQL tombstone failed`);
		return { alreadyDeleted: false };
	});
}

type NativeInventoryCommandKind = 'create' | 'update' | 'delete';

function bounded(value: unknown, max: number, name: string): string {
	const text = String(value ?? '');
	if (text.length > max) throw new Error(`${name} exceeds ${max} characters`);
	return text;
}

function nativeIdempotencyKey(value: unknown): string {
	const key = bounded(value, 191, 'inventory idempotency key').trim();
	if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new Error('Invalid inventory idempotency key');
	return key;
}

function requestHash(value: unknown): string {
	return createHash('sha256').update(supplyMirrorCanonicalJson(value)).digest('hex');
}

async function lockNativeCommand(
	connection: TransferSqlConnection,
	key: string,
	kind: NativeInventoryCommandKind,
	hash: string,
): Promise<QueryRow> {
	await connection.query(`
		INSERT IGNORE INTO inventory_commands (idempotency_key, command_kind, request_hash)
		VALUES (?, ?, ?)
	`, [key, kind, hashBuffer(hash)]);
	const rows = await connection.query<QueryRow[]>(`
		SELECT id, command_kind, request_hash, inventory_id, mutation_id, completed_at
		FROM inventory_commands WHERE idempotency_key = ? FOR UPDATE
	`, [key]);
	if (rows.length !== 1) throw new Error('Inventory idempotency command was not locked');
	const row = rows[0]!;
	if (String(row['command_kind']) !== kind || !Buffer.isBuffer(row['request_hash']) || !row['request_hash'].equals(hashBuffer(hash))) {
		throw new Error(`Inventory idempotency key ${key} was already used for another command`);
	}
	const complete = row['inventory_id'] != null && row['mutation_id'] != null && row['completed_at'] != null;
	const empty = row['inventory_id'] == null && row['mutation_id'] == null && row['completed_at'] == null;
	if (!complete && !empty) throw new Error(`Inventory idempotency command ${key} has an incomplete result`);
	return row;
}

async function completedCommandResult(connection: TransferSqlConnection, command: QueryRow): Promise<WriteNativeInventoryResult | null> {
	if (command['inventory_id'] == null) return null;
	const rows = await connection.query<QueryRow[]>(`
		SELECT record.public_id, mutation.id AS mutation_id, mutation.mutation_no, mutation.state_hash,
			record.last_state_hash
		FROM inventory_records record
		JOIN inventory_mutations mutation ON mutation.id = ? AND mutation.inventory_id = record.id
		WHERE record.id = ? FOR UPDATE
	`, [command['mutation_id'], command['inventory_id']]);
	if (rows.length !== 1) throw new Error('Inventory idempotency result is missing');
	return {
		publicId: positiveSqlId(rows[0]!['public_id'], 'inventory public id'),
		mutationId: positiveSqlId(rows[0]!['mutation_id'], 'inventory mutation id'),
		mutationNo: positiveSqlId(rows[0]!['mutation_no'], 'inventory mutation number'),
		stateHash: Buffer.isBuffer(rows[0]!['state_hash']) ? rows[0]!['state_hash'].toString('hex') : '',
		alreadyCurrent: Buffer.isBuffer(rows[0]!['last_state_hash']) && Buffer.isBuffer(rows[0]!['state_hash'])
			&& rows[0]!['last_state_hash'].equals(rows[0]!['state_hash']),
		alreadyApplied: true,
	};
}

async function appendMutation(
	connection: TransferSqlConnection,
	inventoryId: number,
	operationKind: 'upsert' | 'delete',
	stateHash: string,
): Promise<{ mutationId: number; mutationNo: number }> {
	const latest = await connection.query<QueryRow[]>(`
		SELECT mutation_no FROM inventory_mutations
		WHERE inventory_id = ? ORDER BY mutation_no DESC LIMIT 1 FOR UPDATE
	`, [inventoryId]);
	const mutationNo = (latest.length ? Number(latest[0]!['mutation_no']) : 0) + 1;
	const inserted = await connection.query<SqlResult>(`
		INSERT INTO inventory_mutations (inventory_id, mutation_no, operation_kind, state_hash)
		VALUES (?, ?, ?, ?)
	`, [inventoryId, mutationNo, operationKind, hashBuffer(stateHash)]);
	return { mutationId: positiveSqlId(inserted.insertId, 'inventory mutation insert id'), mutationNo };
}

async function enqueueMirror(
	connection: TransferSqlConnection,
	inventoryId: number,
	mutationId: number,
	operationKind: 'upsert' | 'delete',
): Promise<void> {
	if (operationKind === 'upsert') {
		await connection.query(`
			UPDATE inventory_bitrix_outbox SET status = 'superseded', lease_token = NULL,
				locked_until = NULL, completed_at = CURRENT_TIMESTAMP(6), last_error = 'superseded by newer mutation'
			WHERE inventory_id = ? AND operation_kind = 'upsert' AND mutation_id < ? AND (
				status = 'pending' OR (status = 'processing' AND locked_until <= CURRENT_TIMESTAMP(6))
			)
		`, [inventoryId, mutationId]);
	}
	await connection.query(`
		INSERT INTO inventory_bitrix_outbox (inventory_id, mutation_id, operation_kind)
		VALUES (?, ?, ?)
	`, [inventoryId, mutationId, operationKind]);
}

async function completeCommand(
	connection: TransferSqlConnection,
	commandId: unknown,
	inventoryId: number,
	mutationId: number,
): Promise<void> {
	const updated = await connection.query<SqlResult>(`
		UPDATE inventory_commands SET inventory_id = ?, mutation_id = ?, completed_at = CURRENT_TIMESTAMP(6)
		WHERE id = ? AND inventory_id IS NULL AND mutation_id IS NULL AND completed_at IS NULL
	`, [inventoryId, mutationId, commandId]);
	if (Number(updated.affectedRows ?? 0) !== 1) throw new Error('Inventory idempotency command completion failed');
}

async function nativeUpsert(
	connection: TransferSqlConnection,
	input: { publicId: number; idempotencyKey: string; name: string; data: Record<string, unknown>; createdById?: string; createdAt?: string },
	kind: 'create' | 'update',
	commandHash: string,
): Promise<WriteNativeInventoryResult> {
	const command = await lockNativeCommand(connection, input.idempotencyKey, kind, commandHash);
	const completed = await completedCommandResult(connection, command);
	if (completed) {
		if (completed.publicId !== input.publicId) throw new Error(`Inventory idempotency key ${input.idempotencyKey} belongs to another document`);
		return completed;
	}
	const existing = await connection.query<QueryRow[]>(`
		SELECT id, bitrix_external_id, deleted_at FROM inventory_records WHERE public_id = ? FOR UPDATE
	`, [input.publicId]);
	if (kind === 'create' && existing.length) throw new Error(`Inventory #${input.publicId} already exists`);
	if (kind === 'update' && (existing.length !== 1 || existing[0]!['deleted_at'] != null)) throw new Error(`Inventory #${input.publicId} was not found in SQL`);
	const inventory = normalizeInventorySqlState(input);
	const bitrixExternalId = existing.length && existing[0]!['bitrix_external_id'] != null
		? positiveSqlId(existing[0]!['bitrix_external_id'], 'inventory Bitrix id')
		: null;
	const changed = await writeInventory(connection, inventory, bitrixExternalId);
	const records = await connection.query<QueryRow[]>('SELECT id FROM inventory_records WHERE public_id = ? FOR UPDATE', [input.publicId]);
	if (records.length !== 1) throw new Error(`Inventory #${input.publicId} SQL record is missing`);
	const inventoryId = positiveSqlId(records[0]!['id'], 'inventory record id');
	const mutation = await appendMutation(connection, inventoryId, 'upsert', inventory.stateHash);
	await enqueueMirror(connection, inventoryId, mutation.mutationId, 'upsert');
	await completeCommand(connection, command['id'], inventoryId, mutation.mutationId);
	return { publicId: input.publicId, ...mutation, stateHash: inventory.stateHash, alreadyCurrent: !changed, alreadyApplied: false };
}

export async function createNativeInventorySql(
	pool: TransferSqlPool,
	input: { idempotencyKey: string; name: string; data: Record<string, unknown>; createdById?: string; createdAt?: string },
): Promise<WriteNativeInventoryResult> {
	const key = nativeIdempotencyKey(input.idempotencyKey);
	const stablePoints = Array.isArray(input.data['points'])
		? input.data['points'].map((raw) => {
			const point = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
			return {
				storeId: point['storeId'], storeName: point['storeName'], responsibleId: point['responsibleId'],
				responsibleName: point['responsibleName'], status: point['status'],
			};
		})
		: [];
	const hash = requestHash({
		command: 'create', name: input.name, status: input.data['status'], deadline: input.data['deadline'],
		createdById: input.createdById ?? input.data['createdById'] ?? '', sectionIds: input.data['sectionIds'] ?? [], points: stablePoints,
	});
	return withInventorySqlWriteLock(pool, async (connection) => {
		const existingCommand = await lockNativeCommand(connection, key, 'create', hash);
		const completed = await completedCommandResult(connection, existingCommand);
		if (completed) return completed;
		const allocated = await connection.query<SqlResult>('INSERT INTO inventory_public_ids (legacy_bitrix_external_id) VALUES (NULL)');
		const publicId = positiveSqlId(allocated.insertId, 'inventory public id');
		// nativeUpsert locks the same command row and completes it in this transaction.
		return nativeUpsert(connection, { ...input, publicId, idempotencyKey: key }, 'create', hash);
	});
}

export async function updateNativeInventorySql(
	pool: TransferSqlPool,
	input: { publicId: number; idempotencyKey: string; name: string; data: Record<string, unknown>; createdById?: string; createdAt?: string },
): Promise<WriteNativeInventoryResult> {
	const publicId = positiveSqlId(input.publicId, 'inventory public id');
	const key = nativeIdempotencyKey(input.idempotencyKey);
	const inventory = normalizeInventorySqlState({ ...input, publicId });
	return withInventorySqlWriteLock(pool, (connection) => nativeUpsert(
		connection, { ...input, publicId, idempotencyKey: key }, 'update', inventory.stateHash,
	));
}

export async function deleteNativeInventorySql(
	pool: TransferSqlPool,
	input: { publicId: number; idempotencyKey: string },
): Promise<WriteNativeInventoryResult> {
	const publicId = positiveSqlId(input.publicId, 'inventory public id');
	const key = nativeIdempotencyKey(input.idempotencyKey);
	const hash = requestHash({ command: 'delete', publicId });
	return withInventorySqlWriteLock(pool, async (connection) => {
		const command = await lockNativeCommand(connection, key, 'delete', hash);
		const completed = await completedCommandResult(connection, command);
		if (completed) return completed;
		const rows = await connection.query<QueryRow[]>(`
			SELECT id, last_state_hash, deleted_at FROM inventory_records WHERE public_id = ? FOR UPDATE
		`, [publicId]);
		if (rows.length !== 1 || !Buffer.isBuffer(rows[0]!['last_state_hash'])) throw new Error(`Inventory #${publicId} was not found in SQL`);
		const inventoryId = positiveSqlId(rows[0]!['id'], 'inventory record id');
		const stateHash = rows[0]!['last_state_hash'].toString('hex');
		await connection.query('UPDATE inventory_records SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP(6)) WHERE id = ?', [inventoryId]);
		await connection.query(`
			UPDATE inventory_bitrix_outbox SET status = 'superseded', lease_token = NULL, locked_until = NULL,
				completed_at = CURRENT_TIMESTAMP(6), last_error = 'superseded by delete'
			WHERE inventory_id = ? AND operation_kind = 'upsert' AND (
				status = 'pending' OR (status = 'processing' AND locked_until <= CURRENT_TIMESTAMP(6))
			)
		`, [inventoryId]);
		const mutation = await appendMutation(connection, inventoryId, 'delete', stateHash);
		await enqueueMirror(connection, inventoryId, mutation.mutationId, 'delete');
		await completeCommand(connection, command['id'], inventoryId, mutation.mutationId);
		return { publicId, ...mutation, stateHash, alreadyCurrent: true, alreadyApplied: false };
	});
}

function mirrorLeaseToken(value: unknown): string {
	const token = bounded(value, 36, 'inventory mirror lease token').trim();
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(token)) {
		throw new Error('Invalid inventory mirror lease token');
	}
	return token;
}

export async function readPendingInventoryBitrixMirrors(pool: TransferSqlPool, limit = 20): Promise<PendingInventoryBitrixMirror[]> {
	const safeLimit = Math.min(Math.max(positiveSqlId(limit, 'inventory outbox limit'), 1), 100);
	const rows = await pool.query<QueryRow[]>(`
		SELECT record.public_id, record.bitrix_external_id, outbox.operation_kind,
			MAX(outbox.mutation_id) AS mutation_id, MAX(outbox.attempt_count) AS attempt_count
		FROM inventory_bitrix_outbox outbox
		JOIN inventory_records record ON record.id = outbox.inventory_id
		WHERE ((outbox.status = 'pending' AND outbox.available_at <= CURRENT_TIMESTAMP(6))
			OR (outbox.status = 'processing' AND outbox.locked_until <= CURRENT_TIMESTAMP(6)))
			AND ((outbox.operation_kind = 'upsert' AND record.deleted_at IS NULL) OR outbox.operation_kind = 'delete')
		GROUP BY record.id, record.public_id, record.bitrix_external_id, outbox.operation_kind
		ORDER BY MIN(outbox.id) LIMIT ${safeLimit}
	`);
	return rows.map((row) => ({
		publicId: positiveSqlId(row['public_id'], 'inventory public id'),
		bitrixExternalId: row['bitrix_external_id'] == null ? null : positiveSqlId(row['bitrix_external_id'], 'inventory Bitrix id'),
		mutationId: positiveSqlId(row['mutation_id'], 'inventory mutation id'),
		attemptCount: Number(row['attempt_count'] ?? 0),
		operationKind: String(row['operation_kind']) === 'delete' ? 'delete' : 'upsert',
	}));
}

export async function claimInventoryBitrixMirror(
	pool: TransferSqlPool,
	input: { publicId: number; mutationId: number; operationKind: 'upsert' | 'delete'; leaseToken: string },
): Promise<boolean> {
	const publicId = positiveSqlId(input.publicId, 'inventory public id');
	const mutationId = positiveSqlId(input.mutationId, 'inventory mutation id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	return withInventorySqlWriteLock(pool, async (connection) => {
		const records = await connection.query<QueryRow[]>(`
			SELECT id FROM inventory_records WHERE public_id = ? AND (? = 'delete' OR deleted_at IS NULL) FOR UPDATE
		`, [publicId, input.operationKind]);
		if (records.length !== 1) throw new Error(`Inventory #${publicId} was not found for Bitrix mirroring`);
		const inventoryId = positiveSqlId(records[0]!['id'], 'inventory record id');
		const active = await connection.query<QueryRow[]>(`
			SELECT id FROM inventory_bitrix_outbox WHERE inventory_id = ? AND status = 'processing'
				AND locked_until > CURRENT_TIMESTAMP(6) LIMIT 1 FOR UPDATE
		`, [inventoryId]);
		if (active.length) return false;
		const claimed = await connection.query<SqlResult>(`
			UPDATE inventory_bitrix_outbox SET status = 'processing', lease_token = ?,
				locked_until = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 60 SECOND)
			WHERE inventory_id = ? AND operation_kind = ? AND mutation_id <= ? AND (
				(status = 'pending' AND available_at <= CURRENT_TIMESTAMP(6))
				OR (status = 'processing' AND locked_until <= CURRENT_TIMESTAMP(6))
			)
		`, [leaseToken, inventoryId, input.operationKind, mutationId]);
		return Number(claimed.affectedRows ?? 0) > 0;
	});
}

export async function readInventoryBitrixExternalId(pool: TransferSqlPool, publicIdInput: number): Promise<number | null> {
	const publicId = positiveSqlId(publicIdInput, 'inventory public id');
	const rows = await pool.query<QueryRow[]>('SELECT bitrix_external_id FROM inventory_records WHERE public_id = ?', [publicId]);
	if (!rows.length) return null;
	if (rows.length !== 1) throw new Error(`Inventory #${publicId} identity is ambiguous`);
	return rows[0]!['bitrix_external_id'] == null ? null : positiveSqlId(rows[0]!['bitrix_external_id'], 'inventory Bitrix id');
}

export async function recordInventoryBitrixMirrorFailure(
	pool: TransferSqlPool,
	input: { publicId: number; mutationId: number; operationKind: 'upsert' | 'delete'; leaseToken: string; error: string },
): Promise<void> {
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	await pool.query(`
		UPDATE inventory_bitrix_outbox outbox
		JOIN inventory_records record ON record.id = outbox.inventory_id
		SET outbox.attempt_count = outbox.attempt_count + 1, outbox.last_attempt_at = CURRENT_TIMESTAMP(6),
			outbox.available_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL LEAST(300, POW(2, LEAST(outbox.attempt_count, 8))) SECOND),
			outbox.last_error = ?, outbox.status = 'pending', outbox.lease_token = NULL, outbox.locked_until = NULL
		WHERE record.public_id = ? AND outbox.operation_kind = ? AND outbox.status = 'processing'
			AND outbox.lease_token = ? AND outbox.mutation_id <= ?
	`, [bounded(input.error, 1000, 'inventory mirror error'), positiveSqlId(input.publicId, 'inventory public id'),
		input.operationKind, leaseToken, positiveSqlId(input.mutationId, 'inventory mutation id')]);
}

export async function markInventoryBitrixMirrorDelivered(
	pool: TransferSqlPool,
	input: { publicId: number; mutationId: number; bitrixExternalId: number; leaseToken: string },
): Promise<void> {
	const publicId = positiveSqlId(input.publicId, 'inventory public id');
	const mutationId = positiveSqlId(input.mutationId, 'inventory mutation id');
	const bitrixExternalId = positiveSqlId(input.bitrixExternalId, 'inventory Bitrix id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	await withInventorySqlWriteLock(pool, async (connection) => {
		const claims = await connection.query<QueryRow[]>(`
			SELECT outbox.id FROM inventory_bitrix_outbox outbox
			JOIN inventory_records record ON record.id = outbox.inventory_id
			WHERE record.public_id = ? AND outbox.operation_kind = 'upsert' AND outbox.status = 'processing'
				AND outbox.lease_token = ? AND outbox.mutation_id <= ? FOR UPDATE
		`, [publicId, leaseToken, mutationId]);
		if (!claims.length) return;
		const allocations = await connection.query<QueryRow[]>(`
			SELECT legacy_bitrix_external_id FROM inventory_public_ids WHERE public_id = ? FOR UPDATE
		`, [publicId]);
		if (allocations.length !== 1) throw new Error(`Inventory #${publicId} allocator row is missing`);
		const legacy = allocations[0]!['legacy_bitrix_external_id'];
		if (legacy != null && Number(legacy) !== bitrixExternalId) throw new Error(`Inventory #${publicId} already has another Bitrix mirror`);
		await connection.query('UPDATE inventory_public_ids SET legacy_bitrix_external_id = ? WHERE public_id = ?', [bitrixExternalId, publicId]);
		const records = await connection.query<QueryRow[]>('SELECT bitrix_external_id FROM inventory_records WHERE public_id = ? FOR UPDATE', [publicId]);
		if (records.length !== 1) throw new Error(`Inventory #${publicId} record is missing`);
		const current = records[0]!['bitrix_external_id'];
		if (current != null && Number(current) !== bitrixExternalId) throw new Error(`Inventory #${publicId} already points to another Bitrix mirror`);
		await connection.query('UPDATE inventory_records SET bitrix_external_id = ? WHERE public_id = ?', [bitrixExternalId, publicId]);
		await connection.query(`
			UPDATE inventory_bitrix_outbox outbox
			JOIN inventory_records record ON record.id = outbox.inventory_id
			SET outbox.status = 'delivered', outbox.attempt_count = outbox.attempt_count + 1,
				outbox.last_attempt_at = CURRENT_TIMESTAMP(6), outbox.lease_token = NULL, outbox.locked_until = NULL,
				outbox.completed_at = CURRENT_TIMESTAMP(6), outbox.last_error = ''
			WHERE record.public_id = ? AND outbox.operation_kind = 'upsert' AND outbox.status = 'processing'
				AND outbox.lease_token = ? AND outbox.mutation_id <= ?
		`, [publicId, leaseToken, mutationId]);
	});
}

export async function markInventoryBitrixDeleteDelivered(
	pool: TransferSqlPool,
	input: { publicId: number; mutationId: number; leaseToken: string },
): Promise<void> {
	await pool.query(`
		UPDATE inventory_bitrix_outbox outbox
		JOIN inventory_records record ON record.id = outbox.inventory_id
		SET outbox.status = 'delivered', outbox.attempt_count = outbox.attempt_count + 1,
			outbox.last_attempt_at = CURRENT_TIMESTAMP(6), outbox.lease_token = NULL, outbox.locked_until = NULL,
			outbox.completed_at = CURRENT_TIMESTAMP(6), outbox.last_error = ''
		WHERE record.public_id = ? AND outbox.operation_kind = 'delete' AND outbox.status = 'processing'
			AND outbox.lease_token = ? AND outbox.mutation_id <= ?
	`, [positiveSqlId(input.publicId, 'inventory public id'), mirrorLeaseToken(input.leaseToken),
		positiveSqlId(input.mutationId, 'inventory mutation id')]);
}

export async function applyInventorySqlBackfill(
	pool: TransferSqlPool,
	plan: InventorySqlBackfillPlan,
	expectedPlanHash: string,
): Promise<{ alreadyApplied: boolean; changedInventoryCount: number; unchangedInventoryCount: number }> {
	if (!plan.readyToApply || plan.issues.length) throw new Error('Inventory backfill plan is blocked');
	if (plan.planHash !== expectedPlanHash) throw new Error('Inventory backfill checkpoint does not match the approved plan');
	return withInventorySqlWriteLock(pool, async (connection) => {
		const existing = await connection.query<QueryRow[]>(`
			SELECT changed_inventory_count, unchanged_inventory_count
			FROM inventory_backfill_checkpoints
			WHERE plan_hash = ?
			FOR UPDATE
		`, [hashBuffer(plan.planHash)]);
		if (existing.length) {
			return {
				alreadyApplied: true,
				changedInventoryCount: Number(existing[0]!['changed_inventory_count']),
				unchangedInventoryCount: Number(existing[0]!['unchanged_inventory_count']),
			};
		}
		let changedInventoryCount = 0;
		let unchangedInventoryCount = 0;
		for (const inventory of plan.inventories) {
			if (await writeInventory(connection, inventory)) changedInventoryCount += 1;
			else unchangedInventoryCount += 1;
		}
		await connection.query(`
			INSERT INTO inventory_backfill_checkpoints (
				plan_hash, observed_at, source_record_count, inventory_count, point_count,
				section_count, snapshot_line_count, count_line_count, result_line_count,
				erp_document_count, changed_inventory_count, unchanged_inventory_count
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, [
			hashBuffer(plan.planHash), sqlDate(plan.observedAt), plan.sourceRecordCount,
			plan.counts.inventories, plan.counts.points, plan.counts.sections,
			plan.counts.snapshotLines, plan.counts.countLines, plan.counts.resultLines,
			plan.counts.erpDocuments, changedInventoryCount, unchangedInventoryCount,
		]);
		return { alreadyApplied: false, changedInventoryCount, unchangedInventoryCount };
	});
}
