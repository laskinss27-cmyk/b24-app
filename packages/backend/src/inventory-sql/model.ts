import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';

export type InventorySqlStatus = 'active' | 'closed';
export type InventoryPointSqlStatus = 'idle' | 'in_progress' | 'submitted' | 'act' | 'reconciled';
export type InventoryErpDocumentKind = 'legacy_reconciliation' | 'issue' | 'receipt';

export interface InventorySqlIssue {
	code: string;
	identity: string;
	message: string;
}

export interface InventorySqlSnapshotLine {
	productId: number;
	bookQty: number;
}

export interface InventorySqlCountLine {
	productId: number;
	factQty: number | null;
	comment: string;
}

export interface InventorySqlResultLine {
	ordinal: number;
	productId: number;
	productName: string;
	bookQty: number;
	factQty: number;
	differenceQty: number;
	comment: string;
}

export interface InventorySqlErpDocument {
	kind: InventoryErpDocumentKind;
	erpDoctype: 'Stock Reconciliation' | 'Stock Entry';
	name: string;
	status: 'draft' | 'submitted';
	lineCount: number;
	savedAt: string | null;
	submittedAt: string | null;
}

export interface InventorySqlPoint {
	ordinal: number;
	storeId: number;
	storeName: string;
	status: InventoryPointSqlStatus;
	responsibleId: string;
	responsibleName: string;
	startedAt: string | null;
	submittedAt: string | null;
	actAt: string | null;
	snapshotVersion: 1 | null;
	snapshotCapturedAt: string | null;
	snapshotMigratedAt: string | null;
	draftUpdatedAt: string | null;
	draftUpdatedById: string;
	draftUpdatedByName: string;
	draftSessionId: string;
	draftSequence: number;
	resultTotal: number | null;
	resultCounted: number | null;
	resultDiscrepancies: number | null;
	resultBookAt: string | null;
	snapshotLines: InventorySqlSnapshotLine[];
	countLines: InventorySqlCountLine[];
	resultLines: InventorySqlResultLine[];
	erpDocuments: InventorySqlErpDocument[];
}

export interface InventorySqlRecordState {
	bitrixExternalId: number;
	displayName: string;
	status: InventorySqlStatus;
	deadline: string | null;
	createdById: string;
	sourceCreatedAt: string | null;
	stockSnapshotAt: string | null;
	sectionIds: number[];
	points: InventorySqlPoint[];
}

export interface InventorySqlRecord extends InventorySqlRecordState {
	stateHash: string;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function issue(issues: InventorySqlIssue[], code: string, identity: string, message: string): void {
	issues.push({ code, identity, message });
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], identity: string, issues: InventorySqlIssue[]): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) issue(issues, 'unknown_field', `${identity}.${key}`, 'Source field has no normalized SQL destination');
	}
}

function limitedText(value: unknown, max: number, identity: string, issues: InventorySqlIssue[], required = false): string {
	const normalized = String(value ?? '').trim();
	if (required && !normalized) issue(issues, 'missing_text', identity, 'Required text is empty');
	if (normalized.length > max) issue(issues, 'text_too_long', identity, `Text exceeds ${max} characters`);
	return normalized.slice(0, max);
}

function timestamp(value: unknown, identity: string, issues: InventorySqlIssue[]): string | null {
	const source = String(value ?? '').trim();
	if (!source) return null;
	const parsed = new Date(source);
	if (!Number.isFinite(parsed.getTime())) {
		issue(issues, 'invalid_timestamp', identity, `Invalid timestamp: ${source}`);
		return null;
	}
	return parsed.toISOString();
}

function nonNegativeNumber(value: unknown, identity: string, issues: InventorySqlIssue[]): number | null {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		issue(issues, 'invalid_quantity', identity, `Expected a non-negative number: ${String(value)}`);
		return null;
	}
	return parsed;
}

function nonNegativeInteger(value: unknown, identity: string, issues: InventorySqlIssue[]): number | null {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		issue(issues, 'invalid_integer', identity, `Expected a non-negative integer: ${String(value)}`);
		return null;
	}
	return parsed;
}

