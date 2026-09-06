import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import type { TransferSqlConnection, TransferSqlPool } from '../transfers/sql-store.js';
import type { RepairSqlBackfillPlan } from './backfill-plan.js';
import { normalizeRepairSqlRecord, type RepairSqlRecord } from './model.js';

type QueryRow = Record<string, unknown>;
type SqlResult = { affectedRows?: number; insertId?: bigint | number | string };
const REPAIR_WRITE_LOCK = 'b24_app_repair_sql_write';

function hashBuffer(value: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid repair hash');
	return Buffer.from(value, 'hex');
}

function sqlDate(value: string | null | undefined): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error(`Invalid repair SQL timestamp: ${value}`);
	return date.toISOString().replace('T', ' ').replace('Z', '');
}

function positiveId(value: unknown, name: string): number {
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid ${name}`);
	return id;
}

async function withRepairLock<T>(pool: TransferSqlPool, action: (connection: TransferSqlConnection) => Promise<T>): Promise<T> {
	const connection = await pool.getConnection();
	let locked = false;
	let transaction = false;
	try {
		const rows = await connection.query<QueryRow[]>('SELECT GET_LOCK(?, 10) AS acquired', [REPAIR_WRITE_LOCK]);
		if (Number(rows[0]?.['acquired']) !== 1) throw new Error('Could not acquire repair SQL write lock');
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
		if (locked) await connection.query('SELECT RELEASE_LOCK(?) AS released', [REPAIR_WRITE_LOCK]).catch(() => undefined);
		await connection.release();
	}
}

async function upsertRepairRecord(connection: TransferSqlConnection, record: RepairSqlRecord): Promise<boolean> {
	const before = await connection.query<QueryRow[]>('SELECT last_state_hash, deleted_at FROM repair_records WHERE id = ? FOR UPDATE', [record.id]);
	const unchanged = before.length === 1 && before[0]!['deleted_at'] == null
		&& Buffer.isBuffer(before[0]!['last_state_hash']) && before[0]!['last_state_hash'].equals(hashBuffer(record.stateHash));
	await connection.query(`
		INSERT INTO repair_records (
			id, bitrix_external_id, display_name, repair_kind, repair_status, repair_no,
			client_contact_id, client_name, client_phone, device, model, serial_no, acceptance_point,
			appearance_text, defect_text, pay_type, service_cost, customer_price, deal_id, task_id,
			refusal_at, refusal_reason, refusal_by_id, refusal_by_name, refusal_deal_cancelled, refusal_task_reframed,
			repair_item_code, repair_store, issue_store, repair_delivery_note, product_id, source_store,
			service_comment, internal_comment, source_created_at, created_by_id, created_by_name,
			last_state_hash, deleted_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
		ON DUPLICATE KEY UPDATE
			bitrix_external_id = VALUES(bitrix_external_id), display_name = VALUES(display_name), repair_kind = VALUES(repair_kind),
			repair_status = VALUES(repair_status), repair_no = VALUES(repair_no), client_contact_id = VALUES(client_contact_id),
			client_name = VALUES(client_name), client_phone = VALUES(client_phone), device = VALUES(device), model = VALUES(model),
			serial_no = VALUES(serial_no), acceptance_point = VALUES(acceptance_point), appearance_text = VALUES(appearance_text),
			defect_text = VALUES(defect_text), pay_type = VALUES(pay_type), service_cost = VALUES(service_cost),
			customer_price = VALUES(customer_price), deal_id = VALUES(deal_id), task_id = VALUES(task_id),
			refusal_at = VALUES(refusal_at), refusal_reason = VALUES(refusal_reason), refusal_by_id = VALUES(refusal_by_id),
			refusal_by_name = VALUES(refusal_by_name), refusal_deal_cancelled = VALUES(refusal_deal_cancelled),
			refusal_task_reframed = VALUES(refusal_task_reframed), repair_item_code = VALUES(repair_item_code),
			repair_store = VALUES(repair_store), issue_store = VALUES(issue_store), repair_delivery_note = VALUES(repair_delivery_note),
			product_id = VALUES(product_id), source_store = VALUES(source_store), service_comment = VALUES(service_comment),
			internal_comment = VALUES(internal_comment), source_created_at = VALUES(source_created_at),
			created_by_id = VALUES(created_by_id), created_by_name = VALUES(created_by_name),
			last_state_hash = VALUES(last_state_hash), deleted_at = NULL
	`, [
		record.id, record.bitrixExternalId, record.name, record.kind, record.status, record.repairNo,
		record.client.contactId, record.client.name, record.client.phone, record.device, record.model, record.serial, record.point,
		record.appearance, record.defect, record.payType, record.cost, record.ourPrice, record.dealId, record.taskId,
		sqlDate(record.clientRefusal?.at), record.clientRefusal?.reason ?? null, record.clientRefusal?.byId ?? null,
		record.clientRefusal?.byName ?? null, record.clientRefusal?.dealCancelled ?? false, record.clientRefusal?.taskReframed ?? false,
		record.repairItemCode, record.repairStore, record.issueStore, record.repairDeliveryNote, record.productId, record.sourceStore,
		record.comment, record.internalComment, sqlDate(record.createdAt), record.createdById, record.createdByName,
		hashBuffer(record.stateHash),
	]);

	await connection.query('UPDATE repair_history SET is_present = 0 WHERE repair_id = ?', [record.id]);
	if (record.history.length) await connection.batch(`
		INSERT INTO repair_history (repair_id, ordinal, happened_at, repair_status, actor_id, actor_name, note, is_present)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1)
		ON DUPLICATE KEY UPDATE happened_at = VALUES(happened_at), repair_status = VALUES(repair_status),
			actor_id = VALUES(actor_id), actor_name = VALUES(actor_name), note = VALUES(note), is_present = 1
	`, record.history.map((row, index) => [record.id, index + 1, sqlDate(row.at), row.status, row.byId, row.byName ?? '', row.note ?? null]));

	await connection.query('UPDATE repair_media SET is_present = 0 WHERE repair_id = ?', [record.id]);
	const media = [
		...record.photos.map((row, index) => [record.id, 'photo', index + 1, row.id, row.name, row.url, '']),
		...record.files.map((row, index) => [record.id, 'file', index + 1, row.id, row.name, row.url, row.type]),
	];
	if (media.length) await connection.batch(`
		INSERT INTO repair_media (repair_id, media_kind, ordinal, bitrix_file_id, display_name, media_url, media_type, is_present)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1)
		ON DUPLICATE KEY UPDATE bitrix_file_id = VALUES(bitrix_file_id), display_name = VALUES(display_name),
			media_url = VALUES(media_url), media_type = VALUES(media_type), is_present = 1
	`, media);
	return !unchanged;
}

async function ensureRepairIdentity(connection: TransferSqlConnection, record: RepairSqlRecord): Promise<void> {
	await connection.query(`
		INSERT IGNORE INTO repair_identities (public_id, repair_no, bitrix_external_id, consumed_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP(6))
	`, [record.id, record.repairNo, record.bitrixExternalId]);
	const rows = await connection.query<QueryRow[]>(`
		SELECT public_id, repair_no, bitrix_external_id FROM repair_identities
		WHERE public_id = ? OR repair_no = ? OR (? IS NOT NULL AND bitrix_external_id = ?)
		FOR UPDATE
	`, [record.id, record.repairNo, record.bitrixExternalId, record.bitrixExternalId]);
	if (rows.length !== 1
		|| Number(rows[0]!['public_id']) !== record.id
		|| Number(rows[0]!['repair_no']) !== record.repairNo
		|| (record.bitrixExternalId != null && Number(rows[0]!['bitrix_external_id']) !== record.bitrixExternalId)) {
		throw new Error(`Repair ${record.id}/${record.repairNo} conflicts with the SQL identity allocator`);
	}
}

export async function applyRepairSqlBackfill(
	pool: TransferSqlPool,
	plan: RepairSqlBackfillPlan,
	expectedHash: string,
): Promise<{ alreadyApplied: boolean; changedRecordCount: number; unchangedRecordCount: number }> {
	if (!plan.readyToApply) throw new Error('Repair SQL backfill plan is blocked');
	if (plan.planHash !== expectedHash) throw new Error('Repair SQL backfill plan hash changed');
	return withRepairLock(pool, async (connection) => {
		const checkpoint = await connection.query<QueryRow[]>('SELECT id FROM repair_backfill_checkpoints WHERE plan_hash = ? FOR UPDATE', [hashBuffer(plan.planHash)]);
		if (checkpoint.length) return { alreadyApplied: true, changedRecordCount: 0, unchangedRecordCount: plan.records.length };
		await connection.query('UPDATE repair_records SET deleted_at = ? WHERE bitrix_external_id IS NOT NULL AND deleted_at IS NULL', [sqlDate(plan.observedAt)]);
		let changedRecordCount = 0;
		for (const record of plan.records) {
			await ensureRepairIdentity(connection, record);
			if (await upsertRepairRecord(connection, record)) changedRecordCount += 1;
		}
		const unchangedRecordCount = plan.records.length - changedRecordCount;
		const result = await connection.query<SqlResult>(`
			INSERT INTO repair_backfill_checkpoints (
				observed_at, source_record_count, normalized_record_count, history_row_count, media_row_count, plan_hash
			) VALUES (?, ?, ?, ?, ?, ?)
		`, [sqlDate(plan.observedAt), plan.sourceRecordCount, plan.counts.records, plan.counts.history, plan.counts.media, hashBuffer(plan.planHash)]);
		positiveId(result.insertId, 'repair backfill checkpoint id');
		return { alreadyApplied: false, changedRecordCount, unchangedRecordCount };
	});
}

export async function writeRepairSqlRecord(
	pool: TransferSqlPool,
	record: RepairSqlRecord,
): Promise<{ changed: boolean }> {
	return withRepairLock(pool, async (connection) => {
		await ensureRepairIdentity(connection, record);
		return { changed: await upsertRepairRecord(connection, record) };
	});
}

export async function markRepairSqlDeleted(
	pool: TransferSqlPool,
	input: { externalId: number; deletedAt?: Date },
): Promise<{ alreadyDeleted: boolean }> {
	const externalId = positiveId(input.externalId, 'repair Bitrix external id');
	return withRepairLock(pool, async (connection) => {
		const rows = await connection.query<QueryRow[]>(`
			SELECT id, deleted_at FROM repair_records
			WHERE bitrix_external_id = ? FOR UPDATE
		`, [externalId]);
		if (rows.length !== 1) throw new Error(`Repair ${externalId} SQL row is missing or duplicated`);
		if (rows[0]!['deleted_at'] != null) return { alreadyDeleted: true };
		const updated = await connection.query<SqlResult>(`
			UPDATE repair_records SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL
		`, [sqlDate((input.deletedAt ?? new Date()).toISOString()), positiveId(rows[0]!['id'], 'repair id')]);
		if (Number(updated.affectedRows ?? 0) !== 1) throw new Error(`Repair ${externalId} SQL tombstone failed`);
		return { alreadyDeleted: false };
	});
}

export interface ReservedRepairIdentity {
	publicId: number;
	repairNo: number;
	requestHash: string;
	alreadyAllocated: boolean;
	alreadyConsumed: boolean;
}

export interface WriteNativeRepairResult {
	publicId: number;
	repairNo: number;
	mutationId: number;
	mutationNo: number;
	stateHash: string;
	alreadyCurrent: boolean;
	alreadyApplied: boolean;
}

export interface PendingRepairBitrixMirror {
	publicId: number;
	bitrixExternalId: number | null;
	mutationId: number;
	attemptCount: number;
	operationKind: 'upsert' | 'delete';
}

type NativeRepairCommandKind = 'create' | 'update' | 'delete';

function bounded(value: unknown, max: number, name: string): string {
	const result = String(value ?? '');
	if (result.length > max) throw new Error(`${name} exceeds ${max} characters`);
	return result;
}

function nativeIdempotencyKey(value: unknown): string {
	const key = bounded(value, 191, 'repair idempotency key').trim();
	if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new Error('Invalid repair idempotency key');
	return key;
}

function requestHash(value: unknown): string {
	return createHash('sha256').update(supplyMirrorCanonicalJson(value)).digest('hex');
}

export async function reserveNativeRepairIdentity(
	pool: TransferSqlPool,
	input: { idempotencyKey: string; request: unknown },
): Promise<ReservedRepairIdentity> {
	const key = nativeIdempotencyKey(input.idempotencyKey);
	const hash = requestHash(input.request);
	return withRepairLock(pool, async (connection) => {
		const existing = await connection.query<QueryRow[]>(`
			SELECT public_id, repair_no, request_hash, consumed_at FROM repair_identities
			WHERE idempotency_key = ? FOR UPDATE
		`, [key]);
		if (existing.length) {
			if (existing.length !== 1 || !Buffer.isBuffer(existing[0]!['request_hash']) || !existing[0]!['request_hash'].equals(hashBuffer(hash))) {
				throw new Error(`Repair idempotency key ${key} was already used for another creation`);
			}
			return {
				publicId: positiveId(existing[0]!['public_id'], 'repair public id'),
				repairNo: positiveId(existing[0]!['repair_no'], 'repair number'),
				requestHash: hash,
				alreadyAllocated: true,
				alreadyConsumed: existing[0]!['consumed_at'] != null,
			};
		}
		const maximum = await connection.query<QueryRow[]>('SELECT COALESCE(MAX(repair_no), 99) AS maximum FROM repair_identities FOR UPDATE');
		const repairNo = Math.max(99, Number(maximum[0]?.['maximum'] ?? 99)) + 1;
		const inserted = await connection.query<SqlResult>(`
			INSERT INTO repair_identities (repair_no, idempotency_key, request_hash)
			VALUES (?, ?, ?)
		`, [repairNo, key, hashBuffer(hash)]);
		return {
			publicId: positiveId(inserted.insertId, 'repair public id'), repairNo, requestHash: hash, alreadyAllocated: false, alreadyConsumed: false,
		};
	});
}

async function lockNativeCommand(
	connection: TransferSqlConnection,
	key: string,
	kind: NativeRepairCommandKind,
	hash: string,
): Promise<QueryRow> {
	await connection.query(`
		INSERT IGNORE INTO repair_commands (idempotency_key, command_kind, request_hash)
		VALUES (?, ?, ?)
	`, [key, kind, hashBuffer(hash)]);
	const rows = await connection.query<QueryRow[]>(`
		SELECT id, command_kind, request_hash, repair_id, mutation_id, completed_at
		FROM repair_commands WHERE idempotency_key = ? FOR UPDATE
	`, [key]);
	if (rows.length !== 1) throw new Error('Repair idempotency command was not locked');
	const row = rows[0]!;
	if (String(row['command_kind']) !== kind || !Buffer.isBuffer(row['request_hash']) || !row['request_hash'].equals(hashBuffer(hash))) {
		throw new Error(`Repair idempotency key ${key} was already used for another command`);
	}
	const complete = row['repair_id'] != null && row['mutation_id'] != null && row['completed_at'] != null;
	const empty = row['repair_id'] == null && row['mutation_id'] == null && row['completed_at'] == null;
	if (!complete && !empty) throw new Error(`Repair idempotency command ${key} has an incomplete result`);
	return row;
}

async function completedCommandResult(connection: TransferSqlConnection, command: QueryRow): Promise<WriteNativeRepairResult | null> {
	if (command['repair_id'] == null) return null;
	const rows = await connection.query<QueryRow[]>(`
		SELECT record.id, record.repair_no, record.last_state_hash, mutation.id AS mutation_id,
			mutation.mutation_no, mutation.state_hash
		FROM repair_records record
		JOIN repair_mutations mutation ON mutation.id = ? AND mutation.repair_id = record.id
		WHERE record.id = ?
	`, [command['mutation_id'], command['repair_id']]);
	if (rows.length !== 1) throw new Error('Completed repair command points to a missing result');
	return {
		publicId: positiveId(rows[0]!['id'], 'repair public id'),
		repairNo: positiveId(rows[0]!['repair_no'], 'repair number'),
		mutationId: positiveId(rows[0]!['mutation_id'], 'repair mutation id'),
		mutationNo: positiveId(rows[0]!['mutation_no'], 'repair mutation number'),
		stateHash: Buffer.isBuffer(rows[0]!['state_hash']) ? rows[0]!['state_hash'].toString('hex') : '',
		alreadyCurrent: Buffer.isBuffer(rows[0]!['last_state_hash']) && Buffer.isBuffer(rows[0]!['state_hash'])
			&& rows[0]!['last_state_hash'].equals(rows[0]!['state_hash']),
		alreadyApplied: true,
	};
}

async function appendMutation(
	connection: TransferSqlConnection,
	repairId: number,
	operationKind: 'upsert' | 'delete',
	stateHash: string,
): Promise<{ mutationId: number; mutationNo: number }> {
	const rows = await connection.query<QueryRow[]>('SELECT mutation_no FROM repair_records WHERE id = ? FOR UPDATE', [repairId]);
	if (rows.length !== 1) throw new Error(`Repair #${repairId} was not found for mutation`);
	const mutationNo = Number(rows[0]!['mutation_no'] ?? 0) + 1;
	const inserted = await connection.query<SqlResult>(`
		INSERT INTO repair_mutations (repair_id, mutation_no, operation_kind, state_hash)
		VALUES (?, ?, ?, ?)
	`, [repairId, mutationNo, operationKind, hashBuffer(stateHash)]);
	await connection.query('UPDATE repair_records SET mutation_no = ? WHERE id = ?', [mutationNo, repairId]);
	return { mutationId: positiveId(inserted.insertId, 'repair mutation id'), mutationNo };
}

