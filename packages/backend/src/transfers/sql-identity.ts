import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import type { TransferSqlConnection, TransferSqlPool } from './sql-store.js';

const IDENTITY_BACKFILL_LOCK = 'b24_app_stock_transfer_identity_backfill';

type QueryRow = Record<string, unknown>;
type SqlResult = { affectedRows?: number };

export interface TransferIdentityRow {
	recordId: number;
	bitrixExternalId: number;
	publicId: number | null;
}

export interface TransferIdentityTarget {
	recordId: number;
	bitrixExternalId: number;
	publicId: number;
}

export interface TransferIdentityIssue {
	code: 'invalid_observed_at' | 'invalid_record' | 'duplicate_record_id' | 'duplicate_bitrix_id' | 'public_id_conflict';
	identity: string;
	message: string;
}

export interface TransferIdentityBackfillPlan {
	readyToApply: boolean;
	observedAt: string;
	sourceRecordCount: number;
	assignedRecordCount: number;
	targets: TransferIdentityTarget[];
	planHash: string;
	issues: TransferIdentityIssue[];
}

export interface TransferIdentityBackfillResult {
	planHash: string;
	alreadyApplied: boolean;
	sourceRecordCount: number;
	assignedRecordCount: number;
}

function positiveSafeInteger(value: unknown, field: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${field}`);
	return parsed;
}

function canonicalObservedAt(value: string): string {
	const date = new Date(value);
	if (!value.trim() || !Number.isFinite(date.getTime())) throw new Error('Invalid transfer identity observedAt');
	return date.toISOString();
}

function hashBuffer(hash: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid transfer identity plan hash');
	return Buffer.from(hash, 'hex');
}

export function buildTransferIdentityBackfillPlan(
	rows: TransferIdentityRow[],
	observedAt: string,
): TransferIdentityBackfillPlan {
	const issues: TransferIdentityIssue[] = [];
	let canonicalAt = observedAt;
	try { canonicalAt = canonicalObservedAt(observedAt); }
	catch (error) {
		issues.push({
			code: 'invalid_observed_at', identity: 'stock_transfer_records',
			message: error instanceof Error ? error.message : String(error),
		});
	}
	const targets: TransferIdentityTarget[] = [];
	const recordIds = new Set<number>();
	const bitrixIds = new Set<number>();
	for (const row of rows) {
		try {
			const recordId = positiveSafeInteger(row.recordId, 'transfer record id');
			const bitrixExternalId = positiveSafeInteger(row.bitrixExternalId, 'transfer Bitrix external id');
			const publicId = row.publicId == null ? null : positiveSafeInteger(row.publicId, 'transfer public id');
			if (recordIds.has(recordId)) issues.push({
				code: 'duplicate_record_id', identity: String(recordId), message: 'Transfer record id is duplicated',
			});
			if (bitrixIds.has(bitrixExternalId)) issues.push({
				code: 'duplicate_bitrix_id', identity: String(bitrixExternalId), message: 'Bitrix transfer id is duplicated',
			});
			recordIds.add(recordId);
			bitrixIds.add(bitrixExternalId);
			if (publicId != null && publicId !== bitrixExternalId) issues.push({
				code: 'public_id_conflict', identity: String(recordId),
				message: `Existing public id ${publicId} differs from legacy Bitrix id ${bitrixExternalId}`,
			});
			targets.push({ recordId, bitrixExternalId, publicId: bitrixExternalId });
		} catch (error) {
			issues.push({
				code: 'invalid_record', identity: String(row.recordId),
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	targets.sort((left, right) => left.publicId - right.publicId || left.recordId - right.recordId);
	issues.sort((left, right) => `${left.code}:${left.identity}`.localeCompare(`${right.code}:${right.identity}`, 'en'));
	const planHash = createHash('sha256').update(supplyMirrorCanonicalJson({
		formatVersion: 1,
		targets,
	})).digest('hex');
	return {
		readyToApply: issues.length === 0,
		observedAt: canonicalAt,
		sourceRecordCount: rows.length,
		assignedRecordCount: rows.filter((row) => row.publicId == null).length,
		targets,
		planHash,
		issues,
	};
}

export async function readTransferIdentityRows(
	pool: Pick<TransferSqlPool, 'query'> | Pick<TransferSqlConnection, 'query'>,
	forUpdate = false,
): Promise<TransferIdentityRow[]> {
	const rows = await pool.query<QueryRow[]>(`
		SELECT id, bitrix_external_id, public_id
		FROM stock_transfer_records
		ORDER BY bitrix_external_id
		${forUpdate ? 'FOR UPDATE' : ''}
	`);
	return rows.map((row) => ({
		recordId: positiveSafeInteger(row['id'], 'transfer record id'),
		bitrixExternalId: positiveSafeInteger(row['bitrix_external_id'], 'transfer Bitrix external id'),
		publicId: row['public_id'] == null ? null : positiveSafeInteger(row['public_id'], 'transfer public id'),
	}));
}

function sameTargets(left: TransferIdentityTarget[], right: TransferIdentityTarget[]): boolean {
	return left.length === right.length && left.every((target, index) => {
		const other = right[index];
		return other?.recordId === target.recordId
			&& other.bitrixExternalId === target.bitrixExternalId
			&& other.publicId === target.publicId;
	});
}

async function validateAllocatorRows(connection: TransferSqlConnection, targets: TransferIdentityTarget[]): Promise<Set<number>> {
	const rows = await connection.query<QueryRow[]>(`
		SELECT public_id, legacy_bitrix_external_id
		FROM stock_transfer_public_ids
		FOR UPDATE
	`);
	const present = new Set<number>();
	const byLegacy = new Map<number, number>();
	for (const row of rows) {
		const publicId = positiveSafeInteger(row['public_id'], 'allocated transfer public id');
		const legacyId = row['legacy_bitrix_external_id'] == null
			? null
			: positiveSafeInteger(row['legacy_bitrix_external_id'], 'allocated transfer legacy id');
		present.add(publicId);
		if (legacyId != null) byLegacy.set(legacyId, publicId);
	}
	for (const target of targets) {
		const existingPublic = byLegacy.get(target.bitrixExternalId);
		if (existingPublic != null && existingPublic !== target.publicId) {
			throw new Error(`Legacy Bitrix id ${target.bitrixExternalId} is allocated as public id ${existingPublic}`);
		}
		if (present.has(target.publicId) && existingPublic == null) {
			throw new Error(`Public transfer id ${target.publicId} is already allocated to another document`);
		}
	}
	return present;
}

export async function applyTransferIdentityBackfill(
	pool: TransferSqlPool,
	plan: TransferIdentityBackfillPlan,
	expectedPlanHash: string,
): Promise<TransferIdentityBackfillResult> {
	if (!plan.readyToApply || plan.issues.length) throw new Error('Transfer identity backfill plan is not ready to apply');
	if (plan.planHash !== expectedPlanHash) throw new Error('Transfer identity checkpoint does not match the approved plan');
	const connection = await pool.getConnection();
	let locked = false;
	let transaction = false;
	try {
		const lockRows = await connection.query<QueryRow[]>('SELECT GET_LOCK(?, 10) AS acquired', [IDENTITY_BACKFILL_LOCK]);
		if (Number(lockRows[0]?.['acquired']) !== 1) throw new Error('Could not acquire transfer identity backfill lock');
		locked = true;
		await connection.beginTransaction();
		transaction = true;
		const previous = await connection.query<QueryRow[]>(`
			SELECT source_record_count, assigned_record_count
			FROM stock_transfer_identity_checkpoints
			WHERE plan_hash = ?
			FOR UPDATE
		`, [hashBuffer(plan.planHash)]);
		if (previous.length) {
			await connection.rollback();
			transaction = false;
			return {
				planHash: plan.planHash,
				alreadyApplied: true,
				sourceRecordCount: Number(previous[0]!['source_record_count']),
				assignedRecordCount: Number(previous[0]!['assigned_record_count']),
			};
		}
		const currentRows = await readTransferIdentityRows(connection, true);
		const currentPlan = buildTransferIdentityBackfillPlan(currentRows, plan.observedAt);
		if (!currentPlan.readyToApply || !sameTargets(currentPlan.targets, plan.targets)) {
			throw new Error('Transfer identity source changed after planning');
		}
		const allocated = await validateAllocatorRows(connection, plan.targets);
		let assignedRecordCount = 0;
		for (const target of plan.targets) {
			if (!allocated.has(target.publicId)) {
				await connection.query(
					'INSERT INTO stock_transfer_public_ids (public_id, legacy_bitrix_external_id) VALUES (?, ?)',
					[target.publicId, target.bitrixExternalId],
				);
			}
			const current = currentRows.find((row) => row.recordId === target.recordId)!;
			if (current.publicId == null) {
				const updated = await connection.query<SqlResult>(
					'UPDATE stock_transfer_records SET public_id = ? WHERE id = ? AND public_id IS NULL',
					[target.publicId, target.recordId],
				);
				if (Number(updated.affectedRows ?? 0) !== 1) throw new Error(`Transfer record ${target.recordId} public id update failed`);
				assignedRecordCount += 1;
			}
		}
		await connection.query(`
			INSERT INTO stock_transfer_identity_checkpoints (
				plan_hash, observed_at, source_record_count, assigned_record_count
			) VALUES (?, ?, ?, ?)
		`, [hashBuffer(plan.planHash), new Date(plan.observedAt), plan.sourceRecordCount, assignedRecordCount]);
		await connection.commit();
		transaction = false;
		return {
			planHash: plan.planHash,
			alreadyApplied: false,
			sourceRecordCount: plan.sourceRecordCount,
			assignedRecordCount,
		};
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		if (locked) await connection.query('SELECT RELEASE_LOCK(?) AS released', [IDENTITY_BACKFILL_LOCK]).catch(() => undefined);
		await connection.release();
	}
}
