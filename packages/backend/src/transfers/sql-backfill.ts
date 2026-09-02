import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import type { StoredTransfer, TransferData } from './model.js';
import {
	normalizeTransferSqlState,
	transferSqlStateHash,
	writeTransferSqlRevisionOnConnection,
	type TransferSqlPool,
} from './sql-store.js';

const BACKFILL_LOCK = 'b24_app_stock_transfer_backfill';

type QueryRow = Record<string, unknown>;

export interface TransferSqlBackfillIssue {
	code: 'incomplete_source' | 'invalid_observed_at' | 'invalid_transfer' | 'duplicate_external_id' | 'source_count_mismatch';
	identity: string;
	message: string;
}

export interface TransferSqlBackfillPlan {
	readyToApply: boolean;
	observedAt: string;
	sourceRecordCount: number;
	transfers: StoredTransfer[];
	planHash: string;
	issues: TransferSqlBackfillIssue[];
}

export interface TransferSqlBackfillInput {
	observedAt: string;
	sourceComplete: boolean;
	sourceRecordCount: number;
	transfers: StoredTransfer[];
}

export interface TransferSqlBackfillResult {
	planHash: string;
	alreadyApplied: boolean;
	sourceRecordCount: number;
	createdRevisionCount: number;
	unchangedRecordCount: number;
}

function transferData(transfer: StoredTransfer): TransferData {
	const { id: _id, name: _name, ...data } = transfer;
	return data;
}

function hashBuffer(hash: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid transfer backfill plan hash');
	return Buffer.from(hash, 'hex');
}

function dateTime(value: string): Date {
	const date = new Date(value);
	if (!value.trim() || !Number.isFinite(date.getTime())) throw new Error('Invalid transfer backfill observedAt');
	return date;
}

export function buildTransferSqlBackfillPlan(input: TransferSqlBackfillInput): TransferSqlBackfillPlan {
	const issues: TransferSqlBackfillIssue[] = [];
	if (!input.sourceComplete) issues.push({
		code: 'incomplete_source', identity: 'bitrixTransfers', message: 'Bitrix transfer source is incomplete',
	});
	try { dateTime(input.observedAt); }
	catch (error) {
		issues.push({ code: 'invalid_observed_at', identity: 'snapshot', message: error instanceof Error ? error.message : String(error) });
	}
	if (!Number.isSafeInteger(input.sourceRecordCount) || input.sourceRecordCount < 0 || input.sourceRecordCount !== input.transfers.length) {
		issues.push({
			code: 'source_count_mismatch', identity: 'bitrixTransfers',
			message: `source count ${input.sourceRecordCount} does not match payload count ${input.transfers.length}`,
		});
	}
	const normalized: StoredTransfer[] = [];
	const seen = new Set<number>();
	for (const transfer of input.transfers) {
		try {
			const item = normalizeTransferSqlState({
				externalId: transfer.id,
				name: transfer.name,
				data: transferData(transfer),
				sourceKind: 'bitrix_backfill',
			});
			if (seen.has(item.id)) {
				issues.push({ code: 'duplicate_external_id', identity: String(item.id), message: 'Transfer external id is duplicated' });
				continue;
			}
			seen.add(item.id);
			normalized.push(item);
		} catch (error) {
			issues.push({
				code: 'invalid_transfer', identity: String(transfer.id),
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	normalized.sort((left, right) => left.id - right.id);
	issues.sort((left, right) => `${left.code}:${left.identity}`.localeCompare(`${right.code}:${right.identity}`, 'en'));
	const planHash = createHash('sha256').update(supplyMirrorCanonicalJson(normalized.map((transfer) => ({
		externalId: transfer.id,
		name: transfer.name,
		stateHash: transferSqlStateHash(transfer),
	})))).digest('hex');
	return {
		readyToApply: issues.length === 0,
		observedAt: input.observedAt,
		sourceRecordCount: input.sourceRecordCount,
		transfers: normalized,
		planHash,
		issues,
	};
}

export async function applyTransferSqlBackfill(
	pool: TransferSqlPool,
	plan: TransferSqlBackfillPlan,
	expectedPlanHash: string,
): Promise<TransferSqlBackfillResult> {
	if (!plan.readyToApply || plan.issues.length) throw new Error('Transfer SQL backfill plan is not ready to apply');
	if (plan.transfers.length !== plan.sourceRecordCount) throw new Error('Transfer SQL backfill source count changed after planning');
	if (plan.planHash !== expectedPlanHash) throw new Error('Transfer SQL backfill checkpoint does not match the approved plan');
	const connection = await pool.getConnection();
	let locked = false;
	let transaction = false;
	try {
		const lockRows = await connection.query<QueryRow[]>('SELECT GET_LOCK(?, 10) AS acquired', [BACKFILL_LOCK]);
		if (Number(lockRows[0]?.['acquired']) !== 1) throw new Error('Could not acquire transfer SQL backfill lock');
		locked = true;
		await connection.beginTransaction();
		transaction = true;
		const previous = await connection.query<QueryRow[]>(
			'SELECT created_revision_count, unchanged_record_count FROM stock_transfer_backfill_checkpoints WHERE plan_hash = ? FOR UPDATE',
			[hashBuffer(plan.planHash)],
		);
		if (previous.length) {
			await connection.rollback();
			transaction = false;
			return {
				planHash: plan.planHash,
				alreadyApplied: true,
				sourceRecordCount: plan.sourceRecordCount,
				createdRevisionCount: Number(previous[0]!['created_revision_count']),
				unchangedRecordCount: Number(previous[0]!['unchanged_record_count']),
			};
		}
		let createdRevisionCount = 0;
		let unchangedRecordCount = 0;
		for (const transfer of plan.transfers) {
			const result = await writeTransferSqlRevisionOnConnection(connection, {
				externalId: transfer.id,
				name: transfer.name,
				data: transferData(transfer),
				sourceKind: 'bitrix_backfill',
			});
			if (result.alreadyCurrent) unchangedRecordCount += 1;
			else createdRevisionCount += 1;
		}
		await connection.query(`
			INSERT INTO stock_transfer_backfill_checkpoints (
				plan_hash, observed_at, source_record_count, created_revision_count, unchanged_record_count
			) VALUES (?, ?, ?, ?, ?)
		`, [hashBuffer(plan.planHash), dateTime(plan.observedAt), plan.sourceRecordCount, createdRevisionCount, unchangedRecordCount]);
		await connection.commit();
		transaction = false;
		return {
			planHash: plan.planHash,
			alreadyApplied: false,
			sourceRecordCount: plan.sourceRecordCount,
			createdRevisionCount,
			unchangedRecordCount,
		};
	} catch (error) {
		if (transaction) {
			try { await connection.rollback(); } catch { /* preserve the backfill error */ }
		}
		throw error;
	} finally {
		if (locked) {
			try { await connection.query('SELECT RELEASE_LOCK(?) AS released', [BACKFILL_LOCK]); } catch { /* connection release also drops the lock */ }
		}
		await connection.release();
	}
}