async function enqueueMirror(connection: TransferSqlConnection, repairId: number, mutationId: number, operationKind: 'upsert' | 'delete'): Promise<void> {
	if (operationKind === 'upsert') await connection.query(`
		UPDATE repair_bitrix_outbox SET status = 'superseded', lease_token = NULL, locked_until = NULL,
			completed_at = CURRENT_TIMESTAMP(6), last_error = 'superseded by newer mutation'
		WHERE repair_id = ? AND operation_kind = 'upsert' AND mutation_id < ? AND (
			status = 'pending' OR (status = 'processing' AND locked_until <= CURRENT_TIMESTAMP(6))
		)
	`, [repairId, mutationId]);
	await connection.query(`
		INSERT INTO repair_bitrix_outbox (repair_id, mutation_id, operation_kind) VALUES (?, ?, ?)
	`, [repairId, mutationId, operationKind]);
}

async function completeCommand(connection: TransferSqlConnection, commandId: unknown, repairId: number, mutationId: number): Promise<void> {
	const updated = await connection.query<SqlResult>(`
		UPDATE repair_commands SET repair_id = ?, mutation_id = ?, completed_at = CURRENT_TIMESTAMP(6)
		WHERE id = ? AND repair_id IS NULL AND mutation_id IS NULL AND completed_at IS NULL
	`, [repairId, mutationId, commandId]);
	if (Number(updated.affectedRows ?? 0) !== 1) throw new Error('Repair idempotency command completion failed');
}