function productId(value: unknown, identity: string, issues: InventorySqlIssue[]): number | null {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		issue(issues, 'invalid_product_id', identity, `Invalid product id: ${String(value)}`);
		return null;
	}
	return parsed;
}

function parseErpDocument(
	raw: unknown,
	kind: InventoryErpDocumentKind,
	identity: string,
	issues: InventorySqlIssue[],
): InventorySqlErpDocument | null {
	const value = record(raw);
	if (!value) {
		issue(issues, 'invalid_erp_document', identity, 'ERP document must be an object');
		return null;
	}
	unknownKeys(value, ['name', 'status', 'lines', 'savedAt', 'submittedAt'], identity, issues);
	const name = limitedText(value['name'], 191, `${identity}.name`, issues, true);
	const status = String(value['status'] ?? '');
	if (status !== 'draft' && status !== 'submitted') issue(issues, 'invalid_erp_document_status', identity, `Unsupported status: ${status}`);
	const lineCount = nonNegativeInteger(value['lines'] ?? 0, `${identity}.lines`, issues) ?? 0;
	const submittedAt = timestamp(value['submittedAt'], `${identity}.submittedAt`, issues);
	if (status === 'submitted' && !submittedAt) issue(issues, 'missing_submitted_at', identity, 'Submitted ERP document has no submittedAt');
	return {
		kind,
		erpDoctype: kind === 'legacy_reconciliation' ? 'Stock Reconciliation' : 'Stock Entry',
		name,
		status: status === 'submitted' ? 'submitted' : 'draft',
		lineCount,
		savedAt: timestamp(value['savedAt'], `${identity}.savedAt`, issues),
		submittedAt,
	};
}

