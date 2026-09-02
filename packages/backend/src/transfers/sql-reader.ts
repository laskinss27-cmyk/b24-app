import type { StoredTransfer, TransferHistoryChange, TransferHistoryEvent, TransferLine } from './model.js';
import { transferSqlStateHash, type TransferSqlPool } from './sql-store.js';

type QueryRow = Record<string, unknown>;

const LATEST_REVISIONS_QUERY = `
	SELECT tr.bitrix_external_id, tr.display_name, tr.last_state_hash,
		r.id AS revision_id, r.revision_no, r.state_hash, r.supply_request,
		r.supply_request_key, r.purchase_order, r.deal_id, r.to_store,
		r.from_store, r.status, r.note, r.task_id, r.ship_entry,
		r.receive_entry, r.shortage_return_entry, r.correction_of_external_id,
		r.correction_kind, r.source_created_at, r.created_by_id, r.created_by_name
	FROM stock_transfer_records tr
	JOIN stock_transfer_revisions r ON r.transfer_id = tr.id
		AND r.revision_no = (
			SELECT MAX(latest.revision_no)
			FROM stock_transfer_revisions latest
			WHERE latest.transfer_id = tr.id
		)
	WHERE tr.deleted_at IS NULL
`;

function string(row: QueryRow, field: string): string {
	const value = row[field];
	if (typeof value !== 'string') throw new Error(`Invalid SQL transfer field ${field}`);
	return value;
}

function nullableString(row: QueryRow, field: string): string | null {
	const value = row[field];
	if (value == null) return null;
	return String(value);
}

function integer(row: QueryRow, field: string, allowZero = false): number {
	const value = Number(row[field]);
	if (!Number.isInteger(value) || (allowZero ? value < 0 : value <= 0)) throw new Error(`Invalid SQL transfer field ${field}`);
	return value;
}

function nullableInteger(row: QueryRow, field: string): number | null {
	if (row[field] == null) return null;
	return integer(row, field);
}

function timestamp(row: QueryRow, field: string): string {
	const value = row[field];
	if (value == null || value === '') return '';
	const date = value instanceof Date ? value : new Date(String(value));
	if (!Number.isFinite(date.getTime())) throw new Error(`Invalid SQL transfer timestamp ${field}`);
	return date.toISOString();
}

function hash(row: QueryRow, field: string): string {
	const value = row[field];
	if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error(`Invalid SQL transfer hash ${field}`);
	return value.toString('hex');
}

function placeholders(values: unknown[]): string {
	if (!values.length) throw new Error('SQL transfer reader requires revision ids');
	return values.map(() => '?').join(', ');
}