export async function createNativeRepairSql(
	pool: TransferSqlPool,
	input: { publicId: number; repairNo: number; idempotencyKey: string; requestHash: string; name: string; data: Record<string, unknown> },
): Promise<WriteNativeRepairResult> {
	const publicId = positiveId(input.publicId, 'repair public id');
	const repairNo = positiveId(input.repairNo, 'repair number');
	const key = nativeIdempotencyKey(input.idempotencyKey);
	if (!/^[a-f0-9]{64}$/.test(input.requestHash)) throw new Error('Invalid repair creation request hash');
	return withRepairLock(pool, async (connection) => {
		const identity = await connection.query<QueryRow[]>(`
			SELECT public_id, repair_no, request_hash, consumed_at FROM repair_identities
			WHERE idempotency_key = ? FOR UPDATE
		`, [key]);
		if (identity.length !== 1 || Number(identity[0]!['public_id']) !== publicId || Number(identity[0]!['repair_no']) !== repairNo
			|| !Buffer.isBuffer(identity[0]!['request_hash']) || !identity[0]!['request_hash'].equals(hashBuffer(input.requestHash))) {
			throw new Error('Repair creation identity does not match its reservation');
		}
		const command = await lockNativeCommand(connection, key, 'create', input.requestHash);
		const completed = await completedCommandResult(connection, command);
		if (completed) return completed;
		const existing = await connection.query<QueryRow[]>('SELECT id FROM repair_records WHERE id = ? FOR UPDATE', [publicId]);
		if (existing.length) throw new Error(`Repair #${publicId} already exists without a completed creation command`);
		const normalized = normalizeRepairSqlRecord({ id: publicId, bitrixExternalId: null, name: input.name, data: { ...input.data, repairNo } });
		if (!normalized.record || normalized.issues.length) throw new Error(`Repair SQL normalization blocked: ${normalized.issues.slice(0, 5).map((issue) => `${issue.code}:${issue.identity}`).join(', ')}`);
		await upsertRepairRecord(connection, normalized.record);
		await connection.query('UPDATE repair_identities SET consumed_at = CURRENT_TIMESTAMP(6) WHERE public_id = ?', [publicId]);
		const mutation = await appendMutation(connection, publicId, 'upsert', normalized.record.stateHash);
		await enqueueMirror(connection, publicId, mutation.mutationId, 'upsert');
		await completeCommand(connection, command['id'], publicId, mutation.mutationId);
		return { publicId, repairNo, ...mutation, stateHash: normalized.record.stateHash, alreadyCurrent: false, alreadyApplied: false };
	});
}

