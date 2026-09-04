import type { TransferSqlPool } from '../transfers/sql-store.js';
import { inventorySqlStateHash, type InventorySqlErpDocument, type InventorySqlPoint, type InventorySqlRecord, type InventorySqlRecordState } from './model.js';

type QueryRow = Record<string, unknown>;

function positiveInteger(value: unknown, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
	return parsed;
}

function signedInteger(value: unknown, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed === 0) throw new Error(`Invalid ${name}`);
	return parsed;
}

function optionalInteger(value: unknown, name: string): number | null {
	if (value == null) return null;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${name}`);
	return parsed;
}

function quantity(value: unknown, name: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}`);
	return parsed;
}

function timestamp(value: unknown, name: string): string | null {
	if (value == null || String(value).trim() === '') return null;
	const source = String(value).trim();
	const sql = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(source);
	const normalized = sql
		? `${sql[1]}T${sql[2]}.${String(sql[3] ?? '').padEnd(3, '0').slice(0, 3)}Z`
		: source;
	const parsed = value instanceof Date ? value : new Date(normalized);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid ${name}`);
	return parsed.toISOString();
}

function dateOnly(value: unknown): string | null {
	if (value == null || String(value).trim() === '') return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	const text = String(value);
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
	const parsed = new Date(text);
	if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid inventory deadline');
	return parsed.toISOString().slice(0, 10);
}

function storedHash(value: unknown): string {
	if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error('Invalid stored inventory state hash');
	return value.toString('hex');
}

function pointStatus(value: unknown): InventorySqlPoint['status'] {
	const status = String(value);
	if (!['idle', 'in_progress', 'submitted', 'act', 'reconciled'].includes(status)) throw new Error(`Invalid inventory point status ${status}`);
	return status as InventorySqlPoint['status'];
}

export async function readInventorySqlRecords(pool: TransferSqlPool): Promise<InventorySqlRecord[]> {
	const [recordRows, sectionRows, pointRows, snapshotRows, countRows, resultRows, documentRows] = await Promise.all([
		pool.query<QueryRow[]>(`
			SELECT id, bitrix_external_id, display_name, inventory_status, deadline,
				created_by_id,
				DATE_FORMAT(source_created_at, '%Y-%m-%d %H:%i:%s.%f') AS source_created_at,
				DATE_FORMAT(stock_snapshot_at, '%Y-%m-%d %H:%i:%s.%f') AS stock_snapshot_at,
				last_state_hash
			FROM inventory_records
			WHERE deleted_at IS NULL
			ORDER BY bitrix_external_id
		`),
		pool.query<QueryRow[]>(`
			SELECT inventory_id, section_id, section_ordinal
			FROM inventory_sections
			WHERE is_present = 1
			ORDER BY inventory_id, section_ordinal
		`),
		pool.query<QueryRow[]>(`
			SELECT id, inventory_id, point_ordinal, store_id, store_name, point_status,
				responsible_id, responsible_name,
				DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS started_at,
				DATE_FORMAT(submitted_at, '%Y-%m-%d %H:%i:%s.%f') AS submitted_at,
				DATE_FORMAT(act_at, '%Y-%m-%d %H:%i:%s.%f') AS act_at,
				snapshot_version,
				DATE_FORMAT(snapshot_captured_at, '%Y-%m-%d %H:%i:%s.%f') AS snapshot_captured_at,
				DATE_FORMAT(snapshot_migrated_at, '%Y-%m-%d %H:%i:%s.%f') AS snapshot_migrated_at,
				DATE_FORMAT(draft_updated_at, '%Y-%m-%d %H:%i:%s.%f') AS draft_updated_at,
				draft_updated_by_id, draft_updated_by_name,
				draft_session_id, draft_sequence, result_total, result_counted, result_discrepancies
			FROM inventory_points
			WHERE is_present = 1
			ORDER BY inventory_id, point_ordinal
		`),
		pool.query<QueryRow[]>(`
			SELECT line.point_id, line.product_id, line.book_qty
			FROM inventory_snapshot_lines line
			JOIN inventory_points point ON point.id = line.point_id AND point.is_present = 1
			ORDER BY line.point_id, line.product_id
		`),
		pool.query<QueryRow[]>(`
			SELECT line.point_id, line.product_id, line.fact_qty, line.line_comment
			FROM inventory_count_lines line
			JOIN inventory_points point ON point.id = line.point_id AND point.is_present = 1
			WHERE line.is_present = 1
			ORDER BY line.point_id, line.product_id
		`),
		pool.query<QueryRow[]>(`
			SELECT line.point_id, line.line_ordinal, line.product_id, line.product_name,
				line.book_qty, line.fact_qty, line.difference_qty, line.line_comment
			FROM inventory_result_lines line
			JOIN inventory_points point ON point.id = line.point_id AND point.is_present = 1
			WHERE line.is_present = 1
			ORDER BY line.point_id, line.line_ordinal
		`),
		pool.query<QueryRow[]>(`
			SELECT document.point_id, document.document_kind, document.erp_doctype,
				document.erp_document_name, document.document_status, document.line_count,
				DATE_FORMAT(document.saved_at, '%Y-%m-%d %H:%i:%s.%f') AS saved_at,
				DATE_FORMAT(document.submitted_at, '%Y-%m-%d %H:%i:%s.%f') AS submitted_at
			FROM inventory_erp_documents document
			JOIN inventory_points point ON point.id = document.point_id AND point.is_present = 1
			WHERE document.is_present = 1
			ORDER BY document.point_id, document.id
		`),
	]);

	const sectionsByInventory = new Map<number, number[]>();
	for (const row of sectionRows) {
		const inventoryId = positiveInteger(row['inventory_id'], 'inventory section record id');
		const sectionId = positiveInteger(row['section_id'], 'inventory section id');
		const sections = sectionsByInventory.get(inventoryId) ?? [];
		sections.push(sectionId);
		sectionsByInventory.set(inventoryId, sections);
	}
	const pointById = new Map<number, InventorySqlPoint>();
	const pointsByInventory = new Map<number, InventorySqlPoint[]>();
	for (const row of pointRows) {
		const pointId = positiveInteger(row['id'], 'inventory point id');
		const inventoryId = positiveInteger(row['inventory_id'], 'inventory point record id');
		const snapshotVersion = row['snapshot_version'] == null ? null : Number(row['snapshot_version']);
		if (snapshotVersion !== null && snapshotVersion !== 1) throw new Error(`Invalid inventory snapshot version ${snapshotVersion}`);
		const point: InventorySqlPoint = {
			ordinal: positiveInteger(row['point_ordinal'], 'inventory point ordinal'),
			storeId: signedInteger(row['store_id'], 'inventory store id'),
			storeName: String(row['store_name'] ?? ''),
			status: pointStatus(row['point_status']),
			responsibleId: String(row['responsible_id'] ?? ''),
			responsibleName: String(row['responsible_name'] ?? ''),
			startedAt: timestamp(row['started_at'], 'inventory point started_at'),
			submittedAt: timestamp(row['submitted_at'], 'inventory point submitted_at'),
			actAt: timestamp(row['act_at'], 'inventory point act_at'),
			snapshotVersion,
			snapshotCapturedAt: timestamp(row['snapshot_captured_at'], 'inventory snapshot captured_at'),
			snapshotMigratedAt: timestamp(row['snapshot_migrated_at'], 'inventory snapshot migrated_at'),
			draftUpdatedAt: timestamp(row['draft_updated_at'], 'inventory draft updated_at'),
			draftUpdatedById: String(row['draft_updated_by_id'] ?? ''),
			draftUpdatedByName: String(row['draft_updated_by_name'] ?? ''),
			draftSessionId: String(row['draft_session_id'] ?? ''),
			draftSequence: optionalInteger(row['draft_sequence'], 'inventory draft sequence') ?? 0,
			resultTotal: optionalInteger(row['result_total'], 'inventory result total'),
			resultCounted: optionalInteger(row['result_counted'], 'inventory result counted'),
			resultDiscrepancies: optionalInteger(row['result_discrepancies'], 'inventory result discrepancies'),
			snapshotLines: [], countLines: [], resultLines: [], erpDocuments: [],
		};
		pointById.set(pointId, point);
		const points = pointsByInventory.get(inventoryId) ?? [];
		points.push(point);
		pointsByInventory.set(inventoryId, points);
	}
	for (const row of snapshotRows) {
		const point = pointById.get(positiveInteger(row['point_id'], 'inventory snapshot point id'));
		if (!point) throw new Error('Inventory snapshot line references a missing current point');
		point.snapshotLines.push({ productId: positiveInteger(row['product_id'], 'inventory snapshot product id'), bookQty: quantity(row['book_qty'], 'inventory snapshot quantity') });
	}
	for (const row of countRows) {
		const point = pointById.get(positiveInteger(row['point_id'], 'inventory count point id'));
		if (!point) throw new Error('Inventory count line references a missing current point');
		point.countLines.push({
			productId: positiveInteger(row['product_id'], 'inventory count product id'),
			factQty: row['fact_qty'] == null ? null : quantity(row['fact_qty'], 'inventory fact quantity'),
			comment: String(row['line_comment'] ?? ''),
		});
	}
	for (const row of resultRows) {
		const point = pointById.get(positiveInteger(row['point_id'], 'inventory result point id'));
		if (!point) throw new Error('Inventory result line references a missing current point');
		point.resultLines.push({
			ordinal: positiveInteger(row['line_ordinal'], 'inventory result ordinal'),
			productId: positiveInteger(row['product_id'], 'inventory result product id'),
			productName: String(row['product_name'] ?? ''),
			bookQty: quantity(row['book_qty'], 'inventory result book quantity'),
			factQty: quantity(row['fact_qty'], 'inventory result fact quantity'),
			differenceQty: quantity(row['difference_qty'], 'inventory result difference quantity'),
			comment: String(row['line_comment'] ?? ''),
		});
	}
	for (const row of documentRows) {
		const point = pointById.get(positiveInteger(row['point_id'], 'inventory ERP document point id'));
		if (!point) throw new Error('Inventory ERP document references a missing current point');
		const kind = String(row['document_kind']);
		if (!['legacy_reconciliation', 'issue', 'receipt'].includes(kind)) throw new Error(`Invalid inventory ERP document kind ${kind}`);
		point.erpDocuments.push({
			kind: kind as InventorySqlErpDocument['kind'],
			erpDoctype: String(row['erp_doctype']) as InventorySqlErpDocument['erpDoctype'],
			name: String(row['erp_document_name'] ?? ''),
			status: String(row['document_status']) as InventorySqlErpDocument['status'],
			lineCount: optionalInteger(row['line_count'], 'inventory ERP line count') ?? 0,
			savedAt: timestamp(row['saved_at'], 'inventory ERP saved_at'),
			submittedAt: timestamp(row['submitted_at'], 'inventory ERP submitted_at'),
		});
	}

	return recordRows.map((row) => {
		const inventoryId = positiveInteger(row['id'], 'inventory record id');
		const status = String(row['inventory_status']);
		if (status !== 'active' && status !== 'closed') throw new Error(`Invalid inventory status ${status}`);
		const state: InventorySqlRecordState = {
			bitrixExternalId: positiveInteger(row['bitrix_external_id'], 'inventory Bitrix id'),
			displayName: String(row['display_name'] ?? ''),
			status,
			deadline: dateOnly(row['deadline']),
			createdById: String(row['created_by_id'] ?? ''),
			sourceCreatedAt: timestamp(row['source_created_at'], 'inventory source created_at'),
			stockSnapshotAt: timestamp(row['stock_snapshot_at'], 'inventory stock snapshot_at'),
			sectionIds: sectionsByInventory.get(inventoryId) ?? [],
			points: pointsByInventory.get(inventoryId) ?? [],
		};
		const stateHash = storedHash(row['last_state_hash']);
		if (inventorySqlStateHash(state) !== stateHash) throw new Error(`Inventory ${state.bitrixExternalId} SQL state hash mismatch`);
		return { ...state, stateHash };
	});
}