export async function readCurrentSqlTransfers(pool: TransferSqlPool, externalId?: number): Promise<StoredTransfer[]> {
	const revisions = await pool.query<QueryRow[]>(
		`${LATEST_REVISIONS_QUERY}${externalId == null ? '' : ' AND tr.bitrix_external_id = ?'} ORDER BY tr.bitrix_external_id`,
		externalId == null ? [] : [externalId],
	);
	if (!revisions.length) return [];
	const revisionIds = revisions.map((row) => row['revision_id']);
	const inList = placeholders(revisionIds);
	const [lineRows, historyRows, changeRows, correctionRows] = await Promise.all([
		pool.query<QueryRow[]>(`
			SELECT revision_id, phase, line_ordinal, product_id, product_name, quantity
			FROM stock_transfer_revision_lines
			WHERE revision_id IN (${inList})
			ORDER BY revision_id, phase, line_ordinal
		`, revisionIds),
		pool.query<QueryRow[]>(`
			SELECT revision_id, event_ordinal, event_at, status, actor_id, actor_name, action_name, note
			FROM stock_transfer_revision_history
			WHERE revision_id IN (${inList})
			ORDER BY revision_id, event_ordinal
		`, revisionIds),
		pool.query<QueryRow[]>(`
			SELECT revision_id, event_ordinal, change_ordinal, product_id, product_name, field_name, from_value, to_value
			FROM stock_transfer_history_changes
			WHERE revision_id IN (${inList})
			ORDER BY revision_id, event_ordinal, change_ordinal
		`, revisionIds),
		pool.query<QueryRow[]>(`
			SELECT revision_id, correction_ordinal, correction_external_id
			FROM stock_transfer_revision_corrections
			WHERE revision_id IN (${inList})
			ORDER BY revision_id, correction_ordinal
		`, revisionIds),
	]);
	const linesByRevisionPhase = new Map<string, TransferLine[]>();
	for (const row of lineRows) {
		const key = `${String(row['revision_id'])}:${string(row, 'phase')}`;
		const qty = Number(row['quantity']);
		if (!Number.isFinite(qty) || qty < 0) throw new Error('Invalid SQL transfer quantity');
		linesByRevisionPhase.set(key, [...(linesByRevisionPhase.get(key) ?? []), {
			productId: integer(row, 'product_id'),
			name: string(row, 'product_name'),
			qty,
		}]);
	}
	const changesByEvent = new Map<string, TransferHistoryChange[]>();
	for (const row of changeRows) {
		const key = `${String(row['revision_id'])}:${integer(row, 'event_ordinal')}`;
		const field = string(row, 'field_name') as TransferHistoryChange['field'];
		const rawFrom = string(row, 'from_value');
		const rawTo = string(row, 'to_value');
		const numberFrom = Number(rawFrom);
		const numberTo = Number(rawTo);
		changesByEvent.set(key, [...(changesByEvent.get(key) ?? []), {
			productId: integer(row, 'product_id', true),
			name: string(row, 'product_name'),
			field,
			from: field === 'destination' || !Number.isFinite(numberFrom) ? rawFrom : numberFrom,
			to: field === 'destination' || !Number.isFinite(numberTo) ? rawTo : numberTo,
		}]);
	}
	const historyByRevision = new Map<string, TransferHistoryEvent[]>();
	for (const row of historyRows) {
		const revisionId = String(row['revision_id']);
		const ordinal = integer(row, 'event_ordinal');
		const action = nullableString(row, 'action_name') as TransferHistoryEvent['action'];
		const actorName = string(row, 'actor_name');
		const note = string(row, 'note');
		const changes = changesByEvent.get(`${revisionId}:${ordinal}`) ?? [];
		const event: TransferHistoryEvent = {
			at: timestamp(row, 'event_at'),
			status: string(row, 'status') as TransferHistoryEvent['status'],
			byId: string(row, 'actor_id'),
			...(actorName ? { byName: actorName } : {}),
			...(action ? { action } : {}),
			...(note ? { note } : {}),
			...(changes.length ? { changes } : {}),
		};
		historyByRevision.set(revisionId, [...(historyByRevision.get(revisionId) ?? []), event]);
	}
	const correctionsByRevision = new Map<string, number[]>();
	for (const row of correctionRows) {
		const revisionId = String(row['revision_id']);
		correctionsByRevision.set(revisionId, [...(correctionsByRevision.get(revisionId) ?? []), integer(row, 'correction_external_id')]);
	}

	return revisions.map((row) => {
		const revisionId = String(row['revision_id']);
		const phase = (name: string): TransferLine[] => linesByRevisionPhase.get(`${revisionId}:${name}`) ?? [];
		const transfer: StoredTransfer = {
			id: integer(row, 'bitrix_external_id'),
			name: string(row, 'display_name'),
			supplyRequest: string(row, 'supply_request'),
			supplyRequestKey: string(row, 'supply_request_key'),
			purchaseOrder: string(row, 'purchase_order'),
			dealId: string(row, 'deal_id'),
			toStore: string(row, 'to_store'),
			fromStore: string(row, 'from_store'),
			status: string(row, 'status') as StoredTransfer['status'],
			lines: phase('planned'),
			collectedLines: phase('collected'),
			shippedLines: phase('shipped'),
			acceptedLines: phase('accepted'),
			note: string(row, 'note'),
			taskId: nullableInteger(row, 'task_id'),
			shipEntry: nullableString(row, 'ship_entry'),
			receiveEntry: nullableString(row, 'receive_entry'),
			receivedLines: phase('received'),
			shortageLines: phase('shortage'),
			shortageReturnEntry: nullableString(row, 'shortage_return_entry'),
			correctionOf: nullableInteger(row, 'correction_of_external_id'),
			correctionKind: nullableString(row, 'correction_kind') as StoredTransfer['correctionKind'],
			correctionIds: correctionsByRevision.get(revisionId) ?? [],
			createdAt: timestamp(row, 'source_created_at'),
			createdById: string(row, 'created_by_id'),
			createdByName: string(row, 'created_by_name'),
			history: historyByRevision.get(revisionId) ?? [],
		};
		const stateHash = hash(row, 'state_hash');
		if (hash(row, 'last_state_hash') !== stateHash) throw new Error(`SQL transfer current hash mismatch for ${transfer.id}`);
		if (transferSqlStateHash(transfer) !== stateHash) throw new Error(`SQL transfer reconstruction hash mismatch for ${transfer.id}`);
		return transfer;
	});
}

export async function readCurrentSqlTransfer(pool: TransferSqlPool, externalId: number): Promise<StoredTransfer | null> {
	const all = await readCurrentSqlTransfers(pool, externalId);
	return all[0] ?? null;
}
