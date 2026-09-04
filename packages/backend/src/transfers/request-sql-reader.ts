import type { StoredTransferRequest, SupplyRequestLine } from './request-model.js';
import type { TransferLine } from './model.js';
import { transferRequestSqlStateHash } from './request-sql-store.js';
import type { TransferSqlPool } from './sql-store.js';

type QueryRow = Record<string, unknown>;

function text(row: QueryRow, field: string): string {
	const value = row[field];
	if (typeof value !== 'string') throw new Error(`Invalid SQL transfer request field ${field}`);
	return value;
}

function positiveInteger(row: QueryRow, field: string): number {
	const value = Number(row[field]);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid SQL transfer request field ${field}`);
	return value;
}

function nullableInteger(row: QueryRow, field: string): number | null {
	return row[field] == null ? null : positiveInteger(row, field);
}

function timestamp(row: QueryRow, field: string): string {
	const value = row[field];
	if (value == null || value === '') return '';
	const parsed = value instanceof Date ? value : new Date(String(value));
	if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid SQL transfer request timestamp ${field}`);
	return parsed.toISOString();
}

function hash(row: QueryRow, field: string): string {
	const value = row[field];
	if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error(`Invalid SQL transfer request hash ${field}`);
	return value.toString('hex');
}

export async function readCurrentSqlTransferRequests(pool: TransferSqlPool, publicId?: number): Promise<StoredTransferRequest[]> {
	const revisions = await pool.query<QueryRow[]>(`
		SELECT rr.public_id, rr.bitrix_external_id, rr.display_name, rr.last_state_hash,
			r.id AS revision_id, r.state_hash, r.request_kind, r.request_status,
			r.from_store, r.to_store, r.note, r.source_created_at,
			r.created_by_id, r.created_by_name, r.converted_at,
			r.converted_by_id, r.converted_by_name, r.transfer_public_id, r.task_id,
			r.canceled_at, r.canceled_by_id, r.canceled_by_name
		FROM stock_transfer_request_records rr
		JOIN stock_transfer_request_revisions r ON r.request_id = rr.id
			AND r.revision_no = (
				SELECT MAX(latest.revision_no)
				FROM stock_transfer_request_revisions latest
				WHERE latest.request_id = rr.id
			)
		WHERE rr.deleted_at IS NULL
		${publicId == null ? '' : 'AND rr.public_id = ?'}
		ORDER BY rr.public_id DESC
	`, publicId == null ? [] : [publicId]);
	if (!revisions.length) return [];
	const revisionIds = revisions.map((row) => row['revision_id']);
	const placeholders = revisionIds.map(() => '?').join(', ');
	const lineRows = await pool.query<QueryRow[]>(`
		SELECT revision_id, line_kind, line_ordinal, product_id, product_name,
			quantity, product_link, line_note
		FROM stock_transfer_request_revision_lines
		WHERE revision_id IN (${placeholders})
		ORDER BY revision_id, line_kind, line_ordinal
	`, revisionIds);
	const transferLines = new Map<string, TransferLine[]>();
	const supplyLines = new Map<string, SupplyRequestLine[]>();
	for (const row of lineRows) {
		const revisionId = String(row['revision_id']);
		const qty = Number(row['quantity']);
		if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid SQL transfer request quantity');
		if (text(row, 'line_kind') === 'transfer') {
			transferLines.set(revisionId, [...(transferLines.get(revisionId) ?? []), {
				productId: positiveInteger(row, 'product_id'),
				name: text(row, 'product_name'),
				qty,
			}]);
		} else {
			supplyLines.set(revisionId, [...(supplyLines.get(revisionId) ?? []), {
				productId: row['product_id'] == null ? null : positiveInteger(row, 'product_id'),
				name: text(row, 'product_name'),
				qty,
				link: text(row, 'product_link'),
				note: text(row, 'line_note'),
			}]);
		}
	}
	return revisions.map((row) => {
		const revisionId = String(row['revision_id']);
		const request: StoredTransferRequest = {
			id: positiveInteger(row, 'public_id'),
			name: text(row, 'display_name'),
			kind: text(row, 'request_kind') as StoredTransferRequest['kind'],
			fromStore: text(row, 'from_store'),
			toStore: text(row, 'to_store'),
			lines: transferLines.get(revisionId) ?? [],
			supplyLines: supplyLines.get(revisionId) ?? [],
			note: text(row, 'note'),
			status: text(row, 'request_status') as StoredTransferRequest['status'],
			createdAt: timestamp(row, 'source_created_at'),
			createdById: text(row, 'created_by_id'),
			createdByName: text(row, 'created_by_name'),
			convertedAt: timestamp(row, 'converted_at'),
			convertedById: text(row, 'converted_by_id'),
			convertedByName: text(row, 'converted_by_name'),
			transferId: nullableInteger(row, 'transfer_public_id'),
			taskId: nullableInteger(row, 'task_id'),
			canceledAt: timestamp(row, 'canceled_at'),
			canceledById: text(row, 'canceled_by_id'),
			canceledByName: text(row, 'canceled_by_name'),
		};
		const stateHash = hash(row, 'state_hash');
		if (hash(row, 'last_state_hash') !== stateHash) throw new Error(`SQL transfer request current hash mismatch for ${request.id}`);
		if (transferRequestSqlStateHash(request) !== stateHash) throw new Error(`SQL transfer request reconstruction hash mismatch for ${request.id}`);
		return request;
	});
}

export async function readCurrentSqlTransferRequest(pool: TransferSqlPool, externalId: number): Promise<StoredTransferRequest | null> {
	return (await readCurrentSqlTransferRequests(pool, externalId))[0] ?? null;
}
