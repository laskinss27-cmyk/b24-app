import {
	supplyMirrorDocumentIdentity,
	supplyMirrorLineIdentity,
} from './supply-backfill-plan.js';
import type {
	MirrorAllocationType,
	MirrorDocumentType,
	MirrorEvidenceKind,
	MirrorExternalSystem,
	MirrorRelationType,
	SupplyMirrorAllocationRow,
	SupplyMirrorDocumentRow,
	SupplyMirrorLineRow,
	SupplyMirrorLinkRow,
} from './supply-backfill-types.js';

type QueryRow = Record<string, unknown>;

export interface SupplyMirrorReadPool {
	query<T>(sql: string, values?: unknown[]): Promise<T>;
}

export interface StoredSupplyMirrorCheckpoint {
	planHash: string;
	observedAt: string;
	appliedAt: string;
	sourceRecords: {
		erpnext: number;
		bitrixTransfers: number;
		bitrixTransferRequests: number;
	};
	counts: {
		documents: number;
		lines: number;
		links: number;
		allocations: number;
		warnings: number;
	};
}

export interface StoredSupplyMirrorSnapshot {
	checkpoint: StoredSupplyMirrorCheckpoint;
	documents: SupplyMirrorDocumentRow[];
	lines: SupplyMirrorLineRow[];
	links: SupplyMirrorLinkRow[];
	allocations: SupplyMirrorAllocationRow[];
}

const EXTERNAL_SYSTEMS = ['erpnext', 'bitrix'] as const;
const DOCUMENT_TYPES = ['supply_request', 'purchase_order', 'purchase_receipt', 'transfer', 'stock_entry'] as const;
const RELATION_TYPES = [
	'ordered_for_request',
	'received_against_order',
	'received_for_request',
	'transfers_for_request',
	'transfers_for_purchase',
	'posts_transfer_ship',
	'posts_transfer_receive',
	'posts_transfer_correction',
	'corrects_transfer',
] as const;
const ALLOCATION_TYPES = ['ordered', 'received', 'transferred', 'fulfilled', 'cancelled'] as const;
const EVIDENCE_KINDS = ['explicit_external_field', 'native_erp_link', 'derived_match'] as const;

const CHECKPOINT_QUERY = `
	SELECT LOWER(HEX(plan_hash)) AS plan_hash,
		DATE_FORMAT(observed_at, '%Y-%m-%d %H:%i:%s.%f') AS observed_at,
		DATE_FORMAT(applied_at, '%Y-%m-%d %H:%i:%s.%f') AS applied_at,
		erpnext_records, bitrix_transfer_records, bitrix_transfer_request_records,
		document_count, line_count, link_count, allocation_count, warning_count
	FROM supply_mirror_checkpoints
	ORDER BY applied_at DESC, id DESC
	LIMIT 1
`;

const DOCUMENTS_QUERY = `
	SELECT external_system, document_type, external_id, external_revision_key,
		external_status, external_docstatus, bitrix_deal_id,
		DATE_FORMAT(source_created_at, '%Y-%m-%d %H:%i:%s.%f') AS source_created_at,
		DATE_FORMAT(source_modified_at, '%Y-%m-%d %H:%i:%s.%f') AS source_modified_at,
		DATE_FORMAT(observed_at, '%Y-%m-%d %H:%i:%s.%f') AS observed_at,
		LOWER(HEX(source_hash)) AS source_hash
	FROM workflow_documents
	WHERE observed_at = ?
`;

const LINES_QUERY = `
	SELECT d.external_system, d.document_type, d.external_id,
		l.external_line_key, l.line_ordinal, l.erp_item_code,
		l.planned_qty, l.request_qty, l.actual_qty,
		l.source_warehouse, l.target_warehouse,
		DATE_FORMAT(l.source_modified_at, '%Y-%m-%d %H:%i:%s.%f') AS source_modified_at,
		DATE_FORMAT(l.observed_at, '%Y-%m-%d %H:%i:%s.%f') AS observed_at,
		LOWER(HEX(l.source_hash)) AS source_hash
	FROM workflow_document_lines l
	JOIN workflow_documents d ON d.id = l.document_id
	WHERE l.observed_at = ?
`;

const LINKS_QUERY = `
	SELECT f.external_system AS from_external_system, f.document_type AS from_document_type,
		f.external_id AS from_external_id, t.external_system AS to_external_system,
		t.document_type AS to_document_type, t.external_id AS to_external_id,
		l.relation_type, l.evidence_kind, l.evidence_source,
		DATE_FORMAT(l.observed_at, '%Y-%m-%d %H:%i:%s.%f') AS observed_at,
		LOWER(HEX(l.source_hash)) AS source_hash
	FROM workflow_document_links l
	JOIN workflow_documents f ON f.id = l.from_document_id
	JOIN workflow_documents t ON t.id = l.to_document_id
	WHERE l.observed_at = ?
`;