function parsePoint(raw: unknown, ordinal: number, inventoryIdentity: string, issues: InventorySqlIssue[]): InventorySqlPoint | null {
	const identity = `${inventoryIdentity}.point:${ordinal}`;
	const value = record(raw);
	if (!value) {
		issue(issues, 'invalid_point', identity, 'Inventory point must be an object');
		return null;
	}
	unknownKeys(value, [
		'storeId', 'storeName', 'store', 'responsibleId', 'responsibleName', 'status', 'startedAt', 'submittedAt', 'actAt',
		'result', 'draft', 'comments', 'stockSnapshot', 'stockSnapshotMigratedAt', 'draftUpdatedAt', 'draftUpdatedById',
		'draftUpdatedByName', 'draftSessionId', 'draftSequence', 'resultBookAt', 'erpDoc', 'erpDocs',
	], identity, issues);
	const storeId = Number(value['storeId']);
	if (!Number.isSafeInteger(storeId) || storeId === 0) issue(issues, 'invalid_store_id', identity, `Invalid store id: ${String(value['storeId'])}`);
	const storeName = limitedText(value['storeName'] ?? value['store'], 191, `${identity}.storeName`, issues, true);
	const rawStatus = String(value['status'] ?? 'idle');
	const allowedStatuses: InventoryPointSqlStatus[] = ['idle', 'in_progress', 'submitted', 'act', 'reconciled'];
	if (!allowedStatuses.includes(rawStatus as InventoryPointSqlStatus)) issue(issues, 'invalid_point_status', identity, `Unsupported status: ${rawStatus}`);

	const snapshotLines: InventorySqlSnapshotLine[] = [];
	let snapshotVersion: 1 | null = null;
	let snapshotCapturedAt: string | null = null;
	const snapshot = value['stockSnapshot'] == null ? null : record(value['stockSnapshot']);
	if (value['stockSnapshot'] != null && !snapshot) issue(issues, 'invalid_snapshot', identity, 'stockSnapshot must be an object');
	if (snapshot) {
		unknownKeys(snapshot, ['version', 'capturedAt', 'lines'], `${identity}.snapshot`, issues);
		if (Number(snapshot['version']) !== 1) issue(issues, 'invalid_snapshot_version', identity, `Unsupported snapshot version: ${String(snapshot['version'])}`);
		else snapshotVersion = 1;
		snapshotCapturedAt = timestamp(snapshot['capturedAt'], `${identity}.snapshot.capturedAt`, issues);
		if (!snapshotCapturedAt) issue(issues, 'missing_snapshot_timestamp', identity, 'Frozen snapshot has no capturedAt');
		if (!Array.isArray(snapshot['lines'])) issue(issues, 'invalid_snapshot_lines', identity, 'Snapshot lines must be an array');
		else {
			const seen = new Set<number>();
			for (const [index, entry] of snapshot['lines'].entries()) {
				if (!Array.isArray(entry) || entry.length < 2) {
					issue(issues, 'invalid_snapshot_line', `${identity}.snapshot:${index + 1}`, 'Snapshot line must contain product and quantity');
					continue;
				}
				const id = productId(entry[0], `${identity}.snapshot:${index + 1}`, issues);
				const qty = nonNegativeNumber(entry[1], `${identity}.snapshot:${index + 1}`, issues);
				if (id == null || qty == null) continue;
				if (seen.has(id)) issue(issues, 'duplicate_snapshot_product', `${identity}.product:${id}`, 'Snapshot product is duplicated');
				seen.add(id);
				snapshotLines.push({ productId: id, bookQty: qty });
			}
		}
	}
	snapshotLines.sort((left, right) => left.productId - right.productId);

	const draft = value['draft'] == null ? {} : record(value['draft']);
	const comments = value['comments'] == null ? {} : record(value['comments']);
	if (!draft) issue(issues, 'invalid_draft', identity, 'Draft must be an object');
	if (!comments) issue(issues, 'invalid_comments', identity, 'Comments must be an object');
	const draftRecord = draft ?? {};
	const commentRecord = comments ?? {};
	const countProductKeys = [...new Set([...Object.keys(draftRecord), ...Object.keys(commentRecord)])];
	const countLines: InventorySqlCountLine[] = [];
	for (const key of countProductKeys) {
		const id = productId(key, `${identity}.count:${key}`, issues);
		if (id == null) continue;
		const factQty = Object.hasOwn(draftRecord, key)
			? nonNegativeNumber(draftRecord[key], `${identity}.count:${key}`, issues)
			: null;
		const comment = limitedText(commentRecord[key], 500, `${identity}.comment:${key}`, issues);
		if (factQty == null && !comment) continue;
		countLines.push({ productId: id, factQty, comment });
	}
	countLines.sort((left, right) => left.productId - right.productId);

	let resultTotal: number | null = null;
	let resultCounted: number | null = null;
	let resultDiscrepancies: number | null = null;
	const resultLines: InventorySqlResultLine[] = [];
	if (value['result'] != null) {
		const result = record(value['result']);
		if (!result) issue(issues, 'invalid_result', identity, 'Result must be an object');
		else {
			unknownKeys(result, ['total', 'counted', 'discrepancies', 'lines'], `${identity}.result`, issues);
			resultTotal = nonNegativeInteger(result['total'], `${identity}.result.total`, issues);
			resultCounted = nonNegativeInteger(result['counted'], `${identity}.result.counted`, issues);
			resultDiscrepancies = nonNegativeInteger(result['discrepancies'], `${identity}.result.discrepancies`, issues);
			if (resultTotal != null && resultCounted != null && resultCounted > resultTotal) issue(issues, 'invalid_result_totals', identity, 'Counted exceeds total');
			if (!Array.isArray(result['lines'])) issue(issues, 'invalid_result_lines', identity, 'Result lines must be an array');
			else {
				const seen = new Set<number>();
				for (const [index, rawLine] of result['lines'].entries()) {
					const lineIdentity = `${identity}.result:${index + 1}`;
					const line = record(rawLine);
					if (!line) { issue(issues, 'invalid_result_line', lineIdentity, 'Result line must be an object'); continue; }
					unknownKeys(line, ['productId', 'name', 'book', 'fact', 'diff', 'comment'], lineIdentity, issues);
					const id = productId(line['productId'], lineIdentity, issues);
					const bookQty = nonNegativeNumber(line['book'], `${lineIdentity}.book`, issues);
					const factQty = nonNegativeNumber(line['fact'], `${lineIdentity}.fact`, issues);
					const differenceQty = Number(line['diff']);
					if (id == null || bookQty == null || factQty == null) continue;
					if (!Number.isFinite(differenceQty) || Math.abs((factQty - bookQty) - differenceQty) >= 1e-9 || Math.abs(differenceQty) < 1e-9) {
						issue(issues, 'invalid_result_difference', lineIdentity, 'Result difference does not equal fact minus book');
						continue;
					}
					if (seen.has(id)) issue(issues, 'duplicate_result_product', `${identity}.product:${id}`, 'Result product is duplicated');
					seen.add(id);
					resultLines.push({
						ordinal: index + 1,
						productId: id,
						productName: limitedText(line['name'], 500, `${lineIdentity}.name`, issues, true),
						bookQty,
						factQty,
						differenceQty,
						comment: limitedText(line['comment'], 500, `${lineIdentity}.comment`, issues),
					});
				}
			}
			if (resultDiscrepancies != null && resultDiscrepancies !== resultLines.length) {
				issue(issues, 'result_count_mismatch', identity, 'Result discrepancy count differs from normalized result lines');
			}
		}
	}

	const erpDocuments: InventorySqlErpDocument[] = [];
	if (value['erpDoc'] != null) {
		const document = parseErpDocument(value['erpDoc'], 'legacy_reconciliation', `${identity}.erpDoc`, issues);
		if (document) erpDocuments.push(document);
	}
	if (value['erpDocs'] != null) {
		const documents = record(value['erpDocs']);
		if (!documents) issue(issues, 'invalid_erp_documents', identity, 'erpDocs must be an object');
		else {
			unknownKeys(documents, ['issue', 'receipt'], `${identity}.erpDocs`, issues);
			for (const kind of ['issue', 'receipt'] as const) {
				if (documents[kind] == null) continue;
				const document = parseErpDocument(documents[kind], kind, `${identity}.erpDocs.${kind}`, issues);
				if (document) erpDocuments.push(document);
			}
		}
	}
	if (erpDocuments.some((document) => document.kind === 'legacy_reconciliation') && erpDocuments.length > 1) {
		issue(issues, 'mixed_erp_document_models', identity, 'Legacy reconciliation and split adjustment documents coexist');
	}

	return {
		ordinal,
		storeId: Number.isSafeInteger(storeId) && storeId !== 0 ? storeId : -1,
		storeName,
		status: allowedStatuses.includes(rawStatus as InventoryPointSqlStatus) ? rawStatus as InventoryPointSqlStatus : 'idle',
		responsibleId: limitedText(value['responsibleId'], 191, `${identity}.responsibleId`, issues),
		responsibleName: limitedText(value['responsibleName'], 255, `${identity}.responsibleName`, issues),
		startedAt: timestamp(value['startedAt'], `${identity}.startedAt`, issues),
		submittedAt: timestamp(value['submittedAt'], `${identity}.submittedAt`, issues),
		actAt: timestamp(value['actAt'], `${identity}.actAt`, issues),
		snapshotVersion,
		snapshotCapturedAt,
		snapshotMigratedAt: timestamp(value['stockSnapshotMigratedAt'], `${identity}.stockSnapshotMigratedAt`, issues),
		draftUpdatedAt: timestamp(value['draftUpdatedAt'], `${identity}.draftUpdatedAt`, issues),
		draftUpdatedById: limitedText(value['draftUpdatedById'], 191, `${identity}.draftUpdatedById`, issues),
		draftUpdatedByName: limitedText(value['draftUpdatedByName'], 255, `${identity}.draftUpdatedByName`, issues),
		draftSessionId: limitedText(value['draftSessionId'], 80, `${identity}.draftSessionId`, issues),
		draftSequence: nonNegativeInteger(value['draftSequence'] ?? 0, `${identity}.draftSequence`, issues) ?? 0,
		resultTotal,
		resultCounted,
		resultDiscrepancies,
		resultBookAt: timestamp(value['resultBookAt'], `${identity}.resultBookAt`, issues),
		snapshotLines,
		countLines,
		resultLines,
		erpDocuments,
	};
}