export async function updateNativeRepairSql(
	pool: TransferSqlPool,
	input: { publicId: number; idempotencyKey: string; name: string; data: Record<string, unknown> },
): Promise<WriteNativeRepairResult> {
	const publicId = positiveId(input.publicId, 'repair public id');
	const key = nativeIdempotencyKey(input.idempotencyKey);
	return withRepairLock(pool, async (connection) => {
		const existing = await connection.query<QueryRow[]>('SELECT bitrix_external_id, repair_no, deleted_at FROM repair_records WHERE id = ? FOR UPDATE', [publicId]);
		if (existing.length !== 1 || existing[0]!['deleted_at'] != null) throw new Error(`Repair #${publicId} was not found in SQL`);
		const normalized = normalizeRepairSqlRecord({
			id: publicId,
			bitrixExternalId: existing[0]!['bitrix_external_id'] == null ? null : positiveId(existing[0]!['bitrix_external_id'], 'repair Bitrix id'),
			name: input.name,
			data: { ...input.data, repairNo: positiveId(existing[0]!['repair_no'], 'repair number') },
		});
		if (!normalized.record || normalized.issues.length) throw new Error(`Repair SQL normalization blocked: ${normalized.issues.slice(0, 5).map((issue) => `${issue.code}:${issue.identity}`).join(', ')}`);
		const command = await lockNativeCommand(connection, key, 'update', normalized.record.stateHash);
		const completed = await completedCommandResult(connection, command);
		if (completed) {
			if (completed.publicId !== publicId) throw new Error(`Repair idempotency key ${key} belongs to another record`);
			return completed;
		}
		const changed = await upsertRepairRecord(connection, normalized.record);
		const mutation = await appendMutation(connection, publicId, 'upsert', normalized.record.stateHash);
		await enqueueMirror(connection, publicId, mutation.mutationId, 'upsert');
		await completeCommand(connection, command['id'], publicId, mutation.mutationId);
		return { publicId, repairNo: normalized.record.repairNo, ...mutation, stateHash: normalized.record.stateHash, alreadyCurrent: !changed, alreadyApplied: false };
	});
}