const ALLOCATIONS_QUERY = `
	SELECT sd.external_system AS source_external_system, sd.document_type AS source_document_type,
		sd.external_id AS source_external_id, sl.external_line_key AS source_external_line_key,
		sl.line_ordinal AS source_line_ordinal, td.external_system AS target_external_system,
		td.document_type AS target_document_type, td.external_id AS target_external_id,
		tl.external_line_key AS target_external_line_key, tl.line_ordinal AS target_line_ordinal,
		a.allocation_type, a.quantity, a.evidence_kind, a.evidence_source,
		DATE_FORMAT(a.observed_at, '%Y-%m-%d %H:%i:%s.%f') AS observed_at,
		LOWER(HEX(a.source_hash)) AS source_hash
	FROM workflow_line_allocations a
	JOIN workflow_document_lines sl ON sl.id = a.source_line_id
	JOIN workflow_documents sd ON sd.id = sl.document_id
	JOIN workflow_document_lines tl ON tl.id = a.target_line_id
	JOIN workflow_documents td ON td.id = tl.document_id
	WHERE a.observed_at = ?
`;

function requiredString(row: QueryRow, field: string): string {
	const value = row[field];
	if (typeof value !== 'string' || !value.length) throw new Error(`Invalid SQL supply mirror field ${field}`);
	return value;
}

function nullableString(row: QueryRow, field: string): string | null {
	const value = row[field];
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') throw new Error(`Invalid SQL supply mirror field ${field}`);
	return value;
}

function requiredNumber(row: QueryRow, field: string, integer = false): number {
	const value = Number(row[field]);
	if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
		throw new Error(`Invalid SQL supply mirror field ${field}`);
	}
	return value;
}

function nullableNumber(row: QueryRow, field: string, integer = false): number | null {
	if (row[field] === null || row[field] === undefined) return null;
	return requiredNumber(row, field, integer);
}

