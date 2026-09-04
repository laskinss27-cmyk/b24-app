import type { TransferSqlConnection, TransferSqlPool } from '../transfers/sql-store.js';
import type { InventorySqlBackfillPlan } from './backfill-plan.js';
import type { InventorySqlPoint, InventorySqlRecord, InventorySqlSnapshotLine } from './model.js';

type QueryRow = Record<string, unknown>;
type SqlResult = { affectedRows?: number; insertId?: bigint | number | string };

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

async function lockInventoryRecord(connection: TransferSqlConnection, inventory: InventorySqlRecord): Promise<QueryRow> {
	let rows = await connection.query<QueryRow[]>(`
		SELECT id, last_state_hash,
			DATE_FORMAT(stock_snapshot_at, '%Y-%m-%d %H:%i:%s.%f') AS stock_snapshot_at
		FROM inventory_records
		WHERE bitrix_external_id = ?
		FOR UPDATE
	`, [inventory.bitrixExternalId]);
	if (rows.length > 1) throw new Error(`Inventory ${inventory.bitrixExternalId} identity is duplicated`);
	if (rows.length && storedTimestamp(rows[0]!['stock_snapshot_at'], 'inventory stock snapshot timestamp')
		&& storedTimestamp(rows[0]!['stock_snapshot_at'], 'inventory stock snapshot timestamp') !== inventory.stockSnapshotAt) {
		throw new Error(`Inventory ${inventory.bitrixExternalId} opening snapshot timestamp changed`);
	}
	await connection.query(`
		INSERT INTO inventory_records (
			bitrix_external_id, display_name, inventory_status, deadline, created_by_id,
			source_created_at, stock_snapshot_at, last_state_hash, deleted_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
		ON DUPLICATE KEY UPDATE
			display_name = VALUES(display_name), inventory_status = VALUES(inventory_status),
			deadline = VALUES(deadline), created_by_id = VALUES(created_by_id),
			source_created_at = VALUES(source_created_at), stock_snapshot_at = VALUES(stock_snapshot_at),
			deleted_at = NULL
	`, [
		inventory.bitrixExternalId, inventory.displayName, inventory.status, inventory.deadline,
		inventory.createdById, sqlDate(inventory.sourceCreatedAt), sqlDate(inventory.stockSnapshotAt),
	]);
	if (!rows.length) rows = await connection.query<QueryRow[]>(`
		SELECT id, last_state_hash,
			DATE_FORMAT(stock_snapshot_at, '%Y-%m-%d %H:%i:%s.%f') AS stock_snapshot_at
		FROM inventory_records
		WHERE bitrix_external_id = ?
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
			result_total, result_counted, result_discrepancies, is_present
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		ON DUPLICATE KEY UPDATE
			point_ordinal = VALUES(point_ordinal), store_name = VALUES(store_name), point_status = VALUES(point_status),
			responsible_id = VALUES(responsible_id), responsible_name = VALUES(responsible_name),
			started_at = VALUES(started_at), submitted_at = VALUES(submitted_at), act_at = VALUES(act_at),
			snapshot_version = VALUES(snapshot_version), snapshot_captured_at = VALUES(snapshot_captured_at),
			snapshot_migrated_at = VALUES(snapshot_migrated_at), draft_updated_at = VALUES(draft_updated_at),
			draft_updated_by_id = VALUES(draft_updated_by_id), draft_updated_by_name = VALUES(draft_updated_by_name),
			draft_session_id = VALUES(draft_session_id), draft_sequence = VALUES(draft_sequence),
			result_total = VALUES(result_total), result_counted = VALUES(result_counted),
			result_discrepancies = VALUES(result_discrepancies), is_present = 1
	`, [
		inventoryId, point.ordinal, point.storeId, point.storeName, point.status,
		point.responsibleId, point.responsibleName, sqlDate(point.startedAt), sqlDate(point.submittedAt), sqlDate(point.actAt),
		point.snapshotVersion, sqlDate(point.snapshotCapturedAt), sqlDate(point.snapshotMigratedAt),
		sqlDate(point.draftUpdatedAt), point.draftUpdatedById, point.draftUpdatedByName,
		point.draftSessionId, point.draftSequence,
		point.resultTotal, point.resultCounted, point.resultDiscrepancies,
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

async function writeInventory(connection: TransferSqlConnection, inventory: InventorySqlRecord): Promise<boolean> {
	const locked = await lockInventoryRecord(connection, inventory);
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

export async function applyInventorySqlBackfill(
	pool: TransferSqlPool,
	plan: InventorySqlBackfillPlan,
	expectedPlanHash: string,
): Promise<{ alreadyApplied: boolean; changedInventoryCount: number; unchangedInventoryCount: number }> {
	if (!plan.readyToApply || plan.issues.length) throw new Error('Inventory backfill plan is blocked');
	if (plan.planHash !== expectedPlanHash) throw new Error('Inventory backfill checkpoint does not match the approved plan');
	const connection = await pool.getConnection();
	let transaction = false;
	let locked = false;
	try {
		const lockRows = await connection.query<QueryRow[]>('SELECT GET_LOCK(?, 10) AS acquired', ['b24_app_inventory_backfill']);
		if (Number(lockRows[0]?.['acquired']) !== 1) throw new Error('Could not acquire inventory backfill lock');
		locked = true;
		await connection.beginTransaction();
		transaction = true;
		const existing = await connection.query<QueryRow[]>(`
			SELECT changed_inventory_count, unchanged_inventory_count
			FROM inventory_backfill_checkpoints
			WHERE plan_hash = ?
			FOR UPDATE
		`, [hashBuffer(plan.planHash)]);
		if (existing.length) {
			await connection.rollback();
			transaction = false;
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
		await connection.commit();
		transaction = false;
		return { alreadyApplied: false, changedInventoryCount, unchangedInventoryCount };
	} catch (error) {
		if (transaction) await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		if (locked) await connection.query('SELECT RELEASE_LOCK(?) AS released', ['b24_app_inventory_backfill']).catch(() => undefined);
		await connection.release();
	}
}