export async function deleteNativeRepairSql(
	pool: TransferSqlPool,
	input: { publicId: number; idempotencyKey: string },
): Promise<WriteNativeRepairResult> {
	const publicId = positiveId(input.publicId, 'repair public id');
	const key = nativeIdempotencyKey(input.idempotencyKey);
	const hash = requestHash({ command: 'delete', publicId });
	return withRepairLock(pool, async (connection) => {
		const command = await lockNativeCommand(connection, key, 'delete', hash);
		const completed = await completedCommandResult(connection, command);
		if (completed) return completed;
		const rows = await connection.query<QueryRow[]>('SELECT repair_no, last_state_hash, deleted_at FROM repair_records WHERE id = ? FOR UPDATE', [publicId]);
		if (rows.length !== 1 || !Buffer.isBuffer(rows[0]!['last_state_hash'])) throw new Error(`Repair #${publicId} was not found in SQL`);
		const stateHash = rows[0]!['last_state_hash'].toString('hex');
		await connection.query('UPDATE repair_records SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP(6)) WHERE id = ?', [publicId]);
		await connection.query(`
			UPDATE repair_bitrix_outbox SET status = 'superseded', lease_token = NULL, locked_until = NULL,
				completed_at = CURRENT_TIMESTAMP(6), last_error = 'superseded by delete'
			WHERE repair_id = ? AND operation_kind = 'upsert' AND (
				status = 'pending' OR (status = 'processing' AND locked_until <= CURRENT_TIMESTAMP(6))
			)
		`, [publicId]);
		const mutation = await appendMutation(connection, publicId, 'delete', stateHash);
		await enqueueMirror(connection, publicId, mutation.mutationId, 'delete');
		await completeCommand(connection, command['id'], publicId, mutation.mutationId);
		return { publicId, repairNo: positiveId(rows[0]!['repair_no'], 'repair number'), ...mutation, stateHash, alreadyCurrent: true, alreadyApplied: false };
	});
}

