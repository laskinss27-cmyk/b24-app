import type { DatabaseRuntime } from '../database/runtime.js';
import { buildInventorySqlBackfillPlan } from './backfill-plan.js';
import { compareInventorySqlParity } from './compare.js';
import type { InventorySqlErpDocument, InventorySqlPoint, InventorySqlRecord } from './model.js';

export type InventorySqlReadMode = 'off' | 'shadow' | 'verified';
export type InventorySqlReadShadowStatus = 'disabled' | 'match' | 'mismatch' | 'plan_blocked' | 'unavailable' | 'error';

export interface InventorySqlReadShadowReport {
	status: InventorySqlReadShadowStatus;
	legacyResponsePreserved: boolean;
	responseSource: 'bitrix' | 'sql';
	sourcePlanHash: string | null;
	bitrixCount: number;
	sqlCount: number | null;
	differences: string[];
	issues: string[];
}

export interface InventorySqlReadResolution {
	report: InventorySqlReadShadowReport;
	items: Record<string, unknown>[];
}

function optionalTimestamp(target: Record<string, unknown>, key: string, value: string | null): void {
	if (value) target[key] = value;
}

function erpDocumentData(document: InventorySqlErpDocument): Record<string, unknown> {
	const data: Record<string, unknown> = { name: document.name, status: document.status, lines: document.lineCount };
	optionalTimestamp(data, 'savedAt', document.savedAt);
	optionalTimestamp(data, 'submittedAt', document.submittedAt);
	return data;
}

function pointData(point: InventorySqlPoint): Record<string, unknown> {
	const draft: Record<string, number> = {};
	const comments: Record<string, string> = {};
	for (const line of point.countLines) {
		if (line.factQty != null) draft[String(line.productId)] = line.factQty;
		if (line.comment) comments[String(line.productId)] = line.comment;
	}
	const data: Record<string, unknown> = {
		storeId: point.storeId,
		storeName: point.storeName,
		status: point.status,
		responsibleId: point.responsibleId,
		responsibleName: point.responsibleName,
		draft,
		comments,
		draftSessionId: point.draftSessionId,
		draftSequence: point.draftSequence,
	};
	optionalTimestamp(data, 'startedAt', point.startedAt);
	optionalTimestamp(data, 'submittedAt', point.submittedAt);
	optionalTimestamp(data, 'actAt', point.actAt);
	optionalTimestamp(data, 'stockSnapshotMigratedAt', point.snapshotMigratedAt);
	optionalTimestamp(data, 'draftUpdatedAt', point.draftUpdatedAt);
	if (point.draftUpdatedById) data['draftUpdatedById'] = point.draftUpdatedById;
	if (point.draftUpdatedByName) data['draftUpdatedByName'] = point.draftUpdatedByName;
	if (point.snapshotVersion === 1) {
		data['stockSnapshot'] = {
			version: 1,
			capturedAt: point.snapshotCapturedAt,
			lines: point.snapshotLines.map((line) => [line.productId, line.bookQty]),
		};
	}
	if (point.resultTotal != null && point.resultCounted != null && point.resultDiscrepancies != null) {
		data['result'] = {
			total: point.resultTotal,
			counted: point.resultCounted,
			discrepancies: point.resultDiscrepancies,
			lines: point.resultLines.map((line) => ({
				productId: line.productId,
				name: line.productName,
				book: line.bookQty,
				fact: line.factQty,
				diff: line.differenceQty,
				...(line.comment ? { comment: line.comment } : {}),
			})),
		};
	}
	optionalTimestamp(data, 'resultBookAt', point.resultBookAt);
	const legacyDocument = point.erpDocuments.find((document) => document.kind === 'legacy_reconciliation');
	if (legacyDocument) data['erpDoc'] = erpDocumentData(legacyDocument);
	const splitDocuments = point.erpDocuments.filter((document) => document.kind === 'issue' || document.kind === 'receipt');
	if (splitDocuments.length) {
		data['erpDocs'] = Object.fromEntries(splitDocuments.map((document) => [document.kind, erpDocumentData(document)]));
	}
	return data;
}

export function inventorySqlRecordToBitrixItem(inventory: InventorySqlRecord): Record<string, unknown> {
	const detail: Record<string, unknown> = {
		status: inventory.status,
		createdById: inventory.createdById,
		sectionIds: [...inventory.sectionIds],
		points: inventory.points.map(pointData),
	};
	if (inventory.deadline) detail['deadline'] = inventory.deadline;
	optionalTimestamp(detail, 'createdAt', inventory.sourceCreatedAt);
	optionalTimestamp(detail, 'stockSnapshotAt', inventory.stockSnapshotAt);
	return {
		ID: String(inventory.bitrixExternalId),
		NAME: inventory.displayName,
		CREATED_BY: inventory.createdById,
		DATE_CREATE: inventory.sourceCreatedAt,
		DETAIL_TEXT: JSON.stringify(detail),
	};
}

function baseReport(bitrixCount: number): InventorySqlReadShadowReport {
	return {
		status: 'disabled',
		legacyResponsePreserved: true,
		responseSource: 'bitrix',
		sourcePlanHash: null,
		bitrixCount,
		sqlCount: null,
		differences: [],
		issues: [],
	};
}

export async function resolveInventorySqlRead(
	mode: InventorySqlReadMode,
	database: DatabaseRuntime | null | undefined,
	bitrixItems: Record<string, unknown>[],
	observedAt = new Date().toISOString(),
): Promise<InventorySqlReadResolution> {
	const base = baseReport(bitrixItems.length);
	if (mode === 'off') return { report: base, items: bitrixItems };
	if (!database || database.mode !== 'readiness' || !database.readInventoryRecords) {
		return { report: { ...base, status: 'unavailable' }, items: bitrixItems };
	}

	const plan = buildInventorySqlBackfillPlan({
		observedAt,
		sourceComplete: true,
		sourceRecordCount: bitrixItems.length,
		items: bitrixItems,
	});
	if (!plan.readyToApply) {
		return {
			report: {
				...base,
				status: 'plan_blocked',
				sourcePlanHash: plan.planHash,
				issues: plan.issues.map((issue) => `${issue.code}:${issue.identity}`),
			},
			items: bitrixItems,
		};
	}

	try {
		const stored = await database.readInventoryRecords();
		const parity = compareInventorySqlParity(plan.inventories, stored);
		const verified = mode === 'verified' && parity.matches;
		const storedByExternalId = new Map(stored.map((inventory) => [inventory.bitrixExternalId, inventory]));
		const sqlItems = verified
			? bitrixItems.map((item) => inventorySqlRecordToBitrixItem(storedByExternalId.get(Number(item['ID']))!))
			: bitrixItems;
		return {
			report: {
				...base,
				status: parity.matches ? 'match' : 'mismatch',
				legacyResponsePreserved: !verified,
				responseSource: verified ? 'sql' : 'bitrix',
				sourcePlanHash: plan.planHash,
				sqlCount: parity.storedCount,
				differences: parity.differences,
			},
			items: sqlItems,
		};
	} catch {
		return { report: { ...base, status: 'error', sourcePlanHash: plan.planHash }, items: bitrixItems };
	}
}

export async function observeInventorySqlReadShadow(
	mode: InventorySqlReadMode,
	database: DatabaseRuntime | null | undefined,
	bitrixItems: Record<string, unknown>[],
	observedAt = new Date().toISOString(),
): Promise<InventorySqlReadShadowReport> {
	return (await resolveInventorySqlRead(mode, database, bitrixItems, observedAt)).report;
}
