import { randomUUID } from 'node:crypto';

export type TildaSyncTrigger = 'scheduled' | 'manual';
export type TildaSyncErrorPhase = 'prepare' | 'publish' | 'verify' | 'interrupted';

export interface TildaSyncQueryConnection {
	query<T>(sql: string, values?: unknown[]): Promise<T>;
	release(): Promise<void> | void;
}

export interface TildaSyncLockPool {
	getConnection(): Promise<TildaSyncQueryConnection>;
}

export interface TildaSyncRunMetrics {
	projectionHash: string;
	contentHashBefore: string;
	targetCount: number;
	differenceCountBefore: number;
	blockedCount: number;
}

interface MutationResult {
	affectedRows: number | bigint;
}

function hashBuffer(value: string): Buffer {
	if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('Tilda sync audit hash must be lowercase SHA-256');
	return Buffer.from(value, 'hex');
}

function safeErrorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error))
		.replaceAll(/https?:\/\/\S+/giu, '[url]')
		.replaceAll(/(?:authorization|cookie|password|token|secret|пароль)\s*[:=]\s*\S+/giu, '[redacted]')
		.replaceAll(/[\x00-\x1f\x7f]+/gu, ' ')
		.replaceAll(/\s+/gu, ' ')
		.trim()
		.slice(0, 500) || 'unknown error';
}

export async function withTildaSyncLock<T>(
	pool: TildaSyncLockPool,
	work: (connection: TildaSyncQueryConnection) => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
	const connection = await pool.getConnection();
	let acquired = false;
	try {
		const rows = await connection.query<Array<{ acquired: number | bigint }>>(
			"SELECT GET_LOCK('b24_app_tilda_stock_sync', 0) AS acquired",
		);
		acquired = Number(rows[0]?.acquired ?? 0) === 1;
		if (!acquired) return { acquired: false };
		return { acquired: true, value: await work(connection) };
	} finally {
		try {
			if (acquired) {
				await connection.query("SELECT RELEASE_LOCK('b24_app_tilda_stock_sync') AS released");
			}
		} finally {
			await connection.release();
		}
	}
}

export class TildaStockSyncRunStore {
	constructor(private readonly connection: TildaSyncQueryConnection) {}

	async recoverInterruptedRuns(): Promise<void> {
		await this.connection.query(`
			UPDATE tilda_stock_sync_runs
			SET status = 'failed', error_phase = 'interrupted',
				error_message = 'Previous worker stopped before recording a final result', finished_at = NOW(6)
			WHERE status = 'running'
		`);
	}

	async start(trigger: TildaSyncTrigger, metrics: TildaSyncRunMetrics): Promise<string> {
		const runUuid = randomUUID();
		await this.connection.query(`
			INSERT INTO tilda_stock_sync_runs (
				run_uuid, trigger_source, status, projection_hash, content_hash_before,
				target_count, difference_count_before, blocked_count, started_at
			) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, NOW(6))
		`, [
			runUuid,
			trigger,
			hashBuffer(metrics.projectionHash),
			hashBuffer(metrics.contentHashBefore),
			metrics.targetCount,
			metrics.differenceCountBefore,
			metrics.blockedCount,
		]);
		return runUuid;
	}

	async finishVerified(runUuid: string, result: {
		contentHashAfter: string;
		differenceCountAfter: number;
		catalogXmlHash: string;
		projectionXmlHash: string;
		rollbackXmlHash: string;
	}): Promise<void> {
		const mutation = await this.connection.query<MutationResult>(`
			UPDATE tilda_stock_sync_runs
			SET status = 'verified', content_hash_after = ?, difference_count_after = ?,
				catalog_xml_hash = ?, projection_xml_hash = ?, rollback_xml_hash = ?, finished_at = NOW(6)
			WHERE run_uuid = ? AND status = 'running'
		`, [
			hashBuffer(result.contentHashAfter),
			result.differenceCountAfter,
			hashBuffer(result.catalogXmlHash),
			hashBuffer(result.projectionXmlHash),
			hashBuffer(result.rollbackXmlHash),
			runUuid,
		]);
		if (Number(mutation.affectedRows) !== 1) throw new Error('Tilda sync audit run was not finalized');
	}

	async finishFailed(runUuid: string, phase: TildaSyncErrorPhase, error: unknown): Promise<void> {
		const mutation = await this.connection.query<MutationResult>(`
			UPDATE tilda_stock_sync_runs
			SET status = 'failed', error_phase = ?, error_message = ?, finished_at = NOW(6)
			WHERE run_uuid = ? AND status = 'running'
		`, [phase, safeErrorMessage(error), runUuid]);
		if (Number(mutation.affectedRows) !== 1) throw new Error('Tilda sync audit failure was not recorded');
	}

	async recordPreparationFailure(trigger: TildaSyncTrigger, error: unknown): Promise<void> {
		await this.connection.query(`
			INSERT INTO tilda_stock_sync_runs (
				run_uuid, trigger_source, status, error_phase, error_message, started_at, finished_at
			) VALUES (?, ?, 'failed', 'prepare', ?, NOW(6), NOW(6))
		`, [randomUUID(), trigger, safeErrorMessage(error)]);
	}

	async recordNoopIfChanged(trigger: TildaSyncTrigger, metrics: TildaSyncRunMetrics): Promise<boolean> {
		const rows = await this.connection.query<Array<{
			status: string;
			projection_hash: string | null;
			content_hash: string | null;
		}>>(`
			SELECT status, LOWER(HEX(projection_hash)) AS projection_hash,
				LOWER(HEX(content_hash_after)) AS content_hash
			FROM tilda_stock_sync_runs
			ORDER BY id DESC LIMIT 1
		`);
		const latest = rows[0];
		if (
			latest && ['no_op', 'verified'].includes(latest.status)
			&& latest.projection_hash === metrics.projectionHash
			&& latest.content_hash === metrics.contentHashBefore
		) return false;
		await this.connection.query(`
			INSERT INTO tilda_stock_sync_runs (
				run_uuid, trigger_source, status, projection_hash, content_hash_before, content_hash_after,
				target_count, difference_count_before, difference_count_after, blocked_count, started_at, finished_at
			) VALUES (?, ?, 'no_op', ?, ?, ?, ?, 0, 0, ?, NOW(6), NOW(6))
		`, [
			randomUUID(),
			trigger,
			hashBuffer(metrics.projectionHash),
			hashBuffer(metrics.contentHashBefore),
			hashBuffer(metrics.contentHashBefore),
			metrics.targetCount,
			metrics.blockedCount,
		]);
		return true;
	}
}