function mirrorLeaseToken(value: unknown): string {
	const token = bounded(value, 36, 'repair mirror lease token').trim();
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(token)) throw new Error('Invalid repair mirror lease token');
	return token;
}

export async function readPendingRepairBitrixMirrors(pool: TransferSqlPool, limit = 20): Promise<PendingRepairBitrixMirror[]> {
	const safeLimit = Math.min(Math.max(positiveId(limit, 'repair outbox limit'), 1), 100);
	const rows = await pool.query<QueryRow[]>(`
		SELECT record.id, record.bitrix_external_id, outbox.operation_kind,
			MAX(outbox.mutation_id) AS mutation_id, MAX(outbox.attempt_count) AS attempt_count
		FROM repair_bitrix_outbox outbox
		JOIN repair_records record ON record.id = outbox.repair_id
		WHERE ((outbox.status = 'pending' AND outbox.available_at <= CURRENT_TIMESTAMP(6))
			OR (outbox.status = 'processing' AND outbox.locked_until <= CURRENT_TIMESTAMP(6)))
			AND ((outbox.operation_kind = 'upsert' AND record.deleted_at IS NULL) OR outbox.operation_kind = 'delete')
		GROUP BY record.id, record.bitrix_external_id, outbox.operation_kind
		ORDER BY MIN(outbox.id) LIMIT ${safeLimit}
	`);
	return rows.map((row) => ({
		publicId: positiveId(row['id'], 'repair public id'),
		bitrixExternalId: row['bitrix_external_id'] == null ? null : positiveId(row['bitrix_external_id'], 'repair Bitrix id'),
		mutationId: positiveId(row['mutation_id'], 'repair mutation id'), attemptCount: Number(row['attempt_count'] ?? 0),
		operationKind: String(row['operation_kind']) === 'delete' ? 'delete' : 'upsert',
	}));
}

