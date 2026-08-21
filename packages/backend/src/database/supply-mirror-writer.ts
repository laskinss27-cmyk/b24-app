import type { SupplyMirrorPlan } from './supply-backfill-types.js';
import { supplyMirrorDocumentIdentity, supplyMirrorLineIdentity } from './supply-backfill-plan.js';
import { summarizeSupplyMirrorPlan } from './supply-backfill-service.js';

const WRITER_LOCK = 'b24_app_supply_mirror_writer';
const BATCH_SIZE = 250;

type QueryRow = Record<string, unknown>;

export interface SupplyMirrorWriterConnection {
	query<T = unknown>(sql: string, values?: unknown[]): Promise<T>;
	batch(sql: string, values: unknown[][]): Promise<unknown>;
	beginTransaction(): Promise<void>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	release(): void | Promise<void>;
}

export interface SupplyMirrorWriterPool {
	getConnection(): Promise<SupplyMirrorWriterConnection>;
}

export interface SupplyMirrorWriteResult {
	planHash: string;
	alreadyApplied: boolean;
	counts: {
		documents: number;
		lines: number;
		links: number;
		allocations: number;
		warnings: number;
	};
}

const DOCUMENT_UPSERT = `
	INSERT INTO workflow_documents (
		document_type, external_system, external_id, external_revision_key, external_status,
		external_docstatus, bitrix_deal_id, source_created_at, source_modified_at, observed_at, source_hash
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		external_revision_key = VALUES(external_revision_key),
		external_status = VALUES(external_status),
		external_docstatus = VALUES(external_docstatus),
		bitrix_deal_id = VALUES(bitrix_deal_id),
		source_created_at = VALUES(source_created_at),
		source_modified_at = VALUES(source_modified_at),
		observed_at = VALUES(observed_at),
		source_hash = VALUES(source_hash)
`;

const LINE_UPSERT = `
	INSERT INTO workflow_document_lines (
		document_id, external_line_key, line_ordinal, erp_item_code, planned_qty, request_qty,
		actual_qty, source_warehouse, target_warehouse, source_modified_at, observed_at, source_hash
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		external_line_key = VALUES(external_line_key),
		line_ordinal = VALUES(line_ordinal),
		erp_item_code = VALUES(erp_item_code),
		planned_qty = VALUES(planned_qty),
		request_qty = VALUES(request_qty),
		actual_qty = VALUES(actual_qty),
		source_warehouse = VALUES(source_warehouse),
		target_warehouse = VALUES(target_warehouse),
		source_modified_at = VALUES(source_modified_at),
		observed_at = VALUES(observed_at),
		source_hash = VALUES(source_hash)
`;

const LINK_UPSERT = `
	INSERT INTO workflow_document_links (
		from_document_id, to_document_id, relation_type, evidence_kind, evidence_source, observed_at, source_hash
	) VALUES (?, ?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		evidence_kind = VALUES(evidence_kind),
		evidence_source = VALUES(evidence_source),
		observed_at = VALUES(observed_at),
		source_hash = VALUES(source_hash)
`;

const ALLOCATION_UPSERT = `
	INSERT INTO workflow_line_allocations (
		source_line_id, target_line_id, allocation_type, quantity, evidence_kind, evidence_source, observed_at, source_hash
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		quantity = VALUES(quantity),
		evidence_kind = VALUES(evidence_kind),
		evidence_source = VALUES(evidence_source),
		observed_at = VALUES(observed_at),
		source_hash = VALUES(source_hash)
`;

function hashBuffer(value: string, label: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
	return Buffer.from(value, 'hex');
}

