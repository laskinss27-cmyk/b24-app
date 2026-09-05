import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import type { TransferSqlConnection, TransferSqlPool } from '../transfers/sql-store.js';

const IDENTITY_BACKFILL_LOCK = 'b24_app_inventory_identity_backfill';
type QueryRow = Record<string, unknown>;
type SqlResult = { affectedRows?: number };

export interface InventoryIdentityRow {
	recordId: number;
	bitrixExternalId: number;
	publicId: number | null;
}

export interface InventoryIdentityTarget {
	recordId: number;
	bitrixExternalId: number;
	publicId: number;
}

export interface InventoryIdentityIssue {
	code: 'invalid_observed_at' | 'invalid_record' | 'duplicate_record_id' | 'duplicate_bitrix_id' | 'public_id_conflict';
	identity: string;
	message: string;
}

export interface InventoryIdentityBackfillPlan {
	readyToApply: boolean;
	observedAt: string;
	sourceRecordCount: number;
	assignedRecordCount: number;
	targets: InventoryIdentityTarget[];
	planHash: string;
	issues: InventoryIdentityIssue[];
}

export interface InventoryIdentityBackfillResult {
	planHash: string;
	alreadyApplied: boolean;
	sourceRecordCount: number;
	assignedRecordCount: number;
}