export async function claimRepairBitrixMirror(
	pool: TransferSqlPool,
	input: { publicId: number; mutationId: number; operationKind: 'upsert' | 'delete'; leaseToken: string },
): Promise<boolean> {
	const publicId = positiveId(input.publicId, 'repair public id');
	const mutationId = positiveId(input.mutationId, 'repair mutation id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	return withRepairLock(pool, async (connection) => {
		const records = await connection.query<QueryRow[]>('SELECT id FROM repair_records WHERE id = ? AND (? = \'delete\' OR deleted_at IS NULL) FOR UPDATE', [publicId, input.operationKind]);
		if (records.length !== 1) throw new Error(`Repair #${publicId} was not found for Bitrix mirroring`);
		const active = await connection.query<QueryRow[]>('SELECT id FROM repair_bitrix_outbox WHERE repair_id = ? AND status = \'processing\' AND locked_until > CURRENT_TIMESTAMP(6) LIMIT 1 FOR UPDATE', [publicId]);
		if (active.length) return false;
		const claimed = await connection.query<SqlResult>(`
			UPDATE repair_bitrix_outbox SET status = 'processing', lease_token = ?, locked_until = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 60 SECOND)
			WHERE repair_id = ? AND operation_kind = ? AND mutation_id <= ? AND (
				(status = 'pending' AND available_at <= CURRENT_TIMESTAMP(6)) OR (status = 'processing' AND locked_until <= CURRENT_TIMESTAMP(6))
			)
		`, [leaseToken, publicId, input.operationKind, mutationId]);
		return Number(claimed.affectedRows ?? 0) > 0;
	});
}