function sqlDateTime(value: string | null, label: string): string | null {
	if (value === null) return null;
	const naive = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value.trim());
	if (naive) return `${naive[1]}.${String(naive[2] ?? '').padEnd(6, '0')}`;
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is not a valid timestamp`);
	return parsed.toISOString().replace('T', ' ').replace('Z', '000');
}

async function runBatches(connection: SupplyMirrorWriterConnection, sql: string, values: unknown[][]): Promise<void> {
	for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
		await connection.batch(sql, values.slice(offset, offset + BATCH_SIZE));
	}
}

function requiredId(ids: Map<string, bigint | number | string>, identity: string): bigint | number | string {
	const id = ids.get(identity);
	if (id === undefined) throw new Error(`SQL identity was not resolved: ${identity}`);
	return id;
}

function validatePlan(plan: SupplyMirrorPlan): void {
	if (!plan.readyToApply || plan.issues.some((issue) => issue.severity === 'error')) {
		throw new Error('Supply mirror plan is not ready to apply');
	}
	if (Object.values(plan.sourceStatus).some((source) => !source.complete)) {
		throw new Error('Supply mirror plan has an incomplete source');
	}
	sqlDateTime(plan.observedAt, 'plan observedAt');
	for (const row of plan.documents) {
		hashBuffer(row.sourceHash, `document ${row.identity} sourceHash`);
		sqlDateTime(row.observedAt, `document ${row.identity} observedAt`);
		sqlDateTime(row.sourceCreatedAt, `document ${row.identity} sourceCreatedAt`);
		sqlDateTime(row.sourceModifiedAt, `document ${row.identity} sourceModifiedAt`);
	}
	for (const row of plan.lines) {
		hashBuffer(row.sourceHash, `line ${row.identity} sourceHash`);
		sqlDateTime(row.observedAt, `line ${row.identity} observedAt`);
		sqlDateTime(row.sourceModifiedAt, `line ${row.identity} sourceModifiedAt`);
	}
	for (const row of [...plan.links, ...plan.allocations]) {
		hashBuffer(row.sourceHash, `${row.identity} sourceHash`);
		sqlDateTime(row.observedAt, `${row.identity} observedAt`);
	}
}

async function readDocumentIds(connection: SupplyMirrorWriterConnection): Promise<Map<string, bigint | number | string>> {
	const rows = await connection.query<QueryRow[]>(
		'SELECT id, external_system, document_type, external_id FROM workflow_documents',
	);
	return new Map(rows.map((row) => [supplyMirrorDocumentIdentity({
		externalSystem: String(row['external_system']) as SupplyMirrorPlan['documents'][number]['externalSystem'],
		documentType: String(row['document_type']) as SupplyMirrorPlan['documents'][number]['documentType'],
		externalId: String(row['external_id']),
	}), row['id'] as bigint | number | string]));
}

async function readLineIds(connection: SupplyMirrorWriterConnection): Promise<Map<string, bigint | number | string>> {
	const rows = await connection.query<QueryRow[]>(`
		SELECT l.id, l.external_line_key, l.line_ordinal,
			d.external_system, d.document_type, d.external_id
		FROM workflow_document_lines l
		JOIN workflow_documents d ON d.id = l.document_id
	`);
	return new Map(rows.map((row) => [supplyMirrorLineIdentity({
		document: {
			externalSystem: String(row['external_system']) as SupplyMirrorPlan['documents'][number]['externalSystem'],
			documentType: String(row['document_type']) as SupplyMirrorPlan['documents'][number]['documentType'],
			externalId: String(row['external_id']),
		},
		externalLineKey: row['external_line_key'] == null ? null : String(row['external_line_key']),
		lineOrdinal: Number(row['line_ordinal']),
	}), row['id'] as bigint | number | string]));
}

export async function applySupplyMirrorPlan(pool: SupplyMirrorWriterPool, plan: SupplyMirrorPlan): Promise<SupplyMirrorWriteResult> {
	validatePlan(plan);
	const report = summarizeSupplyMirrorPlan(plan);
	const planHash = report.planHash;
	const counts = {
		documents: plan.documents.length,
		lines: plan.lines.length,
		links: plan.links.length,
		allocations: plan.allocations.length,
		warnings: report.counts.warnings,
	};
	const connection = await pool.getConnection();
	let locked = false;
	let transaction = false;
	try {
		const lockRows = await connection.query<QueryRow[]>('SELECT GET_LOCK(?, 10) AS acquired', [WRITER_LOCK]);
		if (Number(lockRows[0]?.['acquired']) !== 1) throw new Error('Could not acquire supply mirror writer lock');
		locked = true;
		await connection.beginTransaction();
		transaction = true;
		const previous = await connection.query<QueryRow[]>(
			'SELECT id FROM supply_mirror_checkpoints WHERE plan_hash = ? FOR UPDATE',
			[hashBuffer(planHash, 'planHash')],
		);
		if (previous.length) {
			await connection.rollback();
			transaction = false;
			return { planHash, alreadyApplied: true, counts };
		}

		await runBatches(connection, DOCUMENT_UPSERT, plan.documents.map((row) => [
			row.documentType,
			row.externalSystem,
			row.externalId,
			row.externalRevisionKey,
			row.externalStatus,
			row.externalDocstatus,
			row.bitrixDealId,
			sqlDateTime(row.sourceCreatedAt, `${row.identity} sourceCreatedAt`),
			sqlDateTime(row.sourceModifiedAt, `${row.identity} sourceModifiedAt`),
			sqlDateTime(row.observedAt, `${row.identity} observedAt`),
			hashBuffer(row.sourceHash, `${row.identity} sourceHash`),
		]));
		const documentIds = await readDocumentIds(connection);
		for (const row of plan.documents) requiredId(documentIds, row.identity);

		await runBatches(connection, LINE_UPSERT, plan.lines.map((row) => [
			requiredId(documentIds, row.documentIdentity),
			row.externalLineKey,
			row.lineOrdinal,
			row.erpItemCode,
			row.plannedQty,
			row.requestQty,
			row.actualQty,
			row.sourceWarehouse,
			row.targetWarehouse,
			sqlDateTime(row.sourceModifiedAt, `${row.identity} sourceModifiedAt`),
			sqlDateTime(row.observedAt, `${row.identity} observedAt`),
			hashBuffer(row.sourceHash, `${row.identity} sourceHash`),
		]));
		const lineIds = await readLineIds(connection);
		for (const row of plan.lines) requiredId(lineIds, row.identity);

		await runBatches(connection, LINK_UPSERT, plan.links.map((row) => [
			requiredId(documentIds, row.fromDocumentIdentity),
			requiredId(documentIds, row.toDocumentIdentity),
			row.relationType,
			row.evidenceKind,
			row.evidenceSource,
			sqlDateTime(row.observedAt, `${row.identity} observedAt`),
			hashBuffer(row.sourceHash, `${row.identity} sourceHash`),
		]));

		await runBatches(connection, ALLOCATION_UPSERT, plan.allocations.map((row) => [
			requiredId(lineIds, row.sourceLineIdentity),
			requiredId(lineIds, row.targetLineIdentity),
			row.allocationType,
			row.quantity,
			row.evidenceKind,
			row.evidenceSource,
			sqlDateTime(row.observedAt, `${row.identity} observedAt`),
			hashBuffer(row.sourceHash, `${row.identity} sourceHash`),
		]));

		await connection.query(`
			INSERT INTO supply_mirror_checkpoints (
				plan_hash, observed_at, erpnext_records, bitrix_transfer_records,
				bitrix_transfer_request_records, document_count, line_count, link_count,
				allocation_count, warning_count
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, [
			hashBuffer(planHash, 'planHash'),
			sqlDateTime(plan.observedAt, 'plan observedAt'),
			plan.sourceStatus.erpnext.records,
			plan.sourceStatus.bitrixTransfers.records,
			plan.sourceStatus.bitrixTransferRequests.records,
			counts.documents,
			counts.lines,
			counts.links,
			counts.allocations,
			counts.warnings,
		]);
		await connection.commit();
		transaction = false;
		return { planHash, alreadyApplied: false, counts };
	} catch (error) {
		if (transaction) {
			try { await connection.rollback(); } catch { /* preserve the writer error */ }
		}
		throw error;
	} finally {
		if (locked) {
			try { await connection.query('SELECT RELEASE_LOCK(?) AS released', [WRITER_LOCK]); } catch { /* connection release also drops the lock */ }
		}
		await connection.release();
	}
}