function hash(row: QueryRow, field: string): string {
	const value = requiredString(row, field);
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid SQL supply mirror hash ${field}`);
	return value;
}

function oneOf<T extends string>(row: QueryRow, field: string, allowed: readonly T[]): T {
	const value = requiredString(row, field);
	if (!allowed.includes(value as T)) throw new Error(`Invalid SQL supply mirror field ${field}: ${value}`);
	return value as T;
}

function externalSystem(row: QueryRow, field = 'external_system'): MirrorExternalSystem {
	return oneOf(row, field, EXTERNAL_SYSTEMS);
}

function documentType(row: QueryRow, field = 'document_type'): MirrorDocumentType {
	return oneOf(row, field, DOCUMENT_TYPES);
}

function checkpoint(row: QueryRow): StoredSupplyMirrorCheckpoint {
	return {
		planHash: hash(row, 'plan_hash'),
		observedAt: requiredString(row, 'observed_at'),
		appliedAt: requiredString(row, 'applied_at'),
		sourceRecords: {
			erpnext: requiredNumber(row, 'erpnext_records', true),
			bitrixTransfers: requiredNumber(row, 'bitrix_transfer_records', true),
			bitrixTransferRequests: requiredNumber(row, 'bitrix_transfer_request_records', true),
		},
		counts: {
			documents: requiredNumber(row, 'document_count', true),
			lines: requiredNumber(row, 'line_count', true),
			links: requiredNumber(row, 'link_count', true),
			allocations: requiredNumber(row, 'allocation_count', true),
			warnings: requiredNumber(row, 'warning_count', true),
		},
	};
}

function documentRow(row: QueryRow): SupplyMirrorDocumentRow {
	const document = {
		externalSystem: externalSystem(row),
		documentType: documentType(row),
		externalId: requiredString(row, 'external_id'),
	};
	return {
		identity: supplyMirrorDocumentIdentity(document),
		...document,
		externalRevisionKey: nullableString(row, 'external_revision_key'),
		externalStatus: nullableString(row, 'external_status'),
		externalDocstatus: nullableNumber(row, 'external_docstatus', true),
		bitrixDealId: nullableNumber(row, 'bitrix_deal_id', true),
		sourceCreatedAt: nullableString(row, 'source_created_at'),
		sourceModifiedAt: nullableString(row, 'source_modified_at'),
		observedAt: requiredString(row, 'observed_at'),
		sourceHash: hash(row, 'source_hash'),
	};
}

function lineRow(row: QueryRow): SupplyMirrorLineRow {
	const document = {
		externalSystem: externalSystem(row),
		documentType: documentType(row),
		externalId: requiredString(row, 'external_id'),
	};
	const externalLineKey = nullableString(row, 'external_line_key');
	const lineOrdinal = requiredNumber(row, 'line_ordinal', true);
	return {
		identity: supplyMirrorLineIdentity({ document, externalLineKey, lineOrdinal }),
		documentIdentity: supplyMirrorDocumentIdentity(document),
		externalLineKey,
		lineOrdinal,
		erpItemCode: requiredString(row, 'erp_item_code'),
		plannedQty: nullableNumber(row, 'planned_qty'),
		requestQty: nullableNumber(row, 'request_qty'),
		actualQty: nullableNumber(row, 'actual_qty'),
		sourceWarehouse: nullableString(row, 'source_warehouse'),
		targetWarehouse: nullableString(row, 'target_warehouse'),
		sourceModifiedAt: nullableString(row, 'source_modified_at'),
		observedAt: requiredString(row, 'observed_at'),
		sourceHash: hash(row, 'source_hash'),
	};
}

function linkRow(row: QueryRow): SupplyMirrorLinkRow {
	const from = {
		externalSystem: externalSystem(row, 'from_external_system'),
		documentType: documentType(row, 'from_document_type'),
		externalId: requiredString(row, 'from_external_id'),
	};
	const to = {
		externalSystem: externalSystem(row, 'to_external_system'),
		documentType: documentType(row, 'to_document_type'),
		externalId: requiredString(row, 'to_external_id'),
	};
	const relationType = oneOf<MirrorRelationType>(row, 'relation_type', RELATION_TYPES);
	const fromDocumentIdentity = supplyMirrorDocumentIdentity(from);
	const toDocumentIdentity = supplyMirrorDocumentIdentity(to);
	return {
		identity: `${fromDocumentIdentity}->${toDocumentIdentity}:${relationType}`,
		fromDocumentIdentity,
		toDocumentIdentity,
		relationType,
		evidenceKind: oneOf<MirrorEvidenceKind>(row, 'evidence_kind', EVIDENCE_KINDS),
		evidenceSource: requiredString(row, 'evidence_source'),
		observedAt: requiredString(row, 'observed_at'),
		sourceHash: hash(row, 'source_hash'),
	};
}

function allocationRow(row: QueryRow): SupplyMirrorAllocationRow {
	const source = {
		document: {
			externalSystem: externalSystem(row, 'source_external_system'),
			documentType: documentType(row, 'source_document_type'),
			externalId: requiredString(row, 'source_external_id'),
		},
		externalLineKey: nullableString(row, 'source_external_line_key'),
		lineOrdinal: requiredNumber(row, 'source_line_ordinal', true),
	};
	const target = {
		document: {
			externalSystem: externalSystem(row, 'target_external_system'),
			documentType: documentType(row, 'target_document_type'),
			externalId: requiredString(row, 'target_external_id'),
		},
		externalLineKey: nullableString(row, 'target_external_line_key'),
		lineOrdinal: requiredNumber(row, 'target_line_ordinal', true),
	};
	const sourceLineIdentity = supplyMirrorLineIdentity(source);
	const targetLineIdentity = supplyMirrorLineIdentity(target);
	const allocationType = oneOf<MirrorAllocationType>(row, 'allocation_type', ALLOCATION_TYPES);
	return {
		identity: `${sourceLineIdentity}->${targetLineIdentity}:${allocationType}`,
		sourceLineIdentity,
		targetLineIdentity,
		allocationType,
		quantity: requiredNumber(row, 'quantity'),
		evidenceKind: oneOf<MirrorEvidenceKind>(row, 'evidence_kind', EVIDENCE_KINDS),
		evidenceSource: requiredString(row, 'evidence_source'),
		observedAt: requiredString(row, 'observed_at'),
		sourceHash: hash(row, 'source_hash'),
	};
}

function byIdentity<T extends { identity: string }>(rows: T[]): T[] {
	return rows.sort((left, right) => left.identity.localeCompare(right.identity, 'en'));
}

export async function readLatestSupplyMirrorSnapshot(pool: SupplyMirrorReadPool): Promise<StoredSupplyMirrorSnapshot | null> {
	const checkpoints = await pool.query<QueryRow[]>(CHECKPOINT_QUERY);
	if (!checkpoints.length) return null;
	if (checkpoints.length !== 1) throw new Error('Latest SQL supply mirror checkpoint query returned more than one row');
	const latest = checkpoint(checkpoints[0]!);
	const observedAt = [latest.observedAt];
	const [documents, lines, links, allocations] = await Promise.all([
		pool.query<QueryRow[]>(DOCUMENTS_QUERY, observedAt),
		pool.query<QueryRow[]>(LINES_QUERY, observedAt),
		pool.query<QueryRow[]>(LINKS_QUERY, observedAt),
		pool.query<QueryRow[]>(ALLOCATIONS_QUERY, observedAt),
	]);
	return {
		checkpoint: latest,
		documents: byIdentity(documents.map(documentRow)),
		lines: byIdentity(lines.map(lineRow)),
		links: byIdentity(links.map(linkRow)),
		allocations: byIdentity(allocations.map(allocationRow)),
	};
}