export async function readRepairBitrixExternalId(pool: TransferSqlPool, publicIdInput: number): Promise<number | null> {
	const publicId = positiveId(publicIdInput, 'repair public id');
	const rows = await pool.query<QueryRow[]>('SELECT bitrix_external_id FROM repair_records WHERE id = ?', [publicId]);
	if (rows.length !== 1) return null;
	return rows[0]!['bitrix_external_id'] == null ? null : positiveId(rows[0]!['bitrix_external_id'], 'repair Bitrix id');
}

export async function markRepairBitrixMirrorDelivered(
	pool: TransferSqlPool,
	input: { publicId: number; mutationId: number; bitrixExternalId: number; leaseToken: string },
): Promise<void> {
	const publicId = positiveId(input.publicId, 'repair public id');
	const mutationId = positiveId(input.mutationId, 'repair mutation id');
	const bitrixExternalId = positiveId(input.bitrixExternalId, 'repair Bitrix id');
	const leaseToken = mirrorLeaseToken(input.leaseToken);
	await withRepairLock(pool, async (connection) => {
		const claims = await connection.query<QueryRow[]>(`
			SELECT id FROM repair_bitrix_outbox WHERE repair_id = ? AND operation_kind = 'upsert'
				AND status = 'processing' AND lease_token = ? AND mutation_id <= ? FOR UPDATE
		`, [publicId, leaseToken, mutationId]);
		if (!claims.length) return;
		const identity = await connection.query<QueryRow[]>('SELECT bitrix_external_id FROM repair_identities WHERE public_id = ? FOR UPDATE', [publicId]);
		if (identity.length !== 1 || (identity[0]!['bitrix_external_id'] != null && Number(identity[0]!['bitrix_external_id']) !== bitrixExternalId)) throw new Error(`Repair #${publicId} has another Bitrix mirror`);
		await connection.query('UPDATE repair_identities SET bitrix_external_id = ? WHERE public_id = ?', [bitrixExternalId, publicId]);
		await connection.query('UPDATE repair_records SET bitrix_external_id = ? WHERE id = ? AND (bitrix_external_id IS NULL OR bitrix_external_id = ?)', [bitrixExternalId, publicId, bitrixExternalId]);
		await connection.query(`
			UPDATE repair_bitrix_outbox SET status = 'delivered', attempt_count = attempt_count + 1,
				last_attempt_at = CURRENT_TIMESTAMP(6), lease_token = NULL, locked_until = NULL,
				completed_at = CURRENT_TIMESTAMP(6), last_error = ''
			WHERE repair_id = ? AND operation_kind = 'upsert' AND status = 'processing' AND lease_token = ? AND mutation_id <= ?
		`, [publicId, leaseToken, mutationId]);
	});
}

export async function markRepairBitrixDeleteDelivered(
	pool: TransferSqlPool,
	input: { publicId: number; mutationId: number; leaseToken: string },
): Promise<void> {
	await pool.query(`
		UPDATE repair_bitrix_outbox SET status = 'delivered', attempt_count = attempt_count + 1,
			last_attempt_at = CURRENT_TIMESTAMP(6), lease_token = NULL, locked_until = NULL,
			completed_at = CURRENT_TIMESTAMP(6), last_error = ''
		WHERE repair_id = ? AND operation_kind = 'delete' AND status = 'processing' AND lease_token = ? AND mutation_id <= ?
	`, [positiveId(input.publicId, 'repair public id'), mirrorLeaseToken(input.leaseToken), positiveId(input.mutationId, 'repair mutation id')]);
}

export async function recordRepairBitrixMirrorFailure(
	pool: TransferSqlPool,
	input: { publicId: number; mutationId: number; operationKind: 'upsert' | 'delete'; leaseToken: string; error: string },
): Promise<void> {
	await pool.query(`
		UPDATE repair_bitrix_outbox SET attempt_count = attempt_count + 1, last_attempt_at = CURRENT_TIMESTAMP(6),
			available_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL LEAST(300, POW(2, LEAST(attempt_count, 8))) SECOND),
			last_error = ?, status = 'pending', lease_token = NULL, locked_until = NULL
		WHERE repair_id = ? AND operation_kind = ? AND status = 'processing' AND lease_token = ? AND mutation_id <= ?
	`, [bounded(input.error, 1000, 'repair mirror error'), positiveId(input.publicId, 'repair public id'), input.operationKind,
		mirrorLeaseToken(input.leaseToken), positiveId(input.mutationId, 'repair mutation id')]);
}
