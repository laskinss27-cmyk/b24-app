import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import type { StoredTransferRequest } from './request-model.js';
import {
	transferRequestSqlStateHash,
	writeTransferRequestSqlRevisionOnConnection,
	type TransferRequestSqlSourceKind,
} from './request-sql-store.js';
import type { TransferSqlPool } from './sql-store.js';

export interface TransferRequestBackfillPlan {
	readyToApply: boolean;
	observedAt: string;
	sourceRecordCount: number;
	requests: StoredTransferRequest[];
	planHash: string;
	issues: Array<{ code: string; identity: string; message: string }>;
}

export function buildTransferRequestBackfillPlan(input: {
	observedAt: string;
	sourceComplete: boolean;
	sourceRecordCount: number;
	requests: StoredTransferRequest[];
}): TransferRequestBackfillPlan {
	const issues: TransferRequestBackfillPlan['issues'] = [];
	if (!input.sourceComplete) issues.push({ code: 'incomplete_source', identity: 'ctv_tr_requests', message: 'Bitrix request source is incomplete' });
	const observed = new Date(input.observedAt);
	if (!input.observedAt.trim() || !Number.isFinite(observed.getTime())) {
		issues.push({ code: 'invalid_observed_at', identity: 'ctv_tr_requests', message: 'Observed timestamp is invalid' });
	}
	if (input.sourceRecordCount !== input.requests.length) {
		issues.push({ code: 'source_count_mismatch', identity: 'ctv_tr_requests', message: 'Source count differs from parsed requests' });
	}
	const seen = new Set<number>();
	const requests = [...input.requests].sort((left, right) => left.id - right.id);
	const stateHashes = new Map<number, string>();
	for (const request of requests) {
		if (seen.has(request.id)) issues.push({ code: 'duplicate_external_id', identity: String(request.id), message: 'Request id is duplicated' });
		seen.add(request.id);
		try { stateHashes.set(request.id, transferRequestSqlStateHash(request)); }
		catch (error) { issues.push({ code: 'invalid_request', identity: String(request.id), message: error instanceof Error ? error.message : String(error) }); }
	}
	issues.sort((left, right) => `${left.code}:${left.identity}`.localeCompare(`${right.code}:${right.identity}`, 'en'));
	const planHash = createHash('sha256').update(supplyMirrorCanonicalJson({
		formatVersion: 1,
		requests: requests.map((request) => ({ externalId: request.id, stateHash: stateHashes.get(request.id) ?? null })),
	})).digest('hex');
	return {
		readyToApply: issues.length === 0,
		observedAt: Number.isFinite(observed.getTime()) ? observed.toISOString() : input.observedAt,
		sourceRecordCount: input.sourceRecordCount,
		requests,
		planHash,
		issues,
	};
}

function hashBuffer(hash: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid transfer request backfill hash');
	return Buffer.from(hash, 'hex');
}

export async function applyTransferRequestBackfill(
	pool: TransferSqlPool,
	plan: TransferRequestBackfillPlan,
	expectedHash: string,
): Promise<{ alreadyApplied: boolean; createdRevisionCount: number; unchangedRecordCount: number }> {
	if (!plan.readyToApply || plan.issues.length) throw new Error('Transfer request backfill plan is blocked');
	if (plan.planHash !== expectedHash) throw new Error('Transfer request backfill checkpoint does not match the approved plan');
	const connection = await pool.getConnection();
	let transaction = false;
	let locked = false;
	try {
		const lockRows = await connection.query<Array<Record<string, unknown>>>('SELECT GET_LOCK(?, 10) AS acquired', ['b24_app_transfer_request_backfill']);
		if (Number(lockRows[0]?.['acquired']) !== 1) throw new Error('Could not acquire transfer request backfill lock');
		locked = true;
		await connection.beginTransaction();
		transaction = true;
		const previous = await connection.query<Array<Record<string, unknown>>>(`
			SELECT created_revision_count, unchanged_record_count
			FROM stock_transfer_request_backfill_checkpoints
			WHERE plan_hash = ?
			FOR UPDATE
		`, [hashBuffer(plan.planHash)]);
		if (previous.length) {
			await connection.rollback();
			transaction = false;
			return {
				alreadyApplied: true,
				createdRevisionCount: Number(previous[0]!['created_revision_count']),
				unchangedRecordCount: Number(previous[0]!['unchanged_record_count']),
			};
		}
		let createdRevisionCount = 0;
		let unchangedRecordCount = 0;
		for (const request of plan.requests) {
			const { id, name, ...data } = request;
			const sourceKind: TransferRequestSqlSourceKind = 'bitrix_backfill';
			const result = await writeTransferRequestSqlRevisionOnConnection(connection, { externalId: id, name, data, sourceKind });
			if (result.alreadyCurrent) unchangedRecordCount += 1;
			else createdRevisionCount += 1;
		}
		await connection.query(`
			INSERT INTO stock_transfer_request_backfill_checkpoints (
				plan_hash, observed_at, source_record_count, created_revision_count, unchanged_record_count
			) VALUES (?, ?, ?, ?, ?)
		`, [hashBuffer(plan.planHash), new Date(plan.observedAt), plan.sourceRecordCount, createdRevisionCount, unchangedRecordCount]);
		await connection.commit();
		transaction = false;
		return { alreadyApplied: false, createdRevisionCount, unchangedRecordCount };
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		if (locked) await connection.query('SELECT RELEASE_LOCK(?) AS released', ['b24_app_transfer_request_backfill']).catch(() => undefined);
		await connection.release();
	}
}
