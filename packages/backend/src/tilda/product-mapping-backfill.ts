import type { TildaProductMappingSeedRow } from './product-mapping-seed.js';

type QueryRow = Record<string, unknown>;

export interface TildaMappingBackfillConnection {
	query<T = unknown>(sql: string, values?: unknown[]): Promise<T>;
	batch(sql: string, values: unknown[][]): Promise<unknown>;
	beginTransaction(): Promise<void>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

export interface TildaMappingBackfillResult {
	rows: number;
	confirmed: number;
	ignored: number;
	unresolved: number;
}

const LOCK_NAME = 'b24_app_tilda_mapping_backfill';
const UPSERT = `
	INSERT INTO tilda_product_mappings (
		tilda_uid, tilda_external_id, tilda_sku, tilda_title, row_kind, parent_tilda_uid,
		variant_label, erp_item_code, mapping_status, audit_source, source_seen_at, confirmed_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		tilda_sku = VALUES(tilda_sku),
		tilda_title = VALUES(tilda_title),
		row_kind = VALUES(row_kind),
		parent_tilda_uid = VALUES(parent_tilda_uid),
		variant_label = VALUES(variant_label),
		erp_item_code = VALUES(erp_item_code),
		mapping_status = VALUES(mapping_status),
		audit_source = VALUES(audit_source),
		source_seen_at = VALUES(source_seen_at),
		confirmed_at = VALUES(confirmed_at)
`;

function placeholders(count: number): string {
	return Array.from({ length: count }, () => '?').join(', ');
}

async function rejectIdentityConflicts(connection: TildaMappingBackfillConnection, rows: TildaProductMappingSeedRow[]): Promise<void> {
	const uids = rows.map((row) => row.tildaUid);
	const externalIds = rows.map((row) => row.tildaExternalId);
	const existing = await connection.query<QueryRow[]>(`
		SELECT tilda_uid, tilda_external_id
		FROM tilda_product_mappings
		WHERE tilda_uid IN (${placeholders(uids.length)})
			OR tilda_external_id IN (${placeholders(externalIds.length)})
	`, [...uids, ...externalIds]);
	const expectedByUid = new Map(rows.map((row) => [row.tildaUid, row.tildaExternalId]));
	const expectedByExternal = new Map(rows.map((row) => [row.tildaExternalId, row.tildaUid]));
	for (const row of existing) {
		const uid = String(row['tilda_uid'] ?? '');
		const externalId = String(row['tilda_external_id'] ?? '');
		if (expectedByUid.get(uid) !== externalId || expectedByExternal.get(externalId) !== uid) {
			throw new Error(`Existing Tilda mapping identity conflicts with seed: ${uid}/${externalId}`);
		}
	}
}

function values(row: TildaProductMappingSeedRow): unknown[] {
	return [
		row.tildaUid,
		row.tildaExternalId,
		row.tildaSku,
		row.tildaTitle,
		row.rowKind,
		row.parentTildaUid,
		row.variantLabel,
		row.erpItemCode,
		row.mappingStatus,
		row.auditSource,
		row.sourceSeenAt,
		row.confirmedAt,
	];
}

export async function backfillTildaProductMappings(
	connection: TildaMappingBackfillConnection,
	rows: TildaProductMappingSeedRow[],
): Promise<TildaMappingBackfillResult> {
	if (!rows.length) throw new Error('Tilda mapping backfill seed is empty');
	const lockRows = await connection.query<QueryRow[]>('SELECT GET_LOCK(?, 0) AS acquired', [LOCK_NAME]);
	if (Number(lockRows[0]?.['acquired']) !== 1) throw new Error('Tilda mapping backfill is already running');
	let transaction = false;
	try {
		await rejectIdentityConflicts(connection, rows);
		await connection.beginTransaction();
		transaction = true;
		await connection.batch(UPSERT, rows.map(values));
		await connection.commit();
		transaction = false;
		return {
			rows: rows.length,
			confirmed: rows.filter((row) => row.mappingStatus === 'confirmed').length,
			ignored: rows.filter((row) => row.mappingStatus === 'ignored').length,
			unresolved: rows.filter((row) => row.mappingStatus === 'unresolved').length,
		};
	} catch (error) {
		if (transaction) await connection.rollback();
		throw error;
	} finally {
		await connection.query('SELECT RELEASE_LOCK(?) AS released', [LOCK_NAME]);
	}
}