export function inventorySqlStateHash(state: InventorySqlRecordState): string {
	return createHash('sha256').update(supplyMirrorCanonicalJson(state)).digest('hex');
}

export function parseInventoryBitrixItem(item: Record<string, unknown>): { inventory: InventorySqlRecord | null; issues: InventorySqlIssue[] } {
	const issues: InventorySqlIssue[] = [];
	const bitrixExternalId = Number(item['ID']);
	const identity = `ctv_inv:${String(item['ID'] ?? '')}`;
	if (!Number.isSafeInteger(bitrixExternalId) || bitrixExternalId <= 0) issue(issues, 'invalid_external_id', identity, 'Bitrix inventory id must be positive');
	const displayName = limitedText(item['NAME'], 255, `${identity}.NAME`, issues, true);
	let data: Record<string, unknown> | null = null;
	try { data = record(item['DETAIL_TEXT'] ? JSON.parse(String(item['DETAIL_TEXT'])) : {}); }
	catch { issue(issues, 'invalid_json', identity, 'DETAIL_TEXT contains invalid JSON'); }
	if (!data) {
		issue(issues, 'invalid_payload', identity, 'DETAIL_TEXT must contain an object');
		return { inventory: null, issues };
	}
	unknownKeys(data, ['status', 'deadline', 'points', 'createdById', 'createdAt', 'stockSnapshotAt', 'sectionIds'], identity, issues);
	const rawStatus = String(data['status'] ?? 'active');
	if (rawStatus !== 'active' && rawStatus !== 'closed') issue(issues, 'invalid_inventory_status', identity, `Unsupported status: ${rawStatus}`);
	const deadlineSource = String(data['deadline'] ?? '').trim();
	const deadline = deadlineSource || null;
	if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) issue(issues, 'invalid_deadline', identity, `Invalid deadline: ${deadline}`);
	const rawSections = data['sectionIds'] == null ? [] : data['sectionIds'];
	const sectionIds: number[] = [];
	if (!Array.isArray(rawSections)) issue(issues, 'invalid_sections', identity, 'sectionIds must be an array');
	else {
		const seen = new Set<number>();
		for (const [index, rawSectionId] of rawSections.entries()) {
			const sectionId = Number(rawSectionId);
			if (!Number.isSafeInteger(sectionId) || sectionId < 0) { issue(issues, 'invalid_section_id', `${identity}.section:${index + 1}`, 'Section id must be non-negative'); continue; }
			if (seen.has(sectionId)) issue(issues, 'duplicate_section_id', `${identity}.section:${sectionId}`, 'Section id is duplicated');
			seen.add(sectionId);
			sectionIds.push(sectionId);
		}
	}
	const points: InventorySqlPoint[] = [];
	if (!Array.isArray(data['points']) || !data['points'].length) issue(issues, 'invalid_points', identity, 'Inventory must contain at least one point');
	else {
		for (const [index, rawPoint] of data['points'].entries()) {
			const point = parsePoint(rawPoint, index + 1, identity, issues);
			if (point) points.push(point);
		}
	}
	const storeIds = new Set<number>();
	for (const point of points) {
		if (storeIds.has(point.storeId)) issue(issues, 'duplicate_store_id', `${identity}.store:${point.storeId}`, 'Inventory store is duplicated');
		storeIds.add(point.storeId);
	}
	const state: InventorySqlRecordState = {
		bitrixExternalId: Number.isSafeInteger(bitrixExternalId) && bitrixExternalId > 0 ? bitrixExternalId : 1,
		displayName,
		status: rawStatus === 'closed' ? 'closed' : 'active',
		deadline: deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null,
		createdById: limitedText(data['createdById'] ?? item['CREATED_BY'], 191, `${identity}.createdById`, issues),
		sourceCreatedAt: timestamp(data['createdAt'] ?? item['DATE_CREATE'], `${identity}.createdAt`, issues),
		stockSnapshotAt: timestamp(data['stockSnapshotAt'], `${identity}.stockSnapshotAt`, issues),
		sectionIds,
		points,
	};
	issues.sort((left, right) => `${left.code}:${left.identity}`.localeCompare(`${right.code}:${right.identity}`, 'en'));
	return { inventory: { ...state, stateHash: inventorySqlStateHash(state) }, issues };
}