function positiveInteger(value: unknown, field: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${field}`);
	return parsed;
}

function canonicalObservedAt(value: string): string {
	const parsed = new Date(value);
	if (!value.trim() || !Number.isFinite(parsed.getTime())) throw new Error('Invalid inventory identity observedAt');
	return parsed.toISOString();
}

function hashBuffer(hash: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid inventory identity plan hash');
	return Buffer.from(hash, 'hex');
}

export function buildInventoryIdentityBackfillPlan(
	rows: InventoryIdentityRow[],
	observedAt: string,
): InventoryIdentityBackfillPlan {
	const issues: InventoryIdentityIssue[] = [];
	let canonicalAt = observedAt;
	try { canonicalAt = canonicalObservedAt(observedAt); }
	catch (error) {
		issues.push({ code: 'invalid_observed_at', identity: 'inventory_records', message: error instanceof Error ? error.message : String(error) });
	}
	const targets: InventoryIdentityTarget[] = [];
	const recordIds = new Set<number>();
	const bitrixIds = new Set<number>();
	for (const row of rows) {
		try {
			const recordId = positiveInteger(row.recordId, 'inventory record id');
			const bitrixExternalId = positiveInteger(row.bitrixExternalId, 'inventory Bitrix external id');
			const publicId = row.publicId == null ? null : positiveInteger(row.publicId, 'inventory public id');
			if (recordIds.has(recordId)) issues.push({ code: 'duplicate_record_id', identity: String(recordId), message: 'Inventory record id is duplicated' });
			if (bitrixIds.has(bitrixExternalId)) issues.push({ code: 'duplicate_bitrix_id', identity: String(bitrixExternalId), message: 'Bitrix inventory id is duplicated' });
			recordIds.add(recordId);
			bitrixIds.add(bitrixExternalId);
			if (publicId != null && publicId !== bitrixExternalId) issues.push({
				code: 'public_id_conflict', identity: String(recordId),
				message: `Existing public id ${publicId} differs from legacy Bitrix id ${bitrixExternalId}`,
			});
			targets.push({ recordId, bitrixExternalId, publicId: bitrixExternalId });
		} catch (error) {
			issues.push({ code: 'invalid_record', identity: String(row.recordId), message: error instanceof Error ? error.message : String(error) });
		}
	}
	targets.sort((left, right) => left.publicId - right.publicId || left.recordId - right.recordId);
	issues.sort((left, right) => `${left.code}:${left.identity}`.localeCompare(`${right.code}:${right.identity}`, 'en'));
	const planHash = createHash('sha256').update(supplyMirrorCanonicalJson({ formatVersion: 1, targets })).digest('hex');
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

export async function readInventoryIdentityRows(
	pool: Pick<TransferSqlPool, 'query'> | Pick<TransferSqlConnection, 'query'>,
	forUpdate = false,
): Promise<InventoryIdentityRow[]> {
	const rows = await pool.query<QueryRow[]>(`
		SELECT id, bitrix_external_id, public_id
		FROM inventory_records
		WHERE bitrix_external_id IS NOT NULL
		ORDER BY bitrix_external_id
		${forUpdate ? 'FOR UPDATE' : ''}
	`);
	return rows.map((row) => ({
		recordId: positiveInteger(row['id'], 'inventory record id'),
		bitrixExternalId: positiveInteger(row['bitrix_external_id'], 'inventory Bitrix external id'),
		publicId: row['public_id'] == null ? null : positiveInteger(row['public_id'], 'inventory public id'),
	}));
}

function sameTargets(left: InventoryIdentityTarget[], right: InventoryIdentityTarget[]): boolean {
	return left.length === right.length && left.every((target, index) => {
		const other = right[index];
		return other?.recordId === target.recordId && other.bitrixExternalId === target.bitrixExternalId && other.publicId === target.publicId;
	});
}

async function validateAllocatorRows(connection: TransferSqlConnection, targets: InventoryIdentityTarget[]): Promise<Set<number>> {
	const rows = await connection.query<QueryRow[]>('SELECT public_id, legacy_bitrix_external_id FROM inventory_public_ids FOR UPDATE');
	const present = new Set<number>();
	const byLegacy = new Map<number, number>();
	for (const row of rows) {
		const publicId = positiveInteger(row['public_id'], 'allocated inventory public id');
		const legacyId = row['legacy_bitrix_external_id'] == null ? null : positiveInteger(row['legacy_bitrix_external_id'], 'allocated inventory legacy id');
		present.add(publicId);
		if (legacyId != null) byLegacy.set(legacyId, publicId);
	}
	for (const target of targets) {
		const existingPublic = byLegacy.get(target.bitrixExternalId);
		if (existingPublic != null && existingPublic !== target.publicId) throw new Error(`Legacy Bitrix inventory id ${target.bitrixExternalId} is allocated as public id ${existingPublic}`);
		if (present.has(target.publicId) && existingPublic == null) throw new Error(`Public inventory id ${target.publicId} is already allocated to another document`);
	}
	return present;
}

export async function applyInventoryIdentityBackfill(
	pool: TransferSqlPool,
	plan: InventoryIdentityBackfillPlan,
	expectedPlanHash: string,
): Promise<InventoryIdentityBackfillResult> {
	if (!plan.readyToApply || plan.issues.length) throw new Error('Inventory identity backfill plan is not ready to apply');
	if (plan.planHash !== expectedPlanHash) throw new Error('Inventory identity checkpoint does not match the approved plan');
	const connection = await pool.getConnection();
	let locked = false;
	let transaction = false;
	try {
		const lockRows = await connection.query<QueryRow[]>('SELECT GET_LOCK(?, 10) AS acquired', [IDENTITY_BACKFILL_LOCK]);
		if (Number(lockRows[0]?.['acquired']) !== 1) throw new Error('Could not acquire inventory identity backfill lock');
		locked = true;
		await connection.beginTransaction();
		transaction = true;
		const previous = await connection.query<QueryRow[]>(`
			SELECT source_record_count, assigned_record_count
			FROM inventory_identity_checkpoints
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
		const currentRows = await readInventoryIdentityRows(connection, true);
		const currentPlan = buildInventoryIdentityBackfillPlan(currentRows, plan.observedAt);
		if (!currentPlan.readyToApply || !sameTargets(currentPlan.targets, plan.targets)) throw new Error('Inventory identity source changed after planning');
		const allocated = await validateAllocatorRows(connection, plan.targets);
		let assignedRecordCount = 0;
		for (const target of plan.targets) {
			if (!allocated.has(target.publicId)) await connection.query(
				'INSERT INTO inventory_public_ids (public_id, legacy_bitrix_external_id) VALUES (?, ?)',
				[target.publicId, target.bitrixExternalId],
			);
			const current = currentRows.find((row) => row.recordId === target.recordId)!;
			if (current.publicId == null) {
				const updated = await connection.query<SqlResult>(
					'UPDATE inventory_records SET public_id = ? WHERE id = ? AND public_id IS NULL',
					[target.publicId, target.recordId],
				);
				if (Number(updated.affectedRows ?? 0) !== 1) throw new Error(`Inventory record ${target.recordId} public id update failed`);
				assignedRecordCount += 1;
			}
		}
		await connection.query(`
			INSERT INTO inventory_identity_checkpoints (plan_hash, observed_at, source_record_count, assigned_record_count)
			VALUES (?, ?, ?, ?)
		`, [hashBuffer(plan.planHash), new Date(plan.observedAt), plan.sourceRecordCount, assignedRecordCount]);
		await connection.commit();
		transaction = false;
		return { planHash: plan.planHash, alreadyApplied: false, sourceRecordCount: plan.sourceRecordCount, assignedRecordCount };
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		if (locked) await connection.query('SELECT RELEASE_LOCK(?) AS released', [IDENTITY_BACKFILL_LOCK]).catch(() => undefined);
		await connection.release();
	}
}
